# CODE · dsh-turn-usage 代码走读

这份文档说明**最终版**插件：它由哪些部分组成、每一段代码为什么这么写、违约会付出什么代价。
读法建议：先看第 1 节的数据流，再按第 3 节逐段对照 `lib/client.js`（本节标题里的行号是写本文时的位置、**会随改动漂移**，以函数名/区块名为准；$11369$2544 行））。

---

## 1. 一次渲染发生了什么（数据流）

```
官方 chat store ──useChat(s => s.legacy.nodes)──▶ nodes[]（数组引用稳定）
                                                     │
                                     snapshotTable(nodes)   ← 引用没变就直接复用
                                                     │
                              ┌──────────────────────┴──────────────────────┐
                        byMessage: messageId ▶ info                   byTurn: turn ▶ {buckets, model}
                              │                                              │
                     info.turn（这条回复属于哪一轮）──────────────────────────▶ entry
                              │                                              │
             （节点里没有该轮 usage 时）官方投影 tokenUsage.last ──按 step 折叠──▶ st.costs.get(turn)
                              │
                     costOf(buckets, model, 该轮 node.time)   ← 选生效档 + 峰谷判定 + 单价 + 分桶金额都在这里算
                              │
                  { cny, rate, cnyByBucket, buckets }
                              │
        ┌─────────────────────┴─────────────────────┐
   formatCost(cny) → 行内 `开销 0.2066 ¥`     formatTitle(cost) → 悬停三行明细
```

一句话：**每个回复行只做两次 O(1) 查表 + 一次乘法**，不做任何"扫描全部节点"的活。

---

## 2. 文件与"为什么只有两个 js"

| 文件 | 作用 | 思路 |
|---|---|---|
| `lib/client.js` | 全部逻辑 | 浏览器半边，手写 JS、**无构建步骤**（DSH 插件不需要打包器） |
| `lib/index.js` | Host 半空壳：`export const inject = []; export function apply() {}` | 纯客户端插件不参与 Host；但 `package.json` 的 `main` 指向它，**文件必须存在** |
| `cordis.patch.yml` | `- insert: [{ id: turn-cost, name: dsh-turn-usage }]` | 往插件树插一行，Host 启动时按它加载 |
| `package.json` | `dsh.bundle.patch` + `dsh.client{platform:'web', inject:[…]}` | `inject` 列的是**宿主确实提供**的客户端模块 —— 列错会整块加载失败（见 §4 红线 4） |
| `tests/run_tests.mjs` | 220 项回归 | 用 `node:vm` 沙箱加载 `client.js`，不启动 DSH、不联网 |

---

## 3. 逐段走读

### ① 价格表（第 25–35 行）

```js
var FLASH = { off: { miss: 1, hit: 0.02, out: 4 }, peak: { miss: 2, hit: 0.04, out: 8 } }
var PRO   = { off: { miss: 4.5, hit: 0.15, out: 13.5 }, peak: { miss: 9, hit: 0.3, out: 27 } }
var PRICES = { 'deepseek-flash': FLASH, 'deepseek-v4-flash': FLASH, …, 'deepseek-v4-pro': PRO }
```

- **为什么是人民币原值，而不是"美元价 × 汇率"**：本机真实账单就是 CNY 口径（缓存命中 0.02 / 未命中 1 / 输出 4 元每百万 token）。同类插件里用美元价 + 固定汇率换算的那种，天生对不上账。
- **为什么把 `deepseek-flash` 和旧名都列上**：DSH 0.1.5 把 V4-Flash 路由成**短 id** `deepseek-flash`；价格表里没有它就**静默算成 ¥0**（社区插件 `dsh-cost-line` 就栽在这）。历史会话里的旧 id 也一并保留，免得翻旧会话时算不出来。
- **改价注意**：`off` = 空闲价、`peak` = 高峰价（= 2× 空闲）；改完**同步改测试里的期望值**（¥5.02 / ¥10.04 / ¥18.15）—— 那三行断言就是"这次调价"的记录。

