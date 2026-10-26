/**
 * dsh-turn-usage · 客户端半（最终版）
 *
 * 在官方「每条回复的操作行」槽位里显示这一轮的花费：`开销 0.2066 ¥`。
 *
 * 数据来源（三条都实测过，详见 DESIGN.md）：
 *  - 节点取自 `useChat(s => s.legacy.nodes)`（官方 StatsPills 同款；本机 `useSession` 返回空数组）；
 *  - 每条 assistant 节点自带 `node.usage`（官方 `assistantStepReading` 读的就是它），
 *    **该轮所有节点求和** = 这一轮的真实用量（多步、历史轮都对）；
 *  - 拿不到时退回官方 `tokenUsage` 投影的 `last`（按 step 折出当前轮）。
 *
 * 计价：元 / 百万 token，按**该轮发生时刻**（节点上的 `node.time`）选「生效档」与「峰谷档」——
 * 不是按"现在"算，所以翻回历史轮也能算对。高峰 = 工作日北京 9–12、14–18；周末与法定节假日全天空闲。
 *
 * 三条自我约束（每一条都是踩过坑换来的）：
 *  1) hook 选择器的空结果必须是**同一个常量引用**，否则 React 无限重渲染 → 界面卡死；
 *  2) **绝不搬动 DOM**（连自己渲染的节点也不搬），位置只交给槽位 `order` / CSS `order`；
 *  3) 组件是"每条回复一个实例"，所以按节点数组引用**建一次表**复用，不做"条数 × 节点数"的重算。
 */
