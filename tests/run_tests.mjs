/**
 * 一键回归：node tests/run_tests.mjs（退出码 0 = PASS）
 * stdout 只有「一行结论 + 计数 + 前 10 条失败」；超过 10 条才把完整清单写到 <工作区>/temp/。
 *
 * 不启动 DSH、不联网、不写盘：把 lib/client.js 放进 node:vm 沙箱（伪造 window.__ModuleLoader__），
 * 拿到插件模块与它暴露的纯函数，在「纯函数 / 模块形状 / 组件渲染」三层做断言。
 * 组件层用最小假 React（只 createElement）——本组件不用 hooks，状态在模块级。
 *
 * 覆盖的教训（每条都对应真机踩过的坑）：
 *   1) 节点必须走 `useChat`（本机 `useSession` 返回空数组）；
 *   2) 选择器空结果必须是**稳定引用**，否则 React 无限重渲染 → 界面卡死；
 *   3) 每轮用量在 assistant 节点的 **`node.usage`** 上，且要按该轮所有节点求和；
 *   4) "每条回复 × 全部节点"的重算会拖死界面 → 按节点快照建表复用；
 *   5) 不搬 DOM（因此这里没有任何 DOM 相关断言，只有纯函数与渲染形状）。
 * 金额断言一律**显式传时刻**：节点路径传"该轮的时刻"（node.time），只有兜底路径才用 Date.now()。
 *   6) 计价要按**该轮发生时刻**选「生效档 + 峰谷档 + 节假日」，不能按"现在"（否则历史轮全错）；
 *   7) 价目表未收录 / 该时刻没有生效行 → 不显示，绝不按 0 计。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as host from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const WORKSPACE = join(HERE, '..', '..', '..')

let pass = 0
const fails = []
const ok = (name, cond, detail) => cond ? pass++ : fails.push(name + (detail ? ' — ' + detail : ''))
const eq = (name, actual, expected) => ok(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
const near = (name, actual, expected, eps = 1e-9) => ok(name, Math.abs(actual - expected) < eps, `expected ~${expected}, got ${actual}`)

// ── 载入 client.js（沙箱） ────────────────────────────────────────────────
let captured = null
const sandbox = { window: { __ModuleLoader__: { load: (m) => { captured = m } } } }
createContext(sandbox)
runInContext(readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'), sandbox)

const pure = sandbox.__dshTurnCostPure
ok('暴露纯函数区', pure !== null && pure !== undefined)
eq('模块注册 id', captured && captured.id, 'dsh-turn-usage')

const stubReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  // 组件现在用到 React hooks（搜索记录订阅）；直接调用时给最小实现即可
  useState: (init) => [typeof init === 'function' ? init() : init, () => { }],
  useEffect: (fn) => { try { fn() } catch (e) { } },
}
function setup(config) {
  const mod = captured.factory((id) => {
    if (id === 'react') return stubReact
    throw new Error('unexpected require: ' + id)
  })
  const reg = { channels: {} }
  const MAIN_SLOT = 'conversation.chat.assistant-actions'
  const ctx = {
    slots: {
      inject: (channel, fn) => { if (channel === MAIN_SLOT) reg.channel = channel; fn() },
      register: (opts, Comp) => {
        reg.channels[opts.name] = { opts, Comp }
        // 老断言的语义保持不动：reg.Comp 始终是"每条回复那一行"的组件
        if (opts.name === MAIN_SLOT) { reg.channel = opts.name; reg.opts = opts; reg.Comp = Comp }
        return opts
      },
    },
  }
  mod.apply(ctx, config)
  return { mod, reg }
}

const base = setup(undefined)
eq('导出 name', base.mod.name, 'dsh-turn-usage')
ok('inject 含 slots', Array.isArray(base.mod.inject) && base.mod.inject.indexOf('slots') !== -1)
eq('注册到每条回复的操作行槽位', base.reg.channel, 'conversation.chat.assistant-actions')
eq('槽位 id', base.reg.opts.id, 'dsh-turn-usage')
ok('order 是正数（只在本槽位内部排序）', base.reg.opts.order > 0, 'order=' + base.reg.opts.order)
ok('组件是函数', typeof base.reg.Comp === 'function')

// ── 峰谷 ────────────────────────────────────────────────────────────────
const OFF = Date.UTC(2026, 8, 21, 0, 30)      // 周一 08:30 北京
const PEAK = Date.UTC(2026, 8, 21, 2, 0)      // 周一 10:00 北京
const WEEKEND = Date.UTC(2026, 8, 19, 2, 0)   // 周六 10:00 北京
const EDGE_12 = Date.UTC(2026, 8, 21, 4, 0)   // 周一 12:00（窗口半开 → 空闲）
const EDGE_14 = Date.UTC(2026, 8, 21, 6, 0)   // 周一 14:00（窗口起点 → 高峰）

eq('工作日 08:30 非高峰', pure.isPeak(OFF), false)
eq('工作日 10:00 是高峰', pure.isPeak(PEAK), true)
eq('周末 10:00 非高峰', pure.isPeak(WEEKEND), false)
eq('12:00 边界算空闲', pure.isPeak(EDGE_12), false)
eq('14:00 边界算高峰', pure.isPeak(EDGE_14), true)

// ── 节假日（北京时间日期；表有效期 2026 全年） ─────────────────────────
const NAT_DAY = Date.UTC(2026, 9, 1, 2, 0)      // 2026-10-01 周四 10:00 北京 —— 国庆
const MID_AUTUMN = Date.UTC(2026, 8, 25, 2, 0)  // 2026-09-25 周五 10:00 北京 —— 中秋
const MAKEUP = Date.UTC(2026, 9, 10, 2, 0)      // 2026-10-10 周六 10:00 北京 —— 国庆调休上班
const OUT_OF_RANGE = Date.UTC(2027, 0, 1, 2, 0) // 2027-01-01 周五 10:00 北京 —— 表有效期外

eq('工作日 10:00 是高峰（对照组）', pure.isPeak(Date.UTC(2026, 8, 24, 2, 0)), true)
eq('法定节假日 10:00 不收高峰（国庆）', pure.isPeak(NAT_DAY), false)
eq('法定节假日 10:00 不收高峰（中秋）', pure.isPeak(MID_AUTUMN), false)
eq('节假日名认得出', pure.holidayName(NAT_DAY), '国庆节')
eq('调休上班日仍按普通周末算（官方不认调休）', pure.isPeak(MAKEUP), false)
eq('超出有效期 → 回落成工作日判定', pure.isPeak(OUT_OF_RANGE), true)
eq('超出有效期 → 不认节日', pure.holidayName(OUT_OF_RANGE), null)
eq('北京日期键按 UTC+8 切日', pure.bjDateKey(Date.UTC(2026, 9, 1, 2, 0)), '2026-10-01')

// ── 模型 id 归一 ────────────────────────────────────────────────────────
eq('短 id 命中', pure.resolveKey('deepseek-flash'), 'deepseek-flash')
eq('前缀命中', pure.resolveKey('deepseek-v4-flash-2026-01'), 'deepseek-v4-flash')
eq('相似但非本型号 → 不认', pure.resolveKey('deepseek-v99'), null)
eq('空 id → 不认', pure.resolveKey(''), null)

// ── 计价 ────────────────────────────────────────────────────────────────
const M = { uncachedInputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6, cacheWriteTokens: 0 }
near('flash 空闲 = ¥5.02', pure.costOf(M, 'deepseek-flash', OFF).cny, 5.02)
near('flash 高峰 = ¥10.04（2×）', pure.costOf(M, 'deepseek-flash', PEAK).cny, 10.04)
near('pro 空闲 = ¥18.15', pure.costOf(M, 'deepseek-v4-pro', OFF).cny, 18.15)
near('缓存写入按未命中输入价', pure.costOf({ cacheWriteTokens: 1e6 }, 'deepseek-flash', OFF).cny, 1)
eq('未收录模型返回 null（不按 0 计）', pure.costOf(M, 'gpt-4o', OFF), null)

// ── 生效起止：按「该轮发生时刻」选档 ────────────────────────────────────
eq('北京时间串 → UTC 毫秒', pure.bjToMs('2026-09-14 12:00'), Date.UTC(2026, 8, 14, 4, 0))
eq('只给日期 = 当天 00:00 北京', pure.bjToMs('2026-01-01'), Date.UTC(2025, 11, 31, 16, 0))
eq('非法串 → null', pure.bjToMs('2026/01/01'), null)
const BEFORE_SWITCH = Date.UTC(2026, 8, 14, 0, 0)   // 2026-09-14 周一 08:00 北京
const AT_SWITCH = Date.UTC(2026, 8, 14, 4, 0)       // 2026-09-14 周一 12:00 北京（切换点）
const AFTER_SWITCH = Date.UTC(2026, 8, 14, 5, 0)    // 2026-09-14 周一 13:00 北京
near('现行表：v4-pro 是独立原价（没被并入 flash）', pure.costOf(M, 'deepseek-v4-pro', BEFORE_SWITCH).cny, 18.15)
near('现行表：任意时刻都命中原价行', pure.costOf(M, 'deepseek-v4-pro', Date.UTC(2030, 0, 1)).cny, 18.15)

const savedRows = pure.PRICES.length
pure.PRICES.push({
  models: ['deepseek-v4-pro'], from: '2026-09-14 12:00', to: null,
  off: { miss: 1, hit: 0.02, out: 4 }, peak: { miss: 2, hit: 0.04, out: 8 }, note: '测试用-改价'
})
near('切换点之前：仍按老行的价', pure.costOf(M, 'deepseek-v4-pro', BEFORE_SWITCH).cny, 18.15)
near('切换点整：新行生效（含起）', pure.costOf(M, 'deepseek-v4-pro', AT_SWITCH).cny, 5.02)
near('切换之后：按新行', pure.costOf(M, 'deepseek-v4-pro', AFTER_SWITCH).cny, 5.02)
eq('同一模型多行命中 → 后出现的胜出', pure.resolveRow('deepseek-v4-pro', AFTER_SWITCH).note, '测试用-改价')
pure.PRICES.length = savedRows
near('撤掉测试行 → 回到原价', pure.costOf(M, 'deepseek-v4-pro', AFTER_SWITCH).cny, 18.15)

pure.PRICES.push({
  models: ['deepseek-v4-pro'], from: '2026-09-01 00:00', to: '2026-09-14 12:00',
  off: { miss: 9, hit: 0.3, out: 27 }, peak: { miss: 18, hit: 0.6, out: 54 }, note: '测试用-有止'
})
near('有 to 的行：止点前生效', pure.costOf(M, 'deepseek-v4-pro', BEFORE_SWITCH).cny, 36.3)
near('止点不含：12:00 起该行失效', pure.costOf(M, 'deepseek-v4-pro', AT_SWITCH).cny, 18.15)
pure.PRICES.length = savedRows
eq('测试行已全部撤掉', pure.PRICES.length, savedRows)

// ── usage 归一（真机字段名 + 常见别名） ────────────────────────────────
const b0 = pure.bucketize({ uncachedInputTokens: 1000, outputTokens: 300, cacheReadTokens: 2000, cacheWriteTokens: 0 })
eq('标准字段名 · 未命中', b0.uncachedInputTokens, 1000)
eq('标准字段名 · 缓存命中', b0.cacheReadTokens, 2000)
const bAlias = pure.bucketize({ inputTokens: 5, cachedInputTokens: 7, completionTokens: 3 })
ok('别名也认', bAlias.uncachedInputTokens === 5 && bAlias.cacheReadTokens === 7 && bAlias.outputTokens === 3, JSON.stringify(bAlias))
eq('非对象 → null', pure.bucketize(null), null)

// ── 本轮折叠（兜底路径） ───────────────────────────────────────────────
const b1 = { uncachedInputTokens: 1000, cacheReadTokens: 2000, outputTokens: 300, cacheWriteTokens: 0 }
const st = { turn: null, steps: {} }
pure.accumulate(st, { turn: 3, step: 1, buckets: b1 })
pure.accumulate(st, { turn: 3, step: 2, buckets: b1 })
near('同轮两步求和', pure.sumSteps(st.steps).cacheReadTokens, 4000)
pure.accumulate(st, { turn: 3, step: 2, buckets: b1 })
near('同一步重复渲染不重复计（幂等）', pure.sumSteps(st.steps).cacheReadTokens, 4000)
pure.accumulate(st, { turn: 4, step: 1, buckets: b1 })
near('换轮后重置', pure.sumSteps(st.steps).cacheReadTokens, 2000)

// ── 节点读取（真机形状：assistant 节点带 node.usage） ──────────────────
const nodesWithUsage = [
  { kind: 'assistant', seq: 10, messageId: 'm1', time: 1, turn: 1, step: 1, blocks: [],
    usage: { uncachedInputTokens: 1000, outputTokens: 300, cacheReadTokens: 2000 }, timing: {} },
  { kind: 'tool-result', seq: 11, turn: 1 },
  { kind: 'assistant', seq: 12, messageId: 'm1b', time: 2, turn: 1, step: 2, blocks: [],
    usage: { uncachedInputTokens: 500, outputTokens: 100, cacheReadTokens: 1000 }, timing: {} },
  { kind: 'assistant', seq: 20, messageId: 'm2', time: 3, turn: 2, step: 1, blocks: [],
    usage: { uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 0,
      totalTokens: 3e6, routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }] }, timing: {} },
]
const assistantNodes = [
  { kind: 'assistant', messageId: 'm1', turn: 1, provenance: { model: 'deepseek-flash' } },
  { kind: 'assistant', messageId: 'm2', turn: 2, requestConfig: { model: 'deepseek-v4-pro' } },
]

eq('chat store 形状：s.legacy.nodes', pure.nodesFromChat({ legacy: { nodes: assistantNodes } }).length, 2)
eq('chat store 没节点 → null', pure.nodesFromChat({ legacy: { nodes: [] } }), null)
eq('session store 形状：s.chat.legacy.nodes', pure.nodesFromSession({ chat: { legacy: { nodes: assistantNodes } } }).length, 2)
eq('session store 都没有 → 空数组', pure.nodesFromSession({}).length, 0)

// 回归锁：选择器空结果必须稳定（真机表现：发消息卡死、越长越久）
ok('nodesFromSession 空结果引用稳定', pure.nodesFromSession({}) === pure.nodesFromSession({}))
ok('nodesFromSession 空结果不是新建数组', pure.nodesFromSession({}) !== [])
ok('nodesFromChat 空结果稳定为 null', pure.nodesFromChat({}) === null && pure.nodesFromChat({ legacy: {} }) === null)
ok('有节点时返回原数组（引用稳定）', pure.nodesFromChat({ legacy: { nodes: assistantNodes } }) === assistantNodes)

eq('该轮多步求和 · 未命中输入', pure.sumUsageForTurn(nodesWithUsage, 1).uncachedInputTokens, 1500)
eq('该轮多步求和 · 缓存命中', pure.sumUsageForTurn(nodesWithUsage, 1).cacheReadTokens, 3000)
eq('该轮无样本 → null', pure.sumUsageForTurn(nodesWithUsage, 99), null)
eq('modelForTurn：只认该轮的模型', pure.modelForTurn(nodesWithUsage, 2), 'deepseek-v4-pro')
eq('modelForTurn：该轮没有模型信息 → null', pure.modelForTurn(nodesWithUsage, 1), null)
eq('modelFromUsage：取 routes 里的模型', pure.modelFromUsage(nodesWithUsage[3].usage), 'deepseek-v4-pro')

// ── 快照表（性能关键） ─────────────────────────────────────────────────
pure.resetState()
const t1 = pure.snapshotTable(nodesWithUsage)
eq('表：该轮汇总（多步）', t1.byTurn.get(1).buckets.uncachedInputTokens, 1500)
eq('表：该轮模型', t1.byTurn.get(2).model, 'deepseek-v4-pro')
eq('表：messageId → 节点', t1.byMessage.get('m1').turn, 1)
ok('表：同一数组复用同一张表（不重复遍历）', pure.snapshotTable(nodesWithUsage) === t1)
ok('表：换一个数组引用就重建', pure.snapshotTable(assistantNodes) !== t1)

// ── 文案与悬停明细 ──────────────────────────────────────────────────────
eq('行内文案格式', pure.formatCost(0.2798), '开销 0.2798 ¥')
eq('四位小数', pure.formatCost(0.02125), '开销 0.0213 ¥')
eq('单价两位小数', pure.formatRate(0.02), '¥0.02/M')
eq('极小金额也固定四位（不再退六位）', pure.formatCny(0.00004), '¥0.0000')
const costOff = pure.costOf(M, 'deepseek-flash', OFF)
const titleOff = pure.formatTitle(costOff, 7).split('\n')
eq('第 1 行 = 未命中输入', titleOff[0], '未命中输入 1,000,000 × ¥1.00/M = ¥1.0000')
eq('第 2 行 = 命中输入', titleOff[1], '命中输入 1,000,000 × ¥0.02/M = ¥0.0200')
eq('第 3 行 = 输出', titleOff[2], '输出 1,000,000 × ¥4.00/M = ¥4.0000')
eq('第 4 行 = 合计 + 调用次数', titleOff[3], '合计 5.0200 ¥ · 7 次调用')
eq('不再有解释性文字', titleOff.length, 4)
near('三行金额之和 = 合计', costOff.cnyByBucket.hit + costOff.cnyByBucket.miss + costOff.cnyByBucket.out, costOff.cny)
ok('高峰单价翻倍并标注', pure.formatTitle(pure.costOf(M, 'deepseek-flash', PEAK)).indexOf('¥2.00/M') !== -1)
ok('缓存写入 > 0 时才多一行',
  pure.formatTitle(pure.costOf(M, 'deepseek-flash', OFF)).indexOf('缓存写入') === -1 &&
  pure.formatTitle(pure.costOf({ cacheWriteTokens: 1e6 }, 'deepseek-flash', OFF)).indexOf('缓存写入') !== -1)

// ── 组件 ────────────────────────────────────────────────────────────────
const usageProj = (turn, step, buckets) => ({ totals: M, last: { turn, step, buckets } })
const propsChat = (sessionId, messageId, chatNodes, usg) => ({
  sessionId, messageId,
  useChat: (sel) => sel({ legacy: { nodes: chatNodes } }),
  useSession: (sel) => sel({ nodes: [] }),
  useProjection: () => usg,
})
// 计价时刻必须显式给：节点路径传"该轮的时刻"，兜底路径（节点没带时间）才用 Date.now()
const expected = (buckets, model, ms) => pure.formatCost(pure.costOf(buckets, model, ms === undefined ? Date.now() : ms).cny)

pure.resetState()
const reg = setup(undefined).reg
const el = reg.Comp(propsChat('s1', 'm1', nodesWithUsage, usageProj(99, 1, b1)))
ok('节点 usage 路径能出数（不依赖当前轮投影）', el !== null && el.type === 'span', el === null ? 'null' : '')
eq('金额 = 该轮所有步求和 × 价目（用该轮最早时刻 1ms 计价）', el && el.children[0], expected(pure.sumUsageForTurn(nodesWithUsage, 1), 'deepseek-flash', 1))
ok('悬停是分桶明细（未命中在前）',
  el !== null && String(el.props.title).indexOf('未命中输入 1,500 × ¥') === 0 &&
  String(el.props.title).indexOf('命中输入 3,000 × ¥') !== -1 &&
  String(el.props.title).indexOf('输出 400 × ¥') !== -1)
ok('不挂 ref（不碰 DOM）', el !== null && el.props.ref === undefined)
ok('带 data-plugin', el !== null && el.props['data-plugin'] === 'dsh-turn-usage')

pure.resetState()
const elHist = setup(undefined).reg.Comp(propsChat('s1', 'm2', nodesWithUsage, usageProj(99, 1, b1)))
eq('历史轮用该轮路由里的模型计价', elHist && elHist.children[0], expected(nodesWithUsage[3].usage, 'deepseek-v4-pro', 3))

// ── 计价时刻 = 该轮发生时刻（不是"现在"） ───────────────────────────────
const turnAt = (ms, mid) => ([{
  kind: 'assistant', messageId: mid, turn: 1, time: ms,
  usage: { uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, routes: [{ model: 'deepseek-flash' }] }
}])
const costAtTurn = (ms, sid, mid) => {
  pure.resetState()
  const e = setup(undefined).reg.Comp(propsChat(sid, mid, turnAt(ms, mid), usageProj(99, 1, b1)))
  return e === null ? null : e.children[0]
}
eq('工作日高峰时刻的轮 → 高峰价', costAtTurn(Date.UTC(2026, 8, 21, 2, 0), 'sx1', 'x1'), '开销 10.0400 ¥')
eq('工作日空闲时刻的轮 → 空闲价', costAtTurn(Date.UTC(2026, 8, 21, 0, 30), 'sx2', 'x2'), '开销 5.0200 ¥')
eq('同一份用量、不同时刻 → 金额不同（证明不是按"现在"算）',
  costAtTurn(Date.UTC(2026, 8, 21, 2, 0), 'sx3', 'x3') !== costAtTurn(Date.UTC(2026, 8, 21, 0, 30), 'sx4', 'x4'), true)
eq('法定节假日里的轮 → 空闲价（工作日钟点也不收高峰）',
  costAtTurn(Date.UTC(2026, 9, 1, 2, 0), 'sx5', 'x5'), '开销 5.0200 ¥')

pure.resetState()
const foldEl = setup(undefined).reg.Comp(propsChat('s2', 'm1', assistantNodes, usageProj(1, 1, b1)))
eq('无 usage → 退回投影折叠（用该轮自己的模型）', foldEl && foldEl.children[0], expected(b1, 'deepseek-flash'))

eq('缺 useProjection → 不渲染', reg.Comp({ useSession: () => [], messageId: 'm1' }), null)
eq('messageId 不在节点里 → 不渲染', reg.Comp(propsChat('s1', 'missing', nodesWithUsage, usageProj(1, 1, b1))), null)
eq('节点为空 → 不渲染', reg.Comp(propsChat('s1', 'm1', [], usageProj(1, 1, b1))), null)
eq('零用量不渲染',
  reg.Comp(propsChat('s3', 'm1', [{ kind: 'assistant', messageId: 'm1', turn: 1, usage: { uncachedInputTokens: 0, outputTokens: 0 } }], usageProj(1, 1, { uncachedInputTokens: 0, outputTokens: 0 }))), null)

pure.resetState()
const regIso = setup(undefined).reg
regIso.Comp(propsChat('sa', 'm1', assistantNodes, usageProj(1, 2, b1)))
eq('会话之间不串号', regIso.Comp(propsChat('sb', 'm1', assistantNodes, usageProj(2, 1, b1))), null)

pure.resetState()
const bareNodes = [{ kind: 'assistant', messageId: 'm1', turn: 1, usage: b1 }]
eq('认不出模型 → 默认 deepseek-flash',
  setup(undefined).reg.Comp(propsChat('s5', 'm1', bareNodes, usageProj(1, 1, b1))).children[0], expected(b1, 'deepseek-flash'))
pure.resetState()
eq('配置的 model 生效',
  setup({ model: 'deepseek-v4-pro' }).reg.Comp(propsChat('s6', 'm1', bareNodes, usageProj(1, 1, b1))).children[0], expected(b1, 'deepseek-v4-pro'))

// ── 会话汇总（本轮 + 会话累计） ─────────────────────────────────────────
// nodesWithUsage：第 1 轮 = flash 空闲 ¥0.00316，第 2 轮 = v4-pro 空闲 ¥18.15（时刻取该轮最早的节点）
pure.resetState()
const tSum = pure.snapshotTable(nodesWithUsage)
const sum1 = pure.summaryOf(tSum, { turn: null, steps: {} }, nodesWithUsage, 'deepseek-flash', 's')
near('会话累计 = 各轮之和', sum1.session, 18.15 + 0.00316)
near('本轮 = 最新那一轮', sum1.current, 18.15)
eq('汇总指向最新轮号', sum1.turn, 2)

const foldBigger = { turn: 2, steps: { 1: { uncachedInputTokens: 2e6, cacheReadTokens: 2e6, outputTokens: 2e6, cacheWriteTokens: 0 } } }
const sumBig = pure.summaryOf(tSum, foldBigger, nodesWithUsage, 'deepseek-flash', 's')
near('折叠更实时时：会话取更大的那个', sumBig.session, 18.15316 - 18.15 + 36.3)
near('折叠更实时时："本轮"也用它', sumBig.current, 36.3)

const foldNew = { turn: 3, steps: { 1: { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } }
const sumNew = pure.summaryOf(tSum, foldNew, nodesWithUsage, 'deepseek-flash', 's', OFF)
near('进行中的新一轮：按给定时刻计价并累加', sumNew.session, 18.15316 + 1)
near('进行中的新一轮成为"本轮"', sumNew.current, 1)
eq('汇总指向进行中的轮号', sumNew.turn, 3)

const sumStale = pure.summaryOf(tSum, { turn: 1, steps: { 1: { uncachedInputTokens: 9e6 } } }, nodesWithUsage, 'deepseek-flash', 's', OFF)
near('旧轮的折叠不影响汇总', sumStale.session, 18.15316)
eq('旧轮折叠不改"本轮"', sumStale.turn, 2)

const sumNoKey = pure.summaryOf(tSum, foldNew, nodesWithUsage, 'deepseek-flash', undefined, OFF)
near('没有 sessionId 时不采信折叠（防止跨会话串号）', sumNoKey.session, 18.15316)

// ── 今日：只算"发生时间落在北京今天"的那几轮 ────────────────────────────
const NOONISH = Date.UTC(2026, 8, 21, 5, 0)   // 2026-09-21 周一 13:00 北京（空闲时段）
const todayNodes = [
  { kind: 'assistant', messageId: 't1', turn: 1, time: Date.UTC(2026, 8, 21, 0, 30), usage: { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0 } },
  { kind: 'assistant', messageId: 't2', turn: 2, time: Date.UTC(2026, 8, 20, 0, 30), usage: { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0 } },
]
pure.resetState()
const tToday = pure.snapshotTable(todayNodes)
const sumT = pure.summaryOf(tToday, { turn: null, steps: {} }, todayNodes, 'deepseek-flash', 's', NOONISH)
near('今日只算今天那一轮', sumT.today, 1)
near('会话算全部两轮', sumT.session, 2)

const sumWithFold = pure.summaryOf(tSum, foldNew, nodesWithUsage, 'deepseek-flash', 's', NOONISH)
near('进行中那一轮没有时刻 → 算"现在"，计入今日', sumWithFold.today, 1)

eq('通栏文案格式（价钱在前）', pure.formatDock(sum1), '本轮 18.1500 ¥ · 今日 0.0000 ¥ · 会话 18.1532 ¥')
eq('后缀式金额', pure.formatMoney(0.0123), '0.0123 ¥')
eq('极小金额也固定四位（后缀式）', pure.formatMoney(0.00004), '0.0000 ¥')

// ── 通栏组件（输入框上方） ──────────────────────────────────────────────
const dockReg = setup(undefined).reg.channels['conversation.input.dock']
ok('注册了输入框上方通栏（独立 id）', dockReg !== undefined && dockReg.opts.id === 'dsh-turn-usage-dock', dockReg ? String(dockReg.opts.id) : 'missing')
const dockProps = (sessionId, chatNodes, usg) => ({
  sessionId,
  useChat: (sel) => sel({ legacy: { nodes: chatNodes } }),
  useSession: (sel) => sel({ nodes: [] }),
  useProjection: () => usg,
})
pure.resetState()
const dockEl = dockReg.Comp(dockProps('sd1', nodesWithUsage, usageProj(2, 1, b1)))
ok('通栏能出数', dockEl !== null && dockEl.type === 'div', dockEl === null ? 'null' : '')
eq('通栏第 1 段 = 本轮', dockEl && dockEl.children[0].children[0], '本轮 18.1500 ¥')
eq('通栏第 3 段 = 今日', dockEl && dockEl.children[2].children[0], '今日 0.0000 ¥')
eq('通栏第 5 段 = 会话', dockEl && dockEl.children[4].children[0], '会话 18.1532 ¥')
eq('宽度收成内容宽（底衬只包文字）', dockEl && dockEl.props.style.width, 'fit-content')
ok('靠 margin auto 居中（不挤右侧小鲸鱼）', dockEl !== null && String(dockEl.props.style.margin).indexOf('auto') !== -1)
ok('有半透明底衬 + 描边',
  dockEl !== null && String(dockEl.props.style.background).indexOf('var(--dsw-alias-interactive-bg-hover') === 0 &&
  String(dockEl.props.style.border).indexOf('1px solid') === 0)
ok('文字改用二级色（比原来的三级色清楚）',
  dockEl !== null && String(dockEl.props.style.color).indexOf('var(--dsw-alias-label-secondary') === 0)
ok('数值槽位预留固定宽度（进位不挤动邻居）',
  dockEl !== null && dockEl.children[0].props.style.display === 'inline-block' &&
  dockEl.children[0].props.style.minWidth === '15ch')
ok('数值在自己的区间里居中（底衬左右对称）',
  dockEl !== null && dockEl.children[0].props.style.textAlign === 'center')
ok('本轮 > ¥0.5 标红（警示色）',
  dockEl !== null && String(dockEl.children[0].props.style.color).indexOf('var(--dsw-static-red-500') === 0,
  dockEl === null ? 'null' : String(dockEl.children[0].props.style.color))
ok('通栏三段各自带悬停明细',
  dockEl !== null &&
  String(dockEl.children[0].props.title).indexOf('本轮') === 0 &&
  String(dockEl.children[2].props.title).indexOf('今日') === 0 &&
  String(dockEl.children[4].props.title).indexOf('会话') === 0 &&
  String(dockEl.children[0].props.title).indexOf('未命中输入') !== -1)
eq('空会话 → 通栏不渲染', dockReg.Comp(dockProps('sd2', [], null)), null)

// 没到 ¥0.5 的那一轮不该标红（同一份判定，别误报）
pure.resetState()
const cheapNodes = [{ kind: 'assistant', messageId: 'c1', turn: 1, time: Date.UTC(2026, 8, 21, 0, 30), usage: { uncachedInputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 } }]
const dockCheap = dockReg.Comp(dockProps('sd3', cheapNodes, null))
ok('本轮没到 ¥0.5 就不标红', dockCheap !== null && dockCheap.children[0].props.style.color === undefined,
  dockCheap === null ? 'null' : String(dockCheap.children[0].props.style.color))

// ── Host 半边：路由只回传 ts >= from 的记录 ─────────────────────────────
eq('Host 路由路径', host.ROUTE_PATH, '/api/turn-usage/search-usage')
const jsonlText = [
  '{"ts":100,"model":"deepseek-v4-flash","usage":{"inputTokens":1000}}',
  'not json',
  '',
  '{"ts":300,"model":"deepseek-v4-flash","usage":{"inputTokens":2000}}'
].join('\n')
const parsedHost = host.parseJsonl(jsonlText)
eq('JSONL 解析跳过坏行/空行', parsedHost.length, 2)
eq('filter 按 from 过滤', host.filterRecords(parsedHost, 200).length, 1)
eq('filter 结果按时间升序', host.filterRecords(parsedHost, 0)[1].ts, 300)
eq('filter 尊重 cap', host.filterRecords(parsedHost, 0, 1).length, 1)

const fakeRes = () => {
  const r = { statusCode: 0, headers: {}, body: '' }
  r.setHeader = (k, v) => { r.headers[k] = v }
  r.end = (b) => { r.body = b }
  return r
}
const routeHandler = host.createHandler({ loadRecords: () => [{ ts: 1 }, { ts: 2 }] })
const resGet = fakeRes()
routeHandler({ method: 'GET', url: '/api/turn-usage/search-usage?from=2' }, resGet)
const gotJson = JSON.parse(resGet.body)
eq('路由返回 200', resGet.statusCode, 200)
eq('路由按 from 过滤', gotJson.records.length, 1)
eq('路由回报总数', gotJson.total, 2)
const resPost = fakeRes()
routeHandler({ method: 'POST', url: '/api/turn-usage/search-usage' }, resPost)
eq('非 GET → 405', resPost.statusCode, 405)

// ── 会话过滤（P2）：有 sessionId 的必须匹配，没有的旧记录保留 ──────────────
eq('按会话过滤：匹配的留下', host.filterBySession([{ sessionId: 's1' }, { sessionId: 's2' }], 's1').length, 1)
eq('按会话过滤：旧记录（无 sessionId）一律不认', host.filterBySession([{ sessionId: 's2' }, { ts: 1 }], 's1').length, 0)
eq('按会话过滤：全是旧记录 → 空', host.filterBySession([{ ts: 1 }, { ts: 2 }], 's1').length, 0)
eq('不给会话就不过滤', host.filterBySession([{ sessionId: 's2' }], '').length, 1)
const routeSession = host.createHandler({ loadRecords: () => [{ ts: 5, sessionId: 's1' }, { ts: 6, sessionId: 's2' }] })
const resSess = fakeRes()
routeSession({ method: 'GET', url: '/api/turn-usage/search-usage?from=0&session=s1' }, resSess)
eq('路由带 session 时只回本会话', JSON.parse(resSess.body).records.length, 1)

// ── 原生搜索次数：由 Host 读会话事件算（权威） ───────────────────────────
const evs = [
  { type: 'web/deepseek-search-llm-request', time: 50, data: {} },
  { type: 'tool/call', time: 100, data: { turn: 1, name: 'web_search' } },
  { type: 'web/deepseek-search-llm-request', time: 110, data: {} },
  { type: 'web/deepseek-search-llm-request', time: 120, data: {} },
  { type: 'tool/call', time: 200, data: { turn: 2, name: 'advanced_search' } },
  { type: 'web/deepseek-search-llm-request', time: 210, data: {} }
]
const callMapEvents = host.nativeCallsFromEvents(evs)
eq('搜索请求配给它之前最近的搜索类 tool/call（第 1 轮 2 次）', callMapEvents.get(1), 2)
eq('第 2 轮的 advanced_search 也认（1 次）', callMapEvents.get(2), 1)
eq('第一个请求前面没有 tool/call → 不归属', callMapEvents.size, 2)
eq('没有事件 → 空 Map', host.nativeCallsFromEvents([]).size, 0)
eq('非数组 → 空 Map', host.nativeCallsFromEvents(null).size, 0)
const routeCalls = host.createHandler({
  loadRecords: () => [],
  getCalls: (sid) => (sid === 's1' ? [{ turn: 2, count: 3 }] : [])
})
const resCalls = fakeRes()
routeCalls({ method: 'GET', url: '/api/turn-usage/search-usage?from=0&session=s1' }, resCalls)
eq('路由把 calls 一起返回', JSON.parse(resCalls.body).calls[0].count, 3)

// ── 搜索金额与按轮归属 ─────────────────────────────────────────────────
const S_REC = { ts: 3, model: 'deepseek-v4-flash', usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
const sCost = pure.searchCostOf(S_REC)
near('搜索金额 = token 部分 + 每次搜索费', sCost.cny, 0.001 + 0.005)
near('token 部分可单独取', sCost.tokenCny, 0.001)
eq('未收录模型 → null（不猜）', pure.searchCostOf({ ts: 3, model: 'gpt-4o', usage: { inputTokens: 1 } }), null)
eq('搜索金额文案（后缀式）', pure.formatSearch(0.006), '0.0060 ¥')

pure.resetState()
const tSearch = pure.snapshotTable(nodesWithUsage)
const byTurnSearch = pure.searchByTurn([S_REC], tSearch.byTurnTime)
ok('记录归到「起始时刻不晚于它」的最后一轮', byTurnSearch.has(2) && !byTurnSearch.has(1), JSON.stringify([...byTurnSearch.keys()]))
eq('归属轮的调用次数', byTurnSearch.get(2).calls, 1)
eq('早于所有轮的记录不归属任何轮',
  pure.searchByTurn([{ ts: 0, model: 'deepseek-v4-flash', usage: { inputTokens: 1 } }], tSearch.byTurnTime).size, 0)
eq('earliestTurnMs 取最早一轮', pure.earliestTurnMs(tSearch), 1)

// ── 组件：括号里的搜索金额 ─────────────────────────────────────────────
pure.SEARCH.records = []
pure.resetState()
eq('没有搜索记录时保持原样',
  setup(undefined).reg.Comp(propsChat('sp0', 'm2', nodesWithUsage, usageProj(99, 1, b1))).children[0],
  expected(nodesWithUsage[3].usage, 'deepseek-v4-pro', 3))
pure.SEARCH.records = [S_REC]
pure.resetState()
eq('有搜索记录时追加括号',
  setup(undefined).reg.Comp(propsChat('sp1', 'm2', nodesWithUsage, usageProj(99, 1, b1))).children[0],
  '开销 18.1500 ¥（搜索 0.0060 ¥）')
pure.resetState()
const dockSearchReg = setup(undefined).reg.channels['conversation.input.dock']
const dockElS = dockSearchReg.Comp(dockProps('sd9', nodesWithUsage, usageProj(2, 1, b1)))
eq('通栏「本轮」= 对话 + 搜索', dockElS && dockElS.children[0].children[0], '本轮 18.1560 ¥')
eq('通栏「会话」= 对话 + 搜索', dockElS && dockElS.children[4].children[0], '会话 18.1592 ¥')
eq('通栏不再单列搜索段', dockElS && dockElS.children.length, 5)

// Host 侧合计必须按会话隔离（否则切会话会一直显示旧会话的数）
pure.SEARCH.records = []
pure.SEARCH.calls = []
pure.TOTALS.session = 'other-session'
pure.TOTALS.sessionCny = 99
pure.TOTALS.todayCny = 0
pure.resetState()
const dockGuarded = setup(undefined).reg.channels['conversation.input.dock'].Comp(dockProps('sd10', nodesWithUsage, usageProj(2, 1, b1)))
eq('Host 合计不属于本会话 → 不采用', dockGuarded.children[4].children[0], '会话 18.1532 ¥')
pure.TOTALS.session = 'sd11'
pure.TOTALS.sessionCny = 99
pure.resetState()
const dockHostOk = setup(undefined).reg.channels['conversation.input.dock'].Comp(dockProps('sd11', nodesWithUsage, usageProj(2, 1, b1)))
eq('Host 合计属于本会话 → 采用', dockHostOk.children[4].children[0], '会话 99.0000 ¥')
pure.TOTALS.session = ''
pure.TOTALS.sessionCny = 0
pure.TOTALS.todayCny = 0
pure.SEARCH.records = []

// ── 用「工具调用」当判据（P0） ─────────────────────────────────────────
const nodesWithSearchCall = nodesWithUsage.concat([
  { kind: 'tool-call', data: { name: 'web_search', arguments: '{"queries":["x"],"engine":"deepseek-official"}', turn: 2, step: 1 } }
])
const callMap = pure.searchCallsByTurn(nodesWithSearchCall)
eq('web_search 调用计数', callMap.get(2), 1)
eq('没搜过的轮不进表', callMap.get(1) === undefined, true)
eq('别的工具不计入',
  pure.searchCallsByTurn(nodesWithUsage.concat([{ kind: 'tool-call', data: { name: 'pwsh', turn: 2 } }])).size, 0)
eq('tool/call 这种写法也认',
  pure.searchCallsByTurn([{ kind: 'tool/call', data: { name: 'web_search', arguments: '{"engine":"deepseek-official"}', turn: 5 } }]).get(5), 1)

// ── 归属时只用「调过搜索的轮」当候选（比纯时间窗更准） ──────────────────
const restrictCalls = pure.searchCallsByTurn(nodesWithSearchCall)
eq('ts 落在没调用搜索的轮 → 不归属',
  pure.searchByTurn([{ ts: 1, model: 'deepseek-v4-flash', usage: { inputTokens: 1000 } }], tSearch.byTurnTime, restrictCalls).size, 0)
eq('ts 落在调用过搜索的轮 → 正常归属',
  pure.searchByTurn([{ ts: 3, model: 'deepseek-v4-flash', usage: { inputTokens: 1000 } }], tSearch.byTurnTime, restrictCalls).get(2).calls, 1)

// 工具调用节点形状容错（真机节点是扁平的，且未必带 turn）
const NATIVE_ARGS = '{"queries":["x"],"engine":"deepseek-official"}'
eq('工具节点：扁平 name + turn + 原生引擎 → 认',
  pure.searchCallsByTurn([{ name: 'web_search', arguments: NATIVE_ARGS, turn: 3 }]).get(3), 1)
eq('工具节点：没有 turn 时用 time 反推轮次',
  pure.searchCallsByTurn([{ name: 'advanced_search', arguments: NATIVE_ARGS, time: 4 }], tSearch.byTurnTime).get(2), 1)
eq('free-search 的 web_search（无 deepseek 引擎）不算原生搜索',
  pure.searchCallsByTurn([{ name: 'web_search', arguments: '{"queries":["x"]}', turn: 3 }]).size, 0)
eq('别的工具不算',
  pure.searchCallsByTurn([{ name: 'web_fetch', arguments: NATIVE_ARGS, turn: 3 }]).size, 0)

pure.SEARCH.records = []
pure.resetState()
eq('调过 web_search 但没数据 → 标「数据缺失」',
  setup(undefined).reg.Comp(propsChat('sp2', 'm2', nodesWithSearchCall, usageProj(99, 1, b1))).children[0],
  '开销 18.1500 ¥（搜索 数据缺失）')
pure.resetState()
const dockMissing = setup(undefined).reg.channels['conversation.input.dock'].Comp(dockProps('sd8', nodesWithSearchCall, usageProj(2, 1, b1)))
ok('通栏无数据时不单列搜索（条上只有三段）',
  dockMissing !== null && dockMissing.children.length === 5 &&
  String(dockMissing.children[4].props.title).indexOf('子会话') !== -1)

// 服务端说"这轮搜过"（读会话事件算的）——即使节点里没有工具调用，也要显示数据缺失
pure.SEARCH.calls = [{ turn: 2, count: 1 }]
pure.SEARCH.records = []
pure.resetState()
eq('服务端判定本轮搜过 + 没记录 → 数据缺失',
  setup(undefined).reg.Comp(propsChat('sp9', 'm2', nodesWithUsage, usageProj(99, 1, b1))).children[0],
  '开销 18.1500 ¥（搜索 数据缺失）')
eq('callsMapFromServer 能转成 Map', pure.callsMapFromServer([{ turn: 2, count: 3 }]).get(2), 3)
pure.SEARCH.calls = []
pure.SEARCH.records = [S_REC]
pure.resetState()
eq('有调用且拿到数据 → 正常显示金额',
  setup(undefined).reg.Comp(propsChat('sp3', 'm2', nodesWithSearchCall, usageProj(99, 1, b1))).children[0],
  '开销 18.1500 ¥（搜索 0.0060 ¥）')
pure.SEARCH.records = []

// ── 功能开关（配置页） ─────────────────────────────────────────────────
eq('Host：默认三个都开', JSON.stringify(host.resolveConfig(null)), JSON.stringify({ chip: true, dock: true, search: true, extFull: false }))
eq('Host：只改一个', host.resolveConfig({ dock: false }).dock, false)
eq('Host：坏值回默认', host.resolveConfig({ chip: 'no', dock: 1 }).chip, true)
eq('Host：配置路由路径', host.CONFIG_PATH, '/api/turn-usage/config')
const resCfgGet = fakeRes()
host.createConfigHandler({ getConfig: () => ({ chip: false, dock: true, search: false }) })({ method: 'GET', url: host.CONFIG_PATH }, resCfgGet)
eq('Host：配置路由返回开关', JSON.parse(resCfgGet.body).chip, false)
const resCfgPut = fakeRes()
host.createConfigHandler({})({ method: 'PUT', url: host.CONFIG_PATH }, resCfgPut)
eq('Host：配置路由只收 GET/POST → 405', resCfgPut.statusCode, 405)
const resCfgPost = fakeRes()
host.createConfigHandler({})({ method: 'POST', url: host.CONFIG_PATH }, resCfgPost)
eq('Host：没给 saveConfig 时 POST → 501', resCfgPost.statusCode, 501)

// ── 配置：文件 + POST（故意不碰 Cordis 的 Config schema） ───────────────
eq('开关文件默认路径', /turn-usage\.json$/.test(host.configPath()), true)
const tmpCfg = join(WORKSPACE, 'temp', 'turn-usage-test-config-' + Date.now() + '.json')
process.env.DSH_TURN_USAGE_CONFIG = tmpCfg
eq('缺文件 → 默认全开', JSON.stringify(host.readConfigFile()), JSON.stringify({ chip: true, dock: true, search: true, extFull: false }))
eq('写文件成功', host.writeConfigFile({ chip: false, dock: true, search: false }), true)
eq('读回写进去的值', host.readConfigFile().chip, false)
delete process.env.DSH_TURN_USAGE_CONFIG

let savedCfg = null
const cfgHandler = host.createConfigHandler({
  getConfig: () => ({ chip: true, dock: true, search: true }),
  saveConfig: (v) => { savedCfg = v; return true }
})
const resCfgPost2 = fakeRes()
const reqCfg = {
  method: 'POST', url: host.CONFIG_PATH, _h: {},
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this }
}
cfgHandler(reqCfg, resCfgPost2)
;(reqCfg._h.data || []).forEach((fn) => fn(JSON.stringify({ dock: false })))
;(reqCfg._h.end || []).forEach((fn) => fn())
eq('POST 合并并保存', savedCfg && savedCfg.dock, false)
eq('POST 保留其余值', savedCfg && savedCfg.chip, true)

pure.CONF.chip = true
pure.saveConf({ chip: false })
eq('saveConf 立刻改本地开关', pure.CONF.chip, false)
pure.saveConf({ chip: true })

// ── Host 预算：会话事件 → 每轮行 + 账本 + 路由 ─────────────────────────
const evtRows = [
  { type: 'assistant/message', time: 1000, data: { turn: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 }, message: { source: { model: 'deepseek-flash' } } } },
  { type: 'assistant/message', time: 1005, data: { turn: 1, usage: { inputTokens: 50, outputTokens: 5 } } },
  { type: 'tool/call', time: 1006, data: { turn: 1, name: 'pwsh' } },
  { type: 'assistant/message', time: 2000, data: { turn: 2, usage: { inputTokens: 7, outputTokens: 1 } } }
]
const rowsFromEvt = host.turnRowsFromEvents(evtRows)
eq('每轮一行（同轮合并）', rowsFromEvt.length, 2)
eq('同轮用量累加', rowsFromEvt[0].inputTokens, 150)
eq('模型取自 message.source', rowsFromEvt[0].model, 'deepseek-flash')
eq('按轮排序', rowsFromEvt[1].turn, 2)
eq('北京时间日期键', host.bjDayKey(Date.UTC(2026, 0, 1, 16, 30)), '2026-01-02')

// 节假日覆盖文件：`~/.dsh/turn-usage-holidays.json`（改文件即生效，不用重发版）
const tmpHolidays = join(WORKSPACE, 'temp', 'turn-usage-holidays-' + Date.now() + '.json')
process.env.DSH_TURN_USAGE_HOLIDAYS = tmpHolidays
eq('缺文件 → 空覆盖表', Object.keys(host.readHolidays()).length, 0)
writeFileSync(tmpHolidays, JSON.stringify({ '2027-02-06': '春节', 'bad': 'x' }), 'utf8')
const hol = host.readHolidays()
eq('覆盖表只收 YYYY-MM-DD', Object.keys(hol).join(','), '2027-02-06')
eq('覆盖表带名称', hol['2027-02-06'], '春节')
delete process.env.DSH_TURN_USAGE_HOLIDAYS

pure.applyHolidays({ '2026-10-26': '测试假日' })
eq('覆盖后该日不算高峰', pure.isPeak(pure.bjToMs('2026-10-26 10:00')), false)
pure.applyHolidays({})
eq('清空后恢复高峰', pure.isPeak(pure.bjToMs('2026-10-26 10:00')), true)

const tmpLedger = join(WORKSPACE, 'temp', 'turn-usage-test-ledger-' + Date.now() + '.jsonl')
process.env.DSH_TURN_USAGE_LEDGER = tmpLedger
eq('首次写入 2 行', host.appendLedgerRows('s1', rowsFromEvt), 2)
eq('重复写去重', host.appendLedgerRows('s1', rowsFromEvt), 0)
eq('不同会话各算各的', host.appendLedgerRows('s2', rowsFromEvt.slice(0, 1)), 1)
eq('账本行数', host.readLedger().length, 3)
const resTotals = fakeRes()
host.createTotalsHandler({
  getSession: (id) => (id === 's1' ? { ownEvents: () => evtRows } : null),
  readLedger: () => [],
  appendLedger: () => 0
})({ method: 'GET', url: host.TOTALS_PATH + '?session=s1' }, resTotals)
eq('预算路由回会话行', JSON.parse(resTotals.body).session.length, 2)
delete process.env.DSH_TURN_USAGE_LEDGER

eq('rowsTotalCny 折价', Math.abs(pure.rowsTotalCny([{ ts: 3, model: 'deepseek-v4-flash', inputTokens: 1000 }]) - 0.001) < 1e-9, true)
eq('rowsTotalCny 未收录模型跳过', pure.rowsTotalCny([{ ts: 3, model: 'gpt-4o', inputTokens: 1000 }]), 0)
eq('rowsTotalCny 只算指定日期',
  Math.abs(pure.rowsTotalCny([
    { ts: 3, model: 'deepseek-v4-flash', inputTokens: 1000 },
    { ts: 86400003, model: 'deepseek-v4-flash', inputTokens: 1000 }
  ], '1970-01-01') - 0.001) < 1e-9, true)

// 分析结果按 session+seq 缓存：切走再切回来不重算
let evtWalks = 0
const fakeLive = { seq: 1, ownEvents: function () { evtWalks++; return evtRows } }
const a1 = host.analysisOf(fakeLive, 'sx')
const a2 = host.analysisOf(fakeLive, 'sx')
eq('同 session+seq 复用分析结果', a1 === a2, true)
eq('事件只遍历一次', evtWalks, 1)
eq('分析同时给出 rows 与 calls', a1.rows.length + ',' + a1.calls.length, '2,0')
const a3 = host.analysisOf({ seq: 2, ownEvents: function () { evtWalks++; return evtRows } }, 'sx')
eq('seq 变了就重算', a3 !== a1 && evtWalks === 2, true)

pure.CONF.chip = false
pure.resetState()
eq('关掉「每条回复」→ 组件返回 null',
  setup(undefined).reg.Comp(propsChat('cf1', 'm2', nodesWithUsage, usageProj(99, 1, b1))), null)
pure.CONF.chip = true
pure.CONF.dock = false
pure.resetState()
eq('关掉「通栏」→ 组件返回 null',
  setup(undefined).reg.channels['conversation.input.dock'].Comp(dockProps('cf2', nodesWithUsage, usageProj(2, 1, b1))), null)
pure.CONF.dock = true
pure.CONF.search = false
pure.SEARCH.calls = [{ turn: 2, count: 1 }]
pure.SEARCH.records = []
pure.resetState()
eq('关掉「搜索计算」→ 括号消失',
  setup(undefined).reg.Comp(propsChat('cf3', 'm2', nodesWithSearchCall, usageProj(99, 1, b1))).children[0],
  '开销 18.1500 ¥')
pure.CONF.search = true
pure.SEARCH.calls = []
pure.resetState()

// ── 结论 ────────────────────────────────────────────────────────────────
const total = pass + fails.length
console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} · ${pass}/${total} checks`)
for (const f of fails.slice(0, 10)) console.log('  x ' + f)
if (fails.length > 10) {
  try {
    mkdirSync(join(WORKSPACE, 'temp'), { recursive: true })
    const out = join(WORKSPACE, 'temp', 'dsh-turn-usage_tests.txt')
    writeFileSync(out, fails.join('\n') + '\n', 'utf8')
    console.log(`  … 完整失败清单：${out}`)
  } catch { /* 写不了就算了，stdout 已有前 10 条 */ }
}
process.exit(fails.length === 0 ? 0 : 1)