### ② 峰谷窗口（第 36、58–67 行）

```js
var PEAK_WINDOWS_BJ = [[9, 12], [14, 18]]
function isPeak(ms) { if (holidayName(ms)) return false; var d = new Date(ms + 8*3600*1000); if (周六/周日) return false; … }
```

- **为什么手动 +8 小时算"北京时间"**：判定必须与运行机器的本地时区无关（换台机器/改时区就错）。用 UTC 加偏移最稳。
- **窗口是半开区间 `[9,12)`**：12:00 整算空闲、14:00 整算高峰 —— 测试里专门锁了这两个边界。
- **为什么周末一律空闲**：官方 2026-08-23 起周末全天按空闲价。
- **按该轮发生时刻判峰谷**：取该轮最早节点的 `node.time`（不再用"现在"）⇒ 历史轮也算得对。
- `totals` / `node.usage` 仍不带逐样本时间，所以**一轮内**横跨 12:00 / 14:00 切换点仍有秒级偏差（刻意的简化）。
- **节假日**：`holidayName(ms)` 命中 `HOLIDAYS.off` 即整天不算高峰；`work`（调休上班）不影响判定，只备查；超出 `validTo` 整张表失效。

### ③ usage 桶归一（第 70–95 行）

```js
function bucketize(usage) { … pick('uncachedInputTokens','inputTokens','promptTokens','missInputTokens') … }
```

- **为什么要别名容错**：官方节点上是 `uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`，但**字段名猜错的代价是"静默算成 0 / 什么都不显示"，而不是报错** —— 这一条是整件事里最耗时的坑。所以一次性把常见别名（`inputTokens` / `cachedInputTokens` / `completionTokens` …）都认了。
- **为什么缺失按 0 而不是返回 null**：provider 有时只上报部分桶，能算多少算多少，比整轮不显示好。
- **小型踩坑**：`pick()` 的参数遍历**必须从 0 开始**（第一版从 1 开始，等于把标准字段名跳过了 → 全桶归零，测试当场抓到）。

### ④ 计费（第 97–119 行）

```js
function costOf(buckets, modelId, ms) → { model, peak, rate, at, note, cny, cnyByBucket, buckets } | null
```

- **为什么返回这么多东西**：悬停明细要显示「token 量 × 单价 = 金额」三行，所以既有总额 `cny`，也要 `rate`（本次生效的单价）和 `cnyByBucket`（每桶的钱）。一次算完，渲染层不做算术。
- `at` 是实际采用的计价时刻（排查"为什么这轮算高峰"用），`note` 是命中的价目行备注。
- **为什么未收录模型返回 `null`**：宁可**不显示**，也不给一个错数（金额是最容易被误信的东西）。
- **`ms` 必须是"该轮的发生时刻"**：`costOf(buckets, modelId, ms)` 里这个 `ms` 决定选哪一行价、哪一档峰谷；早先版本传的是 `Date.now()`，于是历史轮全按今天的价算（已修）。
- **缓存写入（cacheWrite）按"未命中输入价"计**：DeepSeek 没有对应单价，按同价计最保守（不低估）。

### ⑤ 折叠（第 121–143 行）—— 兜底路径

```js
function accumulate(state, last) { if (state.turn !== last.turn) { state.turn = last.turn; state.steps = {} } state.steps[last.step] = last.buckets }
```

- **为什么是"按 step 覆盖式写入"而不是"累加"**：官方投影的 `last` 是**单步**快照，同一个 step 会因为重渲染/流式更新被反复看到。按 step 当键覆盖 ⇒ **幂等**，重复看到不会重复累加（也不会被 React 严格模式的双渲染坑到）。
- **为什么 turn 变了就清空**：一轮的用量只属于那一轮。
- **它只是兜底**：首选是节点自带的 `node.usage`（见 ⑥）；只有当节点里没有该轮 usage 时才走这里。