;(function () {
  'use strict'

  // ═════════════ 纯函数区 ═════════════

  // ── 价目表（元 / 百万 token） ──────────────────────────────────────────────
  //
  // 每行 = 一组模型 + 一个生效时段 + 两档价格。字段：
  //   models  该行适用的模型 id（可多个；匹配规则见 resolveKey）
  //   from/to 生效起止，北京时间 'YYYY-MM-DD HH:MM' 或 'YYYY-MM-DD'；null = 不限
  //           **含起、不含止**（ms >= from && ms < to），与官方计价切换口径一致
  //   off     空闲价；peak 高峰价（官方高峰 = 空闲 ×2，但这里按行独立写，方便将来只调一档）
  //   note    给人看的备注，不参与计算
  //
  // 同一个模型出现多行时：**后出现的胜出** —— 想改价就在文件末尾追加一行（写清 from），
  // 不必改动上面的老行，历史轮仍按当时的价算。
  // 未收录的模型 / 该时刻没有生效行 → costOf 返回 null（不显示），**绝不按 0 计**。
  var PRICES = [
    {
      models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v41-flash',
        'deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner'],
      from: null, to: null,
      off: { miss: 1, hit: 0.02, out: 4 },
      peak: { miss: 2, hit: 0.04, out: 8 },
      note: 'flash 家族现行价（V4.1-Flash）'
    },
    {
      models: ['deepseek-v4-pro'],
      from: null, to: null,
      off: { miss: 4.5, hit: 0.15, out: 13.5 },
      peak: { miss: 9, hit: 0.3, out: 27 },
      note: 'V4-Pro 现行价（2026-09 核对：仍是独立原价，未被并入 flash）'
    }
    // 追加改价的写法（真需要时再打开，并同步改 tests/run_tests.mjs 里的期望值）：
    // {
    //   models: ['deepseek-v4-pro'],
    //   from: '2026-09-14 12:00', to: null,
    //   off: { miss: 1, hit: 0.02, out: 4 }, peak: { miss: 2, hit: 0.04, out: 8 },
    //   note: '并入 flash 计价'
    // }
  ]

  // ── 节假日表（一律按**北京时间日期**判定） ────────────────────────────────
  //   off  法定放假 → 全天按【空闲】算
  //   work 调休上班 → **官方不认调休**，判定同普通周末（列出来只为对照备查，不改变计算）
  // 表外日期 = 普通日子：周一~周五走两个高峰窗口，周末全天空闲。
  // **超出有效期**时本表不参与判定（回落成"只看周末"）——年底国务院发了下一年通知后，
  // 把新一年的行追加进来、并把 validTo 改掉即可。
  // 来源：国务院办公厅关于 2026 年部分节假日安排的通知（国办发明电〔2025〕7 号）
  var HOLIDAYS = {
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    off: {
      '2026-01-01': '元旦', '2026-01-02': '元旦', '2026-01-03': '元旦',
      '2026-02-15': '春节', '2026-02-16': '春节', '2026-02-17': '春节', '2026-02-18': '春节',
      '2026-02-19': '春节', '2026-02-20': '春节', '2026-02-21': '春节', '2026-02-22': '春节',
      '2026-02-23': '春节',
      '2026-04-04': '清明节', '2026-04-05': '清明节', '2026-04-06': '清明节',
      '2026-05-01': '劳动节', '2026-05-02': '劳动节', '2026-05-03': '劳动节', '2026-05-04': '劳动节',
      '2026-05-05': '劳动节',
      '2026-06-19': '端午节', '2026-06-20': '端午节', '2026-06-21': '端午节',
      '2026-09-25': '中秋节', '2026-09-26': '中秋节', '2026-09-27': '中秋节',
      '2026-10-01': '国庆节', '2026-10-02': '国庆节', '2026-10-03': '国庆节', '2026-10-04': '国庆节',
      '2026-10-05': '国庆节', '2026-10-06': '国庆节', '2026-10-07': '国庆节'
    },
    work: {
      '2026-01-04': '元旦调休上班（周日）',
      '2026-02-14': '春节调休上班（周六）',
      '2026-02-28': '春节调休上班（周六）',
      '2026-05-09': '劳动节调休上班（周六）',
      '2026-09-20': '国庆节调休上班（周日）',
      '2026-10-10': '国庆节调休上班（周六）'
    }
  }

  var PEAK_WINDOWS_BJ = [[9, 12], [14, 18]]

  /** 北京时间 'YYYY-MM-DD[ HH:MM]' → epoch ms（手工减 8 小时，与机器时区无关）。非法串 → null。 */
  function bjToMs(s) {
    if (typeof s !== 'string') return null
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(s.replace(/^\s+|\s+$/g, ''))
    if (m === null) return null
    var hh = (m[4] === undefined) ? 0 : Number(m[4])
    var mi = (m[5] === undefined) ? 0 : Number(m[5])
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh - 8, mi)
  }

  /** 某时刻的北京日期键 'YYYY-MM-DD'（查节假日用）。 */
  function bjDateKey(ms) {
    var d = new Date(ms + 8 * 3600 * 1000)
    function p2(n) { return (n < 10 ? '0' : '') + n }
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
  }

  /** 该日期是否落在节假日表的有效期内？期外一律不参与判定。 */
  function holidayInRange(key) {
    var from = bjToMs(HOLIDAYS.validFrom)
    var to = bjToMs(HOLIDAYS.validTo)
    var at = bjToMs(key)
    return from !== null && to !== null && at !== null && at >= from && at <= to
  }

  /** 该时刻是不是法定放假日？是则返回节日名，否则（含超出有效期）null。 */
  /** 覆盖/补充的节假日：`YYYY-MM-DD` → 名称（来自 Host 的 ~/.dsh/turn-usage-holidays.json）。 */
  var HOLIDAY_EXTRA = {}

  /** 应用覆盖表（Host 下发）。 */
  function applyHolidays(map) {
    var next = {}
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (var key in map) {
        if (!Object.prototype.hasOwnProperty.call(map, key)) continue
        if (/^\d{4}-\d{2}-\d{2}$/.test(key)) next[key] = String(map[key] || '节假日')
      }
    }
    HOLIDAY_EXTRA = next
    return next
  }

  function holidayName(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return null
    var key = bjDateKey(ms)
    if (Object.prototype.hasOwnProperty.call(HOLIDAY_EXTRA, key)) return HOLIDAY_EXTRA[key]
    if (!holidayInRange(key)) return null
    return Object.prototype.hasOwnProperty.call(HOLIDAYS.off, key) ? HOLIDAYS.off[key] : null
  }

  /** 稳定的空数组常量：选择器空结果必须返回同一引用（见文件头第 1 条）。 */
  var EMPTY_NODES = []

  function num(v) {
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0
  }

  /** 价目表里出现过的全部模型 id（保持书写顺序）。 */
  function allModelIds() {
    var out = []
    for (var i = 0; i < PRICES.length; i++) {
      var ids = PRICES[i].models
      for (var j = 0; j < ids.length; j++) {
        if (out.indexOf(ids[j]) === -1) out.push(ids[j])
      }
    }
    return out
  }

  /** 模型 id → 价目表里的规范 id：精确优先，其次「名称边界前缀」取**最长**者
   *  （deepseek-v4-flash-2026-01 → deepseek-v4-flash；不会让 v4-flash 抢走 v4-flash-vision-exp-…）。 */
  function resolveKey(modelId) {
    if (typeof modelId !== 'string' || modelId === '') return null
    var s = modelId.toLowerCase()
    var ids = allModelIds()
    if (ids.indexOf(s) !== -1) return s
    var best = null
    for (var i = 0; i < ids.length; i++) {
      if (s.indexOf(ids[i] + '-') === 0 && (best === null || ids[i].length > best.length)) best = ids[i]
    }
    return best
  }

  /** 这一行在这个时刻生效吗？（含起、不含止） */
  function rowApplies(row, ms) {
    var from = (row.from === null || row.from === undefined) ? null : bjToMs(row.from)
    var to = (row.to === null || row.to === undefined) ? null : bjToMs(row.to)
    if (from !== null && !(ms >= from)) return false
    if (to !== null && !(ms < to)) return false
    return true
  }

  /** 命中「某模型的、在某时刻生效的」那一行价；多行命中时**后出现的胜出**；没有 → null。 */
  function resolveRow(key, ms) {
    if (key === null || typeof ms !== 'number' || !isFinite(ms)) return null
    var row = null
    for (var i = 0; i < PRICES.length; i++) {
      if (PRICES[i].models.indexOf(key) === -1) continue
      if (!rowApplies(PRICES[i], ms)) continue
      row = PRICES[i]
    }
    return row
  }

  /** 是否高峰：北京时间（UTC+8）。周末与**法定节假日**整天算空闲；调休上班日按普通周末算（官方不认调休）。 */
  function isPeak(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return false
    if (holidayName(ms) !== null) return false
    var d = new Date(ms + 8 * 3600 * 1000)
    var day = d.getUTCDay()
    if (day === 0 || day === 6) return false
    var hour = d.getUTCHours() + d.getUTCMinutes() / 60
    for (var i = 0; i < PEAK_WINDOWS_BJ.length; i++) {
      if (hour >= PEAK_WINDOWS_BJ[i][0] && hour < PEAK_WINDOWS_BJ[i][1]) return true
    }
    return false
  }

  /** 各种命名的 usage → 计费四桶（缺失按 0）。 */
  function bucketize(usage) {
    if (!usage || typeof usage !== 'object') return null
    function pick() {
      for (var i = 0; i < arguments.length; i++) {
        var v = usage[arguments[i]]
        if (typeof v === 'number' && isFinite(v) && v >= 0) return v
      }
      return 0
    }
    return {
      uncachedInputTokens: pick('uncachedInputTokens', 'inputTokens', 'promptTokens', 'missInputTokens'),
      outputTokens: pick('outputTokens', 'completionTokens'),
      cacheReadTokens: pick('cacheReadTokens', 'cachedInputTokens', 'cacheHitTokens', 'promptCacheHitTokens'),
      cacheWriteTokens: pick('cacheWriteTokens', 'cacheCreationTokens', 'promptCacheWriteTokens')
    }
  }

  function emptyBuckets() {
    return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }

  function bucketsAreEmpty(b) {
    return !b || (b.uncachedInputTokens === 0 && b.outputTokens === 0 &&
      b.cacheReadTokens === 0 && b.cacheWriteTokens === 0)
  }

  /** 一份 token 桶 → 人民币花费；模型不在表里、或该时刻没有生效行 → null（不猜、不按 0 计）。 */
  function costOf(buckets, modelId, ms) {
    var key = resolveKey(modelId)
    if (key === null || !buckets) return null
    var when = (typeof ms === 'number' && isFinite(ms)) ? ms : Date.now()
    var row = resolveRow(key, when)
    if (row === null) return null
    var peak = isPeak(when)
    var rate = peak ? row.peak : row.off
    var miss = num(buckets.uncachedInputTokens)
    var hit = num(buckets.cacheReadTokens)
    var out = num(buckets.outputTokens)
    var write = num(buckets.cacheWriteTokens) // 无 DeepSeek 等价项 → 按未命中输入价计
    var cnyMiss = miss * rate.miss / 1e6
    var cnyHit = hit * rate.hit / 1e6
    var cnyOut = out * rate.out / 1e6
    var cnyWrite = write * rate.miss / 1e6
    return {
      model: key,
      peak: peak,
      rate: rate,
      at: when,                  // 用了哪个时刻的价（排查"为什么这轮是高峰"用）
      note: row.note || null,
      cny: cnyMiss + cnyHit + cnyOut + cnyWrite,
      cnyByBucket: { miss: cnyMiss, hit: cnyHit, out: cnyOut, write: cnyWrite },
      buckets: { miss: miss, hit: hit, out: out, write: write }
    }
  }

  /** 把「最近一步」样本折进当前轮（兜底路径）。按 step 覆盖式写入 ⇒ 幂等。 */
  function accumulate(state, last) {
    if (!last || !last.buckets) return state
    if (state.turn !== last.turn) {
      state.turn = last.turn
      state.steps = {}
    }
    state.steps[last.step] = last.buckets
    return state
  }

  function sumSteps(steps) {
    var t = emptyBuckets()
    Object.keys(steps || {}).forEach(function (k) {
      var b = steps[k] || {}
      t.uncachedInputTokens += num(b.uncachedInputTokens)
      t.outputTokens += num(b.outputTokens)
      t.cacheReadTokens += num(b.cacheReadTokens)
      t.cacheWriteTokens += num(b.cacheWriteTokens)
    })
    return t
  }

  // ── 节点读取 ──

  function nodesFromChat(state) {
    var legacy = state && state.legacy && state.legacy.nodes
    return (Array.isArray(legacy) && legacy.length > 0) ? legacy : null
  }

  function nodesFromSession(state) {
    var legacy = state && state.chat && state.chat.legacy && state.chat.legacy.nodes
    if (Array.isArray(legacy) && legacy.length > 0) return legacy
    return (state && Array.isArray(state.nodes)) ? state.nodes : EMPTY_NODES
  }

  function snapshotNodes(state) {
    return nodesFromChat(state) || nodesFromSession(state)
  }

  function modelFromUsage(usage) {
    if (!usage || !Array.isArray(usage.routes)) return null
    for (var i = 0; i < usage.routes.length; i++) {
      var route = usage.routes[i]
      if (route && typeof route.model === 'string' && route.model !== '') return route.model
    }
    return null
  }

  /** 节点上的时间戳（毫秒）。真机是 `node.time`；其余命名一并容错，认不出 → null（回落"现在"）。 */
  function timeOfNode(node) {
    if (!node || typeof node !== 'object') return null
    var data = (node.data && typeof node.data === 'object') ? node.data : null
    var cands = [node.time, node.ts, node.at, node.createdAt, data ? data.time : null]
    for (var i = 0; i < cands.length; i++) {
      if (typeof cands[i] === 'number' && isFinite(cands[i]) && cands[i] > 0) return cands[i]
    }
    return null
  }

  /** 从节点里抽：这条消息 / 属于哪一轮 / usage / 模型 / 发生时刻。 */
  function describeNode(node) {
    if (!node || typeof node !== 'object') return null
    var data = (node.data && typeof node.data === 'object') ? node.data : null
    var closing = (data && data.closing && typeof data.closing === 'object') ? data.closing : null
    var finalNode = (closing && closing.finalNode) ? closing.finalNode : null
    var messageId = null
    if (typeof node.messageId === 'string') messageId = node.messageId
    else if (finalNode && typeof finalNode.messageId === 'string') messageId = finalNode.messageId
    var turn = null
    if (typeof node.turn === 'number') turn = node.turn
    else if (data && typeof data.turn === 'number') turn = data.turn
    var usage = node.usage || (data && data.tokenUsage) || node.tokenUsage || null
    var model = modelFromUsage(usage)
    if (model === null) {
      model = (node.provenance && node.provenance.model) || (node.requestConfig && node.requestConfig.model) || null
    }
    return { messageId: messageId, turn: turn, usage: usage, buckets: bucketize(usage), model: model, time: timeOfNode(node), kind: node.kind }
  }

  function findNode(nodes, messageId) {
    if (typeof messageId !== 'string' || messageId === '' || !Array.isArray(nodes)) return null
    for (var i = nodes.length - 1; i >= 0; i--) {
      var info = describeNode(nodes[i])
      if (info && info.messageId === messageId) return info
    }
    return null
  }

  function sumUsageForTurn(nodes, turn) {
    if (typeof turn !== 'number' || !Array.isArray(nodes)) return null
    var total = emptyBuckets()
    var seen = false
    for (var i = 0; i < nodes.length; i++) {
      var info = describeNode(nodes[i])
      if (!info || info.turn !== turn || bucketsAreEmpty(info.buckets)) continue
      seen = true
      total.uncachedInputTokens += info.buckets.uncachedInputTokens
      total.outputTokens += info.buckets.outputTokens
      total.cacheReadTokens += info.buckets.cacheReadTokens
      total.cacheWriteTokens += info.buckets.cacheWriteTokens
    }
    return seen ? total : null
  }

  function turnOfMessage(nodes, messageId) {
    var info = findNode(nodes, messageId)
    return info ? info.turn : null
  }

  function modelOfNodes(nodes) {
    if (!Array.isArray(nodes)) return null
    for (var i = nodes.length - 1; i >= 0; i--) {
      var info = describeNode(nodes[i])
      if (info && info.model) return info.model
    }
    return null
  }

  /** 只认「该轮」节点上的模型（不能用全场最新模型给旧轮计价）。 */
  function modelForTurn(nodes, turn) {
    if (typeof turn !== 'number' || !Array.isArray(nodes)) return null
    for (var i = nodes.length - 1; i >= 0; i--) {
      var info = describeNode(nodes[i])
      if (info && info.turn === turn && info.model) return info.model
    }
    return null
  }

  // ── 按「节点数组引用」缓存的表：一次遍历，所有回复行复用（见文件头第 3 条） ──
  var SNAP = { nodes: null, table: null }
  /** 最近 3 个会话的表：切走再切回来不重算（Map 保插入序，超了删最旧）。 */
  var SNAP_MAP = new Map()

  /**
   * 建表：`nodes` 变了才遍历。缓存键用「会话 id + 节点数」——
   * 切走再切回来（节点数没变）直接命中，不会像重新统计一遍。
   */
  function snapshotTable(nodes, sessionId) {
    var key = (typeof sessionId === 'string' && sessionId.length > 0 && Array.isArray(nodes))
      ? ('s|' + sessionId + '|' + nodes.length)
      : nodes
    if (SNAP.nodes === key && SNAP.table !== null) return SNAP.table
    if (key !== null && key !== undefined) {
      var cached = SNAP_MAP.get(key)
      if (cached !== undefined) {
        SNAP = { nodes: key, table: cached }
        return cached
      }
    }
    var byTurn = new Map()
    var byMessage = new Map()
    var byTurnTime = new Map()   // 轮 → 该轮最早的时刻（计价按"那轮发生的时间"，不是"现在"）
    if (Array.isArray(nodes)) {
      for (var i = 0; i < nodes.length; i++) {
        var info = describeNode(nodes[i])
        if (info === null) continue
        if (info.messageId !== null) byMessage.set(info.messageId, info)
        if (typeof info.turn === 'number' && info.time !== null) {
          var prevTime = byTurnTime.get(info.turn)
          if (prevTime === undefined || info.time < prevTime) byTurnTime.set(info.turn, info.time)
        }
        if (typeof info.turn !== 'number' || bucketsAreEmpty(info.buckets)) continue
        var entry = byTurn.get(info.turn)
        if (entry === undefined) {
          entry = { buckets: emptyBuckets(), model: null, steps: 0 }
          byTurn.set(info.turn, entry)
        }
        entry.steps++
        entry.buckets.uncachedInputTokens += info.buckets.uncachedInputTokens
        entry.buckets.outputTokens += info.buckets.outputTokens
        entry.buckets.cacheReadTokens += info.buckets.cacheReadTokens
        entry.buckets.cacheWriteTokens += info.buckets.cacheWriteTokens
        if (entry.model === null && info.model !== null) entry.model = info.model
      }
    }
    var table = { byTurn: byTurn, byMessage: byMessage, byTurnTime: byTurnTime }
    SNAP = { nodes: key, table: table }
    if (key !== null && key !== undefined) {
      SNAP_MAP.set(key, table)
      if (SNAP_MAP.size > 4) SNAP_MAP.delete(SNAP_MAP.keys().next().value)
    }
    return table
  }

  /** 某轮的发生时刻（毫秒）；节点上认不出来 → 用"现在"（兜底路径就属于这种）。 */
  function msForTurn(table, turn) {
    var t = (table && table.byTurnTime && typeof turn === 'number') ? table.byTurnTime.get(turn) : undefined
    return (typeof t === 'number') ? t : Date.now()
  }

  // ── 会话汇总（给"本轮 + 会话累计"通栏用） ──────────────────────────────

  /** 某轮的时刻；认不出就用给定的"现在"（保证"今日"判定与计价用同一个时刻）。 */
  function turnMsOr(table, turn, now) {
    var t = (table && table.byTurnTime && typeof turn === 'number') ? table.byTurnTime.get(turn) : undefined
    return (typeof t === 'number') ? t : now
  }

  /**
   * 汇总一个会话：
   *   session = 所有已完成轮 + 进行中那一轮（每轮按它自己的发生时刻计价）；
   *   today   = 其中**发生时间落在北京"今天"**的那部分（给通栏的"今日"）；
   *   current = **最新那一轮**的花费——进行中时取「投影折叠」里更大的那个，
   *             因为节点上的 usage 要到 step 结束才落下来，而折叠是实时的；
   *   cost    = 最新那一轮的完整计价对象（给悬停明细用）。
   * 返回 null = 算不出来（没节点 / 模型全未收录），调用方据此不渲染。
   *
   * sessionKey 为空时不采信折叠（防止没有会话身份时把 A 会话的折叠算到 B 上）。
   * nowMs 只是给测试用的"现在"覆盖，正式调用不传。
   */
  function summaryOf(table, fold, nodes, configuredModel, sessionKey, nowMs) {
    if (!table || !table.byTurn) return null
    var now = (typeof nowMs === 'number') ? nowMs : Date.now()
    var todayKey = bjDateKey(now)
    var costByTurn = new Map()
    var total = 0
    var today = 0
    table.byTurn.forEach(function (entry, turn) {
      var ms = turnMsOr(table, turn, now)
      var c = costOf(entry.buckets, entry.model || configuredModel, ms)
      if (c === null) return
      costByTurn.set(turn, c)
      total += c.cny
      if (bjDateKey(ms) === todayKey) today += c.cny
    })
    var latest = null
    costByTurn.forEach(function (_c, t) {
      if (latest === null || t > latest) latest = t
    })

    var foldTurn = (fold && sessionKey) ? fold.turn : null
    if (typeof foldTurn === 'number' && (latest === null || foldTurn >= latest)) {
      var foldMs = turnMsOr(table, foldTurn, now)
      var f = costOf(sumSteps(fold.steps), modelForTurn(nodes, foldTurn) || configuredModel, foldMs)
      if (f !== null) {
        var seen = costByTurn.has(foldTurn) ? costByTurn.get(foldTurn).cny : 0
        if (f.cny > seen) {
          var delta = f.cny - seen
          total += delta
          if (bjDateKey(foldMs) === todayKey) today += delta
          costByTurn.set(foldTurn, f)
        }
        latest = foldTurn
      }
    }
    if (latest === null) return null
    var top = costByTurn.get(latest) || null
    return { session: total, today: today, current: top ? top.cny : 0, turn: latest, cost: top }
  }

  /** 通栏的纯文本版（也用在悬停里）：`本轮 a ¥ · 今日 b ¥ · 会话 c ¥` */
  function formatDock(sum) {
    if (!sum) return ''
    return '本轮 ' + formatMoney(sum.current) +
      ' · 今日 ' + formatMoney(sum.today) +
      ' · 会话 ' + formatMoney(sum.session)
  }

  // ── 搜索开销（数据由 Host 半边 /api/turn-usage/search-usage 提供） ──────────

  /** 官方搜索费：¥5 / 1000 次。哪天官方调价、或这笔费不适用，改这一个常量即可（0 = 不计）。 */
  var SEARCH_FEE_CNY = 0.005

  /** 一条搜索记录 → 金额（token 部分 + 每次搜索费）。模型未收录 → null（不猜）。 */
  function searchCostOf(rec) {
    if (!rec || !rec.usage || typeof rec.ts !== 'number') return null
    var priced = costOf(bucketize(rec.usage), rec.model, rec.ts)
    if (priced === null) return null
    return { cny: priced.cny + SEARCH_FEE_CNY, tokenCny: priced.cny, fee: SEARCH_FEE_CNY, cost: priced }
  }

  /** 把搜索记录归到各轮：记录属于「起始时刻不晚于它」的最后一轮。 */
  function searchByTurn(records, byTurnTime, callsByTurn) {
    var out = new Map()
    if (!Array.isArray(records) || !byTurnTime || !(byTurnTime.size > 0)) return out
    // 只有「这轮真的调过 web_search」的轮才有资格接收记录（比纯时间窗更准）
    var restrict = (callsByTurn && typeof callsByTurn.size === 'number' && callsByTurn.size > 0) ? callsByTurn : null
    var turns = []
    byTurnTime.forEach(function (ms, turn) {
      if (typeof ms !== 'number') return
      if (restrict !== null && !restrict.has(turn)) return
      turns.push([turn, ms])
    })
    turns.sort(function (a, b) { return a[1] - b[1] })
    if (turns.length === 0) return out
    for (var i = 0; i < records.length; i++) {
      var rec = records[i]
      if (!rec || typeof rec.ts !== 'number') continue
      var owner = null
      for (var j = 0; j < turns.length; j++) {
        if (turns[j][1] <= rec.ts) owner = turns[j][0]
        else break
      }
      if (owner === null) continue
      var c = searchCostOf(rec)
      if (c === null) continue
      var cur = out.get(owner) || { cny: 0, calls: 0 }
      cur.cny += c.cny
      cur.calls += 1
      out.set(owner, cur)
    }
    return out
  }

  /** 工具调用节点上的工具名（客户端节点可能扁平、也可能包在 data 里）。 */
  function toolNameOf(node) {
    if (!node || typeof node !== 'object') return null
    var d = (node.data && typeof node.data === 'object') ? node.data : null
    var cands = [
      node.name, node.toolName,
      (node.tool && typeof node.tool === 'object') ? node.tool.name : null,
      d ? d.name : null, d ? d.toolName : null,
      (d && d.tool && typeof d.tool === 'object') ? d.tool.name : null
    ]
    for (var i = 0; i < cands.length; i++) {
      if (typeof cands[i] === 'string' && cands[i].length > 0) return cands[i]
    }
    return null
  }

  /** 工具调用属于哪一轮：优先节点自带的 turn，没有就用节点 time 反推最近的一轮。 */
  function turnOfToolNode(node, byTurnTime) {
    var d = (node && node.data && typeof node.data === 'object') ? node.data : null
    var turn = (node && typeof node.turn === 'number') ? node.turn : ((d && typeof d.turn === 'number') ? d.turn : null)
    if (turn !== null) return turn
    var at = timeOfNode(node)
    if (at === null || !byTurnTime || byTurnTime.size === 0) return null
    var bestTurn = null
    var bestMs = null
    byTurnTime.forEach(function (ms, t) {
      if (typeof ms !== 'number' || ms > at) return
      if (bestMs === null || ms > bestMs) { bestMs = ms; bestTurn = t }
    })
    return bestTurn
  }

  /** 工具调用的 arguments（字符串或对象都归一成字符串）。 */
  function argsOf(node) {
    if (!node || typeof node !== 'object') return ''
    var d = (node.data && typeof node.data === 'object') ? node.data : null
    var v = node.arguments
    if (v === undefined && d) v = d.arguments
    if (v === undefined && d) v = d.args
    if (typeof v === 'string') return v
    if (v && typeof v === 'object') { try { return JSON.stringify(v) } catch (e) { return '' } }
    return ''
  }

  /**
   * 这一条工具调用算不算「原生 deepseek 搜索」？
   * 只有确认引擎是 `deepseek-official` 才算 —— 因为 `web_search` 这个名字 free-search 也用，
   * 而 free-search 的 token 已经记在会话账里，误判会凭空提示"数据缺失"。
   */
  function isNativeSearchNode(node) {
    var name = toolNameOf(node)
    if (name !== 'web_search' && name !== 'advanced_search') return false
    return argsOf(node).indexOf('deepseek-official') !== -1
  }

  /** 搜索合计：{ total, today }（今日按北京日期算）。按 records 引用 + 日期缓存。 */
  var SEARCHSUM = { records: null, day: null, total: 0, today: 0 }
  function searchSum(records, now) {
    var at = (typeof now === 'number') ? now : Date.now()
    var day = bjDateKey(at)
    if (SEARCHSUM.records === records && SEARCHSUM.day === day) return SEARCHSUM
    var total = 0
    var today = 0
    if (Array.isArray(records)) {
      for (var i = 0; i < records.length; i++) {
        var c = searchCostOf(records[i])
        if (c === null) continue
        total += c.cny
        if (bjDateKey(records[i].ts) === day) today += c.cny
      }
    }
    SEARCHSUM = { records: records, day: day, total: total, today: today }
    return SEARCHSUM
  }

  /** 服务端给的「每轮原生搜索次数」→ Map。 */
  function callsMapFromServer(calls) {
    var map = new Map()
    if (Array.isArray(calls)) {
      for (var i = 0; i < calls.length; i++) {
        var c = calls[i]
        if (!c || typeof c.turn !== 'number' || typeof c.count !== 'number') continue
        map.set(c.turn, c.count)
      }
    }
    return map
  }

  /**
   * 每轮「原生搜索」次数：**优先用服务端算的**（读会话事件里的 deepseek-search 请求，权威），
   * 拿不到才退回节点扫描（启发式，只在 arguments 里能确认引擎时才认）。
   */
  var CALLPREV = { server: null, nodes: null, time: null, map: null }
  function searchCallsMap(serverCalls, nodes, byTurnTime) {
    if (CALLPREV.server === serverCalls && CALLPREV.nodes === nodes &&
      CALLPREV.time === byTurnTime && CALLPREV.map !== null) return CALLPREV.map
    var map = (Array.isArray(serverCalls) && serverCalls.length > 0)
      ? callsMapFromServer(serverCalls)
      : searchCallsByTurn(nodes, byTurnTime)
    CALLPREV = { server: serverCalls, nodes: nodes, time: byTurnTime, map: map }
    return map
  }

  /** 每轮的 web_search 调用次数：客户端节点里能看到工具调用，用它当「这轮搜过」的判据。 */
  var CALLMAP = { nodes: null, time: null, map: null }
  function searchCallsByTurn(nodes, byTurnTime) {
    if (CALLMAP.nodes === nodes && CALLMAP.time === byTurnTime && CALLMAP.map !== null) return CALLMAP.map
    var map = new Map()
    if (Array.isArray(nodes)) {
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        if (!node || typeof node !== 'object') continue
        if (!isNativeSearchNode(node)) continue
        var turn = turnOfToolNode(node, byTurnTime)
        if (turn === null) continue
        map.set(turn, (map.get(turn) || 0) + 1)
      }
    }
    CALLMAP = { nodes: nodes, time: byTurnTime, map: map }
    return map
  }

  /** 归表的缓存：records / 表 / 调用表都没换就直接复用。 */
  var SEARCHMAP = { records: null, time: null, calls: null, map: null }
  function searchTurnMap(records, byTurnTime, callsByTurn) {
    if (SEARCHMAP.records === records && SEARCHMAP.time === byTurnTime &&
      SEARCHMAP.calls === callsByTurn && SEARCHMAP.map !== null) return SEARCHMAP.map
    var map = searchByTurn(records, byTurnTime, callsByTurn)
    SEARCHMAP = { records: records, time: byTurnTime, calls: callsByTurn, map: map }
    return map
  }

  /** 会话里最早一轮的时刻（给 Host 路由的 from 参数，避免每次轮询搬全量历史）。 */
  function earliestTurnMs(table) {
    var min = null
    if (table && table.byTurnTime) {
      table.byTurnTime.forEach(function (ms) {
        if (typeof ms === 'number' && (min === null || ms < min)) min = ms
      })
    }
    return min === null ? 0 : min
  }

  /** 搜索金额（后缀式）：`0.0180 ¥` */
  function formatSearch(cny) {
    return formatMoney(cny)
  }

  // ── 文案 ──

  /** 行内文案：`开销 0.2066 ¥` */
  function formatCost(cny) {
    return '开销 ' + cny.toFixed(4) + ' ¥'
  }

  /** 单价：元 / 百万 token，两位小数。 */
  function formatRate(rate) {
    return '¥' + rate.toFixed(2) + '/M'
  }

  /** 单项金额：固定四位。 */
  function formatCny(v) {
    return '¥' + v.toFixed(4)
  }

  /** 金额（后缀式，给通栏用）：`0.0123 ¥` —— 固定四位，不再为极小值加位。 */
  function formatMoney(v) {
    return v.toFixed(4) + ' ¥'
  }

  function kfmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  /** 悬停明细：命中输入 / 未命中输入 / 输出 各一行（token 量 × 单价 = 金额），再合计与口径。 */
  /** 悬停明细：三项 token × 单价 = 金额，再加合计与调用次数。不写解释文字。 */
  function formatTitle(cost, calls) {
    function line(label, tokens, rate, cny) {
      return label + ' ' + kfmt(tokens) + ' × ' + formatRate(rate) + ' = ' + formatCny(cny)
    }
    var lines = [
      line('未命中输入', cost.buckets.miss, cost.rate.miss, cost.cnyByBucket.miss),
      line('命中输入', cost.buckets.hit, cost.rate.hit, cost.cnyByBucket.hit),
      line('输出', cost.buckets.out, cost.rate.out, cost.cnyByBucket.out)
    ]
    if (cost.buckets.write > 0) {
      lines.push(line('缓存写入', cost.buckets.write, cost.rate.miss, cost.cnyByBucket.write))
    }
    var tail = '合计 ' + cost.cny.toFixed(4) + ' ¥'
    if (typeof calls === 'number' && calls > 0) tail += ' · ' + calls + ' 次调用'
    lines.push(tail)
    return lines.join('\n')
  }

  /** 某一轮的调用次数（该轮 assistant 步数）。 */
  function turnSteps(table, turn) {
    if (!table || typeof turn !== 'number' || !table.byTurn) return 0
    var entry = table.byTurn.get(turn)
    return (entry && typeof entry.steps === 'number') ? entry.steps : 0
  }

  // ── 按会话隔离的折叠状态（兜底路径用） ──
  var STATE = new Map()

  function stateFor(sessionId) {
    var key = (typeof sessionId === 'string' && sessionId !== '') ? sessionId : '__default__'
    var st = STATE.get(key)
    if (st === undefined) {
      st = { fold: { turn: null, steps: {} }, costs: new Map() }
      STATE.set(key, st)
    }
    return st
  }

  function resetState() {
    STATE.clear()
    SNAP = { nodes: null, table: null }
    SNAP_MAP.clear()
  }

  /** 搜索记录的共享状态（要在 PURE 之前初始化，否则导出的是 undefined）。 */
  var SEARCH = { records: [], calls: [], subs: new Set(), timer: null, from: 0, session: '', inflight: false }

  /** 功能开关状态（同样要在 PURE 之前初始化）。 */
  var CONF = { chip: true, dock: true, search: true, extFull: false, loaded: false, subs: new Set(), timer: null, inflight: false, available: { search: false, full: false }, external: { sessions: {} } }

  /** Host 侧合计（会计）：{sessionCny, todayCny, session, at, inflight}。 */
  var TOTALS = { sessionCny: 0, todayCny: 0, session: '', at: 0, inflight: false, sessionSum: null, todaySum: null }

  var PURE = {
    PRICES: PRICES,
    HOLIDAYS: HOLIDAYS,
    PEAK_WINDOWS_BJ: PEAK_WINDOWS_BJ,
    bjToMs: bjToMs,
    bjDateKey: bjDateKey,
    holidayName: holidayName,
    applyHolidays: applyHolidays,
    allModelIds: allModelIds,
    resolveKey: resolveKey,
    rowApplies: rowApplies,
    resolveRow: resolveRow,
    isPeak: isPeak,
    bucketize: bucketize,
    costOf: costOf,
    accumulate: accumulate,
    sumSteps: sumSteps,
    snapshotNodes: snapshotNodes,
    nodesFromChat: nodesFromChat,
    nodesFromSession: nodesFromSession,
    describeNode: describeNode,
    timeOfNode: timeOfNode,
    msForTurn: msForTurn,
    findNode: findNode,
    sumUsageForTurn: sumUsageForTurn,
    turnOfMessage: turnOfMessage,
    modelOfNodes: modelOfNodes,
    modelForTurn: modelForTurn,
    modelFromUsage: modelFromUsage,
    summaryOf: summaryOf,
    formatDock: formatDock,
    SEARCH_FEE_CNY: SEARCH_FEE_CNY,
    searchCostOf: searchCostOf,
    searchByTurn: searchByTurn,
    searchCallsByTurn: searchCallsByTurn,
    searchCallsMap: searchCallsMap,
    searchSum: searchSum,
    callsMapFromServer: callsMapFromServer,
    isNativeSearchNode: isNativeSearchNode,
    searchTurnMap: searchTurnMap,
    earliestTurnMs: earliestTurnMs,
    formatSearch: formatSearch,
    SEARCH: SEARCH,
    CONF: CONF,
    saveConf: saveConf,
    TOTALS: TOTALS,
    rowsTotalCny: rowsTotalCny,
    snapshotTable: snapshotTable,
    formatCost: formatCost,
    formatRate: formatRate,
    formatCny: formatCny,
    formatMoney: formatMoney,
    formatTitle: formatTitle,
    stateFor: stateFor,
    resetState: resetState
  }
  // 只为 tests/run_tests.mjs 提供入口；浏览器里挂着也无副作用（不写 DOM、不打日志）
  if (typeof globalThis !== 'undefined') globalThis.__dshTurnCostPure = PURE

  // ── 搜索记录缓存（一处轮询，所有组件共享；状态变量在纯函数区声明，见上） ──

  function searchSubscribe(fn) {
    SEARCH.subs.add(fn)
    return function () { SEARCH.subs.delete(fn) }
  }

  function searchNotify() {
    SEARCH.subs.forEach(function (fn) { try { fn() } catch (e) { } })
  }

  function searchFetch() {
    if (SEARCH.inflight) return
    if (typeof fetch !== 'function') return
    SEARCH.inflight = true
    var qs = '/api/turn-usage/search-usage?from=' + Math.floor(SEARCH.from || 0)
    if (SEARCH.session) qs += '&session=' + encodeURIComponent(SEARCH.session)
    fetch(qs, { credentials: 'same-origin' })
      .then(function (res) { return (res && res.ok) ? res.json() : null })
      .then(function (json) {
        if (!json || !Array.isArray(json.records)) return
        var prev = SEARCH.records
        var prevCalls = SEARCH.calls || []
        var lastPrev = prev.length > 0 ? prev[prev.length - 1].ts : -1
        var lastNext = json.records.length > 0 ? json.records[json.records.length - 1].ts : -1
        SEARCH.records = json.records
        SEARCH.calls = Array.isArray(json.calls) ? json.calls : []
        if (json.records.length !== prev.length || lastNext !== lastPrev || SEARCH.calls.length !== prevCalls.length) searchNotify()
      })
      .catch(function () { })
      .then(function () { SEARCH.inflight = false })
  }

  function searchPoll(from, session) {
    var s = (typeof session === 'string') ? session : ''
    var f = (typeof from === 'number' && isFinite(from)) ? from : 0
    if (f !== SEARCH.from || s !== SEARCH.session) {
      SEARCH.from = f
      SEARCH.session = s
      searchFetch()
    }
    if (SEARCH.timer === null && typeof setInterval === 'function') {
      SEARCH.timer = setInterval(searchFetch, 2000)
    }
  }

  /** 组件用：订阅搜索记录（变了才重渲染），并按会话身份 + 起始时刻轮询。 */
  function useSearchUsage(React, from, sessionId) {
    var state = React.useState(0)
    var bump = state[1]
    React.useEffect(function () {
      return searchSubscribe(function () { bump(function (v) { return v + 1 }) })
    }, [])
    React.useEffect(function () { searchPoll(from, sessionId) }, [from, sessionId])
    return SEARCH.records
  }

  // ── 功能开关（插件行 config / Host 路由 /api/turn-usage/config；拿不到时全开） ──
  // 状态变量在纯函数区声明（见上），否则 PURE 导出的是 undefined

  function confSubscribe(fn) {
    CONF.subs.add(fn)
    return function () { CONF.subs.delete(fn) }
  }

  function confNotify() {
    CONF.subs.forEach(function (fn) { try { fn() } catch (e) { } })
  }

  function confFetch() {
    if (CONF.inflight || typeof fetch !== 'function') return
    CONF.inflight = true
    fetch('/api/turn-usage/config', { credentials: 'same-origin' })
      .then(function (res) { return (res && res.ok) ? res.json() : null })
      .then(function (json) {
        if (!json || typeof json !== 'object') return
        var chip = (typeof json.chip === 'boolean') ? json.chip : true
        var dock = (typeof json.dock === 'boolean') ? json.dock : true
        var search = (typeof json.search === 'boolean') ? json.search : true
        var changed = !CONF.loaded || chip !== CONF.chip || dock !== CONF.dock || search !== CONF.search
        CONF.chip = chip
        CONF.dock = dock
        CONF.search = search
        CONF.extFull = (typeof json.extFull === 'boolean') ? json.extFull : false
        CONF.available = {
          search: !!(json.available && json.available.search),
          full: !!(json.available && json.available.full)
        }
        CONF.external = (json.external && json.external.sessions) ? json.external : { sessions: {} }
        CONF.loaded = true
        if (json.holidays) applyHolidays(json.holidays)
        if (changed) confNotify()
      })
      .catch(function () { })
      .then(function () { CONF.inflight = false })
  }

  // ── Host 侧预算的合计（会话 / 今日，不受客户端只加载了多少节点影响） ──────────
  // 状态变量 TOTALS 在纯函数区声明（PURE 之前），否则导出的会是 undefined

  /** 账本/事件行 → bucketize 需要的形状（两种字段名都认）。 */
  function rowBuckets(r) {
    return bucketize({
      inputTokens: (typeof r.inputTokens === 'number') ? r.inputTokens : (r.in || 0),
      outputTokens: (typeof r.outputTokens === 'number') ? r.outputTokens : (r.out || 0),
      cacheReadTokens: (typeof r.cacheReadTokens === 'number') ? r.cacheReadTokens : (r.hit || 0),
      cacheWriteTokens: (typeof r.cacheWriteTokens === 'number') ? r.cacheWriteTokens : (r.w || 0)
    })
  }

  /** 一组用量行折成金额（模型未收录的行跳过，不猜）；给了 dayKey 就只算那天的。 */
  function rowsTotalCny(rows, dayKey) {
    var sum = 0
    if (!Array.isArray(rows)) return sum
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]
      if (!r) continue
      var at = (typeof r.ts === 'number') ? r.ts : Date.now()
      if (dayKey && bjDateKey(at) !== dayKey) continue
      var cost = costOf(rowBuckets(r), r.model || DEFAULT_MODEL, at)
      if (cost !== null) sum += cost.cny
    }
    return sum
  }

  /** 一组用量行 → 汇总（tokens + 各项金额 + 轮数），给「今日/会话」悬停用。 */
  function rowsSummary(rows, dayKey) {
    var s = { miss: 0, hit: 0, out: 0, write: 0, missCny: 0, hitCny: 0, outCny: 0, writeCny: 0, cny: 0, calls: 0 }
    if (!Array.isArray(rows)) return s
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]
      if (!r) continue
      var at = (typeof r.ts === 'number') ? r.ts : Date.now()
      if (dayKey && bjDateKey(at) !== dayKey) continue
      var b = rowBuckets(r)
      var c = costOf(b, r.model || DEFAULT_MODEL, at)
      if (c === null) continue
      s.miss += b.uncachedInputTokens
      s.hit += b.cacheReadTokens
      s.out += b.outputTokens
      s.write += b.cacheWriteTokens
      s.missCny += c.cnyByBucket.miss
      s.hitCny += c.cnyByBucket.hit
      s.outCny += c.cnyByBucket.out
      s.writeCny += c.cnyByBucket.write
      s.cny += c.cny
      s.calls += 1
    }
    return s
  }

  /** 有效均价：跨峰谷时用「金额 ÷ token」倒推，显示成 ¥x.xx/M。 */
  function avgRate(cny, tokens) {
    if (!(tokens > 0) || !(cny > 0)) return formatRate(0)
    return formatRate(cny / tokens * 1e6)
  }

  /** 汇总 → 明细行（今日/会话用；和本轮同一种排版）。 */
  function formatSummary(s) {
    if (!s || !(s.cny > 0)) return '（暂无数据）'
    var lines = [
      '未命中输入 ' + kfmt(s.miss) + ' × ' + avgRate(s.missCny, s.miss) + ' = ' + formatCny(s.missCny),
      '命中输入 ' + kfmt(s.hit) + ' × ' + avgRate(s.hitCny, s.hit) + ' = ' + formatCny(s.hitCny),
      '输出 ' + kfmt(s.out) + ' × ' + avgRate(s.outCny, s.out) + ' = ' + formatCny(s.outCny)
    ]
    if (s.write > 0) {
      lines.push('缓存写入 ' + kfmt(s.write) + ' × ' + avgRate(s.writeCny, s.write) + ' = ' + formatCny(s.writeCny))
    }
    return lines.join('\n')
  }

  function totalsFetch(sessionId) {
    if (TOTALS.inflight || typeof fetch !== 'function') return
    var sid = (typeof sessionId === 'string') ? sessionId : ''
    TOTALS.inflight = true
    fetch('/api/turn-usage/totals' + (sid ? '?session=' + encodeURIComponent(sid) : ''), { credentials: 'same-origin' })
      .then(function (res) { return (res && res.ok) ? res.json() : null })
      .then(function (json) {
        if (!json || typeof json !== 'object') return
        // 「今日」= **这个会话今天**花掉的钱（不是所有会话），所以两个数都从本会话的行里算
        var rows = Array.isArray(json.session) ? json.session : []
        var s = rowsTotalCny(rows)
        var t = rowsTotalCny(rows, bjDateKey(Date.now()))
        var changed = s !== TOTALS.sessionCny || t !== TOTALS.todayCny || sid !== TOTALS.session
        TOTALS.sessionSum = rowsSummary(rows)
        TOTALS.todaySum = rowsSummary(rows, bjDateKey(Date.now()))
        TOTALS.sessionCny = s
        TOTALS.todayCny = t
        TOTALS.session = sid
        TOTALS.at = Date.now()
        if (changed) confNotify()   // 复用配置订阅触发重渲染
      })
      .catch(function () { })
      .then(function () { TOTALS.inflight = false })
  }

  /** 拉一次 + 每 30 秒刷新（只管配置）。Host 侧合计由 dock 自己按会话节奏拉。 */
  function confPoll() {
    confFetch()
    if (CONF.timer === null && typeof setInterval === 'function') {
      CONF.timer = setInterval(confFetch, 30000)
    }
  }

  /**
   * 改开关：本地立刻生效，同时 POST 回 Host 写进 `~/.dsh/turn-usage.json`。
   */
  function saveConf(patch) {
    if (!patch || typeof patch !== 'object') return
    var next = { chip: CONF.chip, dock: CONF.dock, search: CONF.search, extFull: CONF.extFull }
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue
      if (typeof patch[k] === 'boolean') next[k] = patch[k]
    }
    CONF.chip = next.chip
    CONF.dock = next.dock
    CONF.search = next.search
    CONF.loaded = true
    confNotify()
    if (typeof fetch !== 'function') return
    try {
      fetch('/api/turn-usage/config', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next)
      }).catch(function () { })
    } catch (e) { }
  }

  /** 组件用：订阅开关变化（变了才重渲染）。 */
  function useConf(React) {
    var state = React.useState(0)
    var bump = state[1]
    React.useEffect(function () {
      return confSubscribe(function () { bump(function (v) { return v + 1 }) })
    }, [])
    return CONF
  }

  // ═════════════ 插件本体 ═════════════

  var NAME = 'dsh-turn-usage'
  var DEFAULT_MODEL = 'deepseek-flash'
  /** 单轮超过这个金额（元）就把「本轮」标成警示色，一眼看出这轮很贵。 */
  var HOT_CNY = 0.5

  function makeComponent(React, configuredModel) {
    return function TurnCost(props) {
      var p = props || {}
      var hookChat = p.useChat
      var hookSession = p.useSession
      var hookProjection = p.useProjection
      if (typeof hookSession !== 'function' || typeof hookProjection !== 'function') return null

      // hook 顺序在组件生命周期内稳定：useChat（若有）→ useSession → useProjection
      var chatNodes = (typeof hookChat === 'function') ? hookChat(nodesFromChat) : null
      var sessionNodes = hookSession(nodesFromSession)
      var usage = hookProjection('tokenUsage')
      var nodes = (Array.isArray(chatNodes) && chatNodes.length > 0) ? chatNodes : (sessionNodes || EMPTY_NODES)

      // 一次遍历建表，所有回复行复用
      var table = snapshotTable(nodes, p.sessionId)
      // 搜索记录（hooks 必须在任何 return 之前调用）：按会话身份 + 最早轮次时刻取数
      var searchRecords = useSearchUsage(React, earliestTurnMs(table), p.sessionId)
      useConf(React) // hooks 必须在任何 return 之前
      if (!CONF.chip) return null
      var info = table.byMessage.get(p.messageId)
      if (info === undefined) return null
      var entry = (typeof info.turn === 'number') ? table.byTurn.get(info.turn) : undefined
      // 计价时刻 = **该轮发生的时间**（节点 node.time），认不出才回落"现在"
      var when = msForTurn(table, info.turn)

      // 兜底：节点里没有该轮 usage 时，用官方投影把「最近一步」折成本轮
      var st = stateFor(p.sessionId)
      if (entry === undefined) {
        var last = (usage && usage.last) ? usage.last : null
        accumulate(st.fold, last)
        if (st.fold.turn !== null) {
          var folded = costOf(sumSteps(st.fold.steps), modelForTurn(nodes, st.fold.turn) || configuredModel, msForTurn(table, st.fold.turn))
          if (folded !== null) st.costs.set(st.fold.turn, folded)
        }
      }

      var cost = null
      if (entry !== undefined) cost = costOf(entry.buckets, entry.model || configuredModel, when)
      if (cost === null && typeof info.turn === 'number') cost = st.costs.get(info.turn) || null
      if (cost === null || !(cost.cny > 0)) return null

      // 搜索：先用「这轮有没有 web_search 工具调用」判断该不该显示，再看有没有记账数据
      var text = formatCost(cost.cny)
      var title = formatTitle(cost, turnSteps(table, info.turn))
      if (typeof info.turn === 'number') {
        var callsMap = CONF.search ? searchCallsMap(SEARCH.calls, nodes, table.byTurnTime) : new Map()
        var sTurn = CONF.search ? searchTurnMap(searchRecords, table.byTurnTime, callsMap).get(info.turn) : null
        var sCalls = CONF.search ? (callsMap.get(info.turn) || 0) : 0
        if (sTurn && sTurn.cny > 0) {
          text += '（搜索 ' + formatSearch(sTurn.cny) + '）'
          title += '\n搜索 ' + sTurn.calls + ' 次 · ' + formatSearch(sTurn.cny)
        } else if (sCalls > 0) {
          // 调过 web_search 却没有记账数据 ⇒ 这才是真正"有问题"的信号
          text += '（搜索 数据缺失）'
        }
      }

      return React.createElement('span', {
        className: 'dsh-turn-usage',
        'data-plugin': NAME,
        title: title,
        style: {
          fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
          lineHeight: '24px',
          height: '28px',
          display: 'inline-flex',
          alignItems: 'center',
          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          padding: '0 2px',
          userSelect: 'text',
          // 纯 CSS 排序：只在"本元素是那一排的直接 flex 子项"时生效，不生效也无害
          order: 2
        }
      }, text)
    }
  }

  /**
   * 输入框上方通栏：`本轮 ¥0.0123 · 会话 ¥0.4567`
   *
   * 只显示**当前打开的那个会话**。切到别的会话时这里不渲染，但那边照常在后台跑；
   * 切回来时数字直接从节点/投影重算，所以永远是最新的（不需要"持续累加"）。
   */
  function makeDockComponent(React, configuredModel) {
    return function TurnCostDock(props) {
      var p = props || {}
      var hookChat = p.useChat
      var hookSession = p.useSession
      var hookProjection = p.useProjection

      // 不同槽位给的 props 不完全一样：缺哪个就跳过哪个，绝不因此抛错
      var chatNodes = (typeof hookChat === 'function') ? hookChat(nodesFromChat) : null
      var sessionNodes = (typeof hookSession === 'function') ? hookSession(nodesFromSession) : null
      var usage = (typeof hookProjection === 'function') ? hookProjection('tokenUsage') : null

      var nodes = (Array.isArray(chatNodes) && chatNodes.length > 0)
        ? chatNodes
        : ((Array.isArray(sessionNodes) && sessionNodes.length > 0) ? sessionNodes : EMPTY_NODES)

      var table = snapshotTable(nodes, p.sessionId)
      // 搜索记录（hooks 必须在任何 return 之前调用）：按会话身份 + 最早轮次时刻取数
      var searchRecords = useSearchUsage(React, earliestTurnMs(table), p.sessionId)
      useConf(React) // hooks 必须在任何 return 之前
      // Host 侧合计：**跟着当前会话**拉，切会话立刻重拉，之后每 5 秒刷新
      React.useEffect(function () {
        var sid = p.sessionId
        totalsFetch(sid)
        if (typeof setInterval !== 'function') return undefined
        var timer = setInterval(function () { totalsFetch(sid) }, 5000)
        return function () { clearInterval(timer) }
      }, [p.sessionId])
      if (!CONF.dock) return null
      var st = stateFor(p.sessionId)
      accumulate(st.fold, (usage && usage.last) ? usage.last : null)
      var sum = summaryOf(table, st.fold, nodes, configuredModel, p.sessionId)
      if (sum === null || !(sum.session > 0)) return null

      var title = ''

      // 通栏显示**总价**（对话 + 原生搜索），不再单列搜索；明细留给悬停
      var callsMap = CONF.search ? searchCallsMap(SEARCH.calls, nodes, table.byTurnTime) : new Map()
      var sCur = CONF.search ? searchTurnMap(searchRecords, table.byTurnTime, callsMap).get(sum.turn) : null
      var sCalls = CONF.search ? (callsMap.get(sum.turn) || 0) : 0
      var sSum = CONF.search ? searchSum(searchRecords) : { total: 0, today: 0 }
      if (sCur && sCur.cny > 0) {
        title += '\n— 本轮搜索 ' + sCur.calls + ' 次 · ' + formatMoney(sCur.cny) + '（已并进上面的总价）'
      } else if (sCalls > 0) {
        title += '\n— 本轮调用过原生搜索 ' + sCalls + ' 次，但没有记账数据（总价里缺这块）'
      }
      if (sSum.total > 0) {
        title += '\n— 本会话搜索合计 ' + formatMoney(sSum.total) + '（今日 ' + formatMoney(sSum.today) + '，已并入总价）'
      }
      var curAll = sum.current + (sCur ? sCur.cny : 0)
      var dayAll = sum.today + sSum.today
      var sesAll = sum.session + sSum.total
      // Host 侧合计更全（会话事件 / 账本），但**必须确认是当前会话的**，否则会显示旧会话的数
      var hostSes = (TOTALS.session === (p.sessionId || '')) ? TOTALS.sessionCny : 0
      var dayHost = TOTALS.todayCny + sSum.today
      if (dayHost > dayAll) dayAll = dayHost
      var sesHost = hostSes + sSum.total
      if (sesHost > sesAll) sesAll = sesHost
      // 全面统计（外部源）：勾了且当前会话有数，就并进「会话」
      var extCny = (CONF.extFull && CONF.external && CONF.external.sessions)
        ? Number(CONF.external.sessions[p.sessionId] || 0) : 0
      if (isFinite(extCny) && extCny > 0) sesAll += extCny

      // 悬停按段分开：三个数字各自给自己的明细，悬到哪个看哪个
      var turnTitle = '本轮\n' + (sum.cost ? formatTitle(sum.cost, turnSteps(table, sum.turn)) : '（暂无数据）')
      if (sCur && sCur.cny > 0) turnTitle += '\n搜索 ' + sCur.calls + ' 次 · ' + formatMoney(sCur.cny)
      var todayTitle = '今日 ' + formatMoney(dayAll) +
        (TOTALS.todaySum ? '（' + TOTALS.todaySum.calls + ' 轮）\n' + formatSummary(TOTALS.todaySum) : '')
      var sessionTitle = '会话 ' + formatMoney(sesAll) +
        (TOTALS.sessionSum ? '（' + TOTALS.sessionSum.calls + ' 轮）\n' + formatSummary(TOTALS.sessionSum) : '')
      sessionTitle += '\n（不含子 agent / 子会话）'
      if (extCny > 0) sessionTitle += '\n外部统计源 +' + formatMoney(extCny)

      // 数值槽位**预留固定宽度**：进位 / 位数变化（含 4→6 位小数）都不会挤动邻居；
      // **居中**摆放：左右余白对称，底衬看起来才不歪（原来左对齐，末位右边会多出一截空白）
      function cell(label, money, hot, hint) {
        var st = { display: 'inline-block', minWidth: '15ch', textAlign: 'center' }
        if (hot) st.color = 'var(--dsw-static-red-500, #d8453c)'
        return React.createElement('span', { style: st, title: hint }, label + ' ' + money)
      }
      function dot() {
        return React.createElement('span', { style: { opacity: 0.45, margin: '0 3px' } }, '·')
      }

      return React.createElement('div', {
        className: 'dsh-turn-usage-dock',
        'data-plugin': NAME,
        style: {
          // 宽度收成内容宽 + margin auto ⇒ 底衬只包住文字（不是整条通栏），同时保持居中
          width: 'fit-content',
          maxWidth: '100%',
          margin: '2px auto 0',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          padding: '2px 12px 2px',
          borderRadius: '6px',
          // 半透明底衬 + 描边：原来纯文字太淡，叠在浅色/深色背景上都不够清楚
          background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
          border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.22))',
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary, rgba(95,95,95,0.95))',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          userSelect: 'text',
          pointerEvents: 'auto'
        }
      },
        cell('本轮', formatMoney(curAll), curAll > HOT_CNY, turnTitle), dot(),
        cell('今日', formatMoney(dayAll), false, todayTitle), dot(),
        cell('会话', formatMoney(sesAll), false, sessionTitle)
      )
    }
  }

  /**
   * 插件页的配置卡：三个开关。
   * 不用官方 UI 组件（避免 require 未注册模块），读写走 `/api/turn-usage/config`：
   * 值存 `~/.dsh/turn-usage.json`，改动立刻生效。
   */
  function makeSettingsComponent(React) {
    function row(key, label, hint, available) {
      // 可用 → 正常可勾可取消；不可用 → 强制未勾 + 置灰
      var usable = available !== false
      var checked = usable ? !!CONF[key] : false
      return React.createElement('label', {
        key: key,
        style: {
          display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '6px 0',
          cursor: usable ? 'pointer' : 'not-allowed', opacity: usable ? 1 : 0.45
        }
      },
        React.createElement('input', {
          type: 'checkbox',
          checked: checked,
          disabled: !usable,
          style: { marginTop: '3px' },
          onChange: function (e) {
            if (!usable) return
            var patch = {}
            patch[key] = (e && e.target) ? !!e.target.checked : !CONF[key]
            saveConf(patch)
          }
        }),
        React.createElement('span', null,
          React.createElement('div', { style: { fontSize: '13px' } }, label),
          React.createElement('div', {
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' }
          }, hint)
        )
      )
    }
    function divider(text) {
      return React.createElement('div', {
        key: 'div-' + text,
        style: {
          margin: '10px 0 2px', paddingTop: '8px',
          borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))',
          fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))'
        }
      }, text)
    }
    return function TurnCostSettings() {
      useConf(React)
      var hasSearch = !!(CONF.available && CONF.available.search)
      var hasFull = !!(CONF.available && CONF.available.full)
      return React.createElement('div', { style: { padding: '4px 0 8px' } },
        row('chip', '每条回复末尾显示本轮开销', '关掉后不显示「开销 x ¥」'),
        row('dock', '输入框上方显示通栏', '本轮 / 今日 / 会话 总价；关掉后整条消失'),
        divider('拓展（需要额外的数据来源）'),
        row('search', '搜索精确统计', hasSearch
          ? '把原生 DeepSeek 搜索费用并入总价；可随时关掉'
          : '未安装 dsh-search-audit 或还没有它的记账数据，暂不可用', hasSearch),
        row('extFull', '全面统计（外部统计源）', hasFull
          ? '使用外部统计源补齐子 agent / 子会话等不可见开销'
          : '未接入外部统计源；agent 写 `~/.dsh/turn-usage-external.json` 后即可勾选', hasFull)
      )
    }
  }

  window.__ModuleLoader__.load({
    id: NAME,
    factory: function (require) {
      var React = require('react')

      function apply(ctx, config) {
        // 客户端若拿到 config 就同步生效（无闪烁）；拿不到再走 Host 路由补
        if (config && typeof config === 'object') {
          if (typeof config.chip === 'boolean') CONF.chip = config.chip
          if (typeof config.dock === 'boolean') CONF.dock = config.dock
          if (typeof config.search === 'boolean') CONF.search = config.search
          CONF.loaded = true
        }
        confPoll()
        var model = (config && config.model) || DEFAULT_MODEL
        var Component = makeComponent(React, model)
        var DockComponent = makeDockComponent(React, model)
        ctx.slots.inject('conversation.chat.assistant-actions', function () {
          return ctx.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: NAME,
            order: 50, // 只在本槽位内部排序（官方「复制/分支/用量/用时」不是槽位项，排不到它们之间）
            registrant: NAME
          }, Component)
        })
        // 输入框上方通栏：只显示当前会话。万一这个版本没有该槽位，也不影响上面每条回复那个
        try {
          ctx.slots.inject('conversation.input.dock', function () {
            return ctx.slots.register({
              name: 'conversation.input.dock',
              id: NAME + '-dock',
              order: 50,
              registrant: NAME
            }, DockComponent)
          })
        } catch (e) { /* 没有这个槽位就只保留每条回复那个 */ }
        // 插件页的配置卡：与 dsh-skill-hub 同一套（plugins.bundle.config 槽位，key = 包名）
        try {
          var SettingsComponent = makeSettingsComponent(React)
          ctx.slots.inject('plugins.bundle.config', function () {
            return ctx.slots.register({
              name: 'plugins.bundle.config',
              key: NAME,
              inject: function () { return {} }
            }, SettingsComponent)
          })
        } catch (e) { /* 没有这个槽位就只保留其余功能 */ }
      }

      return { name: NAME, inject: ['slots'], apply: apply }
    }
  })
})()