### ⑥ 节点读取与形状兼容（第 145–237 行）

| 函数 | 做什么 | 思路 / 踩过的坑 |
|---|---|---|
| `nodesFromChat` | `s.legacy.nodes` → 数组或 `null` | **本机 `useSession` 返回空数组**，节点必须走 `useChat`（官方 StatsPills 同款）；空结果返回 `null`（稳定值） |
| `nodesFromSession` | `s.chat.legacy.nodes` 或 `s.nodes`，空则返回 `EMPTY_NODES` | 退化路径；**空结果必须返回同一个常量引用**（红线 1） |
| `describeNode` | 从一个节点抽出 `{messageId, turn, usage, buckets, model, time}` | 三种 usage 位置都兼容（真机是 `node.usage`；另两种是同类插件写法）；`messageId` 也可能来自 turn-tail 的 `data.closing.finalNode` |
| `modelFromUsage` | `usage.routes[0].model` | 每轮记账里带 provider+model，**能自动认模型**，不用手配 |
| `findNode` | 按 `messageId` 倒着找 | 倒着 = 取最新的那条（同一 id 以最后出现的为准） |
| `sumUsageForTurn` | 把**该轮所有节点**的 usage 求和 | 一轮里往往多次工具调用（多步），只取一条会少算 |
| `modelForTurn` | 只认**该轮**节点上的模型 | **坑**：第一版用"全场最新模型"，于是拿后面轮次的模型给前面的轮计价，金额差 4 倍，被自己的测试抓到 |

### ⑦ 快照表（第 239–268 行）—— 性能关键

```js
var SNAP = { nodes: null, table: null }
function snapshotTable(nodes) { if (SNAP.nodes === nodes) return SNAP.table; …建 byTurn + byMessage… }
```

- **为什么必须缓存**：这个组件是"**每条回复一个实例**"。如果每个实例每次渲染都遍历全部节点，工作量 = 回复条数 × 节点数；而流式更新会让它**频繁重渲染** ⇒ 聊天越长越卡（这就是当时"发一条消息卡几分钟"的根因之一）。
- **为什么按"数组引用"当缓存键**：store 只在真的变化时给出新数组；引用没变就直接复用整张表。
- **为什么一次遍历同时建两张表**：`byTurn`（轮 → 汇总 + 模型）给计价用，`byMessage`（消息 → 节点信息）给"这行属于哪一轮"用。一次 O(n) 换取所有实例 O(1)。
- **`byMessage` 后写覆盖先写**：等价于 `findNode` 的"倒着找最新"。
- **`byTurnTime`**：顺手记下该轮最早的 `node.time`（计价要按"那轮发生的时间"）；节点没带时间就不进这张表，取价时回落 `Date.now()`。

### ⑧ 文案（第 270–309 行）

- `formatCost` → `开销 0.2066 ¥`（用户指定的形制，注意 ¥ 前有空格）。
- `formatRate` → `¥0.02/M`（两位小数）。
- `formatCny` → 常规四位；**四位会舍成 `0.0000` 时退成六位**（免得小额显示成 0，看起来像没算）。
- `formatTitle` → 悬停三行（命中输入 / 未命中输入 / 输出，各 `token 量 × 单价 = 金额`）+ 合计行 + 口径说明 + "估算值，非账单"；缓存写入 >0 时才多一行。

### ⑨ 会话状态（第 311–326 行）

```js
var STATE = new Map()   // sessionId → { fold, costs: Map(turn → cost) }
```

- **为什么按 sessionId 隔离**：切换会话时，两个会话的轮号会重合（都是 turn 1、2、3…）；不隔离就会把 A 会话的金额显示到 B 会话上（测试里专门锁了这条）。
- `resetState()` 同时清 `SNAP`，测试用它做用例隔离。

### ⑩ PURE 导出（第 328–357 行）

把纯函数挂到 `globalThis.__dshTurnCostPure`：
- 只为**测试**服务（沙箱里能直接调这些函数做逐项断言）；
- 浏览器里只是挂了一个对象引用，**不写 DOM、不打日志、不订阅任何东西** —— 零副作用。

### ⑪ 组件（第 362–418 行）

```js
var chatNodes = useChat(hookChat ? nodesFromChat : …)   // hook 顺序在生命周期内稳定
var sessionNodes = hookSession(nodesFromSession)        // 始终调用（保证 hook 顺序不变）
var usage = hookProjection('tokenUsage')
var nodes = chat 有就用 chat，否则 session || EMPTY_NODES
var table = snapshotTable(nodes)                        // ← 先建表
var info = table.byMessage.get(p.messageId)             // ← 再 O(1) 查
```

要点与思路：

1. **hook 调用顺序必须每次一致**：`useChat`（存在才调，props 形状稳定）→ `useSession` → `useProjection`，顺序不打乱；早返回放在 hook 之后。
2. **先建表、后查表**：顺序反了会白遍历。
3. **四种"不显示"**：缺 hook、`messageId` 找不到、该轮没记账、金额为 0 ⇒ 一律 `return null`。**宁可不显示，也不给错数**。
4. **不挂 `ref`**：这一条是血的教训 —— 曾经为了把元素挪到官方「用量」右边而用 `insertBefore` 搬动 React 管理的节点，导致 React 反复修复、**界面卡死几分钟**。现在完全不碰 DOM。
5. **`order: 2` 是纯 CSS 尝试**：只有当本元素恰好是那一排的直接 flex 子项时才生效；不生效也无害（不会报错、不会搬 DOM）。
6. 样式刻意对齐官方那排（13px、tertiary 灰、28px 高、tabular-nums），看起来像同一族。

### ⑫ 模块注册与 apply（第 420–450 行）

```js
window.__ModuleLoader__.load({ id: 'dsh-turn-usage', factory: function (require) {
  var React = require('react')          // 只 require('react')，不碰可选宿主模块
  function apply(ctx, config) { ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({…}, Component)) }
  return { name, inject: ['slots'], apply }
}})
```

- **位置**：槽位 `conversation.chat.assistant-actions`（每条回复的操作行）。
- **`order: 50` 的作用范围**：只在**同一槽位内部**给插件项排序；官方那排的「复制/分支/用量/用时」不是槽位项，**排不到它们之间**（硬约束）。
- **`config.model`**：模型默认从节点自动认，认不出才用它（默认 `deepseek-flash`）。

---

## 4. 三条红线在代码里的落点

| 红线 | 落点 | 违约后果 |
|---|---|---|
| 选择器空结果必须返回**同一常量引用** | `EMPTY_NODES`（39 行）、`nodesFromChat` 返回 `null`（145） | React 判定"数据一直在变" ⇒ **无限重渲染 ⇒ 界面卡死几分钟**；回复越多卡得越狠 |
| **绝不搬动 DOM** | 组件不挂 `ref`、不做 `insertBefore`（不存在这段代码） | React 虚拟树与真实 DOM 不一致 ⇒ **反复修复 ⇒ 整页卡死、新窗口都加载不出会话** |
| 不在每条回复的组件里**遍历全部节点** | `snapshotTable` 缓存（239） | 条数 × 节点数 ⇒ 越用越卡 |

外加一条环境常识：`dsh.client.inject` 里**只列宿主确实提供的模块**；0.1.5 起 `@deepseek-ai/dsh-client-ui-primitives` 不再随 DSH 安装，而客户端 bundle 对未注册模块的 `require()` 会**抛错** ⇒ 一处就让整个客户端半边加载失败、界面什么都不出现。

---

## 5. 常见改法

| 想改什么 | 改哪里 | 别忘了 |
|---|---|---|
| 改价 | 在 `PRICES` **末尾追加一行**（写清 `from`） | 别改老行——历史轮还要按当时的价算；同步改测试期望值 |
| 加/改节假日 | `HOLIDAYS.off`（放假）/ `HOLIDAYS.work`（调休备查）+ 改 `validFrom`/`validTo` | 一律北京时间日期；超期会自动回落"只看周末" |
| 调峰谷窗口 | `PEAK_WINDOWS_BJ` | 半开区间 `[起, 止)`；改完同步改测试 |
| 换默认模型 | `cordis.patch.yml` 同 id 覆盖 `config.model` | 节点能自动认模型时用不到它 |
| 加一种 token 桶 | `bucketize` + `costOf` + `formatTitle` | 三处一起加，否则某一处静默丢数据 |
| 改行内文案 | `formatCost`（270） | 改完跑 `node tests/run_tests.mjs` |
| 想挪位置 | 只能调**槽位 `order`** 或自身 CSS `order` | **不要碰 DOM**；放不到官方按钮之间是插槽机制的硬约束，不是 bug |
| 换通栏位置/样式 | `conversation.input.dock` 的注册 + `makeDockComponent` 的 style | 备选：`conversation.input.left`（紧凑）、`conversation.input.overlay`（浮在输入卡片内） |
| 搜索费单价 | `SEARCH_FEE_CNY`（默认 0.005 = ¥5/1000 次） | 设 0 即只算 token 部分 |
| 搜索路由 | `lib/index.js` 的 `ROUTE_PATH` + 客户端 fetch 的 URL | 两边必须一起改 |
| 想算"整场会话"金额 | 用 `useProjection('tokenUsage').totals` 乘价目 | 那是会话累计，不是本轮 |

---

## 6. 测试与分区的对应（220 项）

| 测试分组 | 覆盖的分区 |
|---|---|
| 峰谷 / 模型 id 归一 | ①② |
| 计价（¥5.02 / ¥10.04 / ¥18.15 / 缓存写入 / 未收录 null） | ④ |
| usage 归一（标准字段 + 别名 + 非对象） | ③ |
| 折叠（两步求和 / 幂等 / 换轮重置） | ⑤ |
| 节点读取（两种 store、两种节点形状、`modelForTurn`、`sumUsageForTurn`） | ⑥ |
| 快照表（多步汇总 / 模型 / `byMessage` / **同数组复用同一张表**） | ⑦ |
| 文案与悬停三行明细（逐行精确匹配、合计 = 三行之和、小额退六位） | ⑧ |
| 组件（出数 / 历史轮 / 兜底折叠 / 四种不显示 / **不挂 ref** / 会话隔离 / 配置生效 / **按该轮时刻计价**） | ⑨⑩⑪ |
| 会话汇总（各轮求和 / 今日只算当天 / 本轮取最新 / 折叠更实时时取大 / 旧轮折叠忽略 / 无 sessionId 不采信） | ⑦⑨ |
| 通栏组件（三段文案 / 价钱在前 / 居中 margin auto / 定宽槽位内居中 / 半透明底衬与描边 / 超 ¥0.5 标红 / 未超标不标红 / 悬停明细 / 空会话不渲染） | ⑨⑫ |
| 生效起止（解析 / 含起不含止 / 后行胜出 / to 过期） | ①② |
| 节假日与有效期（国庆中秋 / 调休 / 超期回落） | ② |

跑法：`node tests/run_tests.mjs`（退出码 0 = PASS；stdout 只有一行结论 + 失败摘要）。

---

## 7. 已知边界（不做什么）

- **估算值，不是账单**；要跟账单对齐只能看余额差（`~/.dsh/.dshw-usage.json`）。
- 按该轮时刻（最早节点）选价；一轮横跨峰谷切换点仍有秒级偏差。
- 只算当前会话；**子代理是独立会话**，不计入父会话这一行。
- 不含余额、每日/历史总账、图表、导出 —— 那些用现成插件（`@kidli1412/dsh-session-cost`、`dsh-usage-chart`）。
- 位置只能待在插件槽位里（插槽机制的硬约束）。
