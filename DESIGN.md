# DESIGN · dsh-turn-usage

## 1. 目标

在 DSH Web **每条回复的操作行**里显示这一轮的花费，一眼可见；轻、稳、不干扰别的东西。

**非目标**：余额、每日/历史总账、图表、导出。

## 2. 挂在哪里

两个槽位，都只用官方预留的插槽（**不碰 DOM**）：

- **`conversation.input.dock`**（`kind: 'list'`）：输入框卡片**上方一条常驻通栏**，**居中**显示 `本轮 x ¥ · 今日 y ¥ · 会话 z ¥`（价钱在前；底衬=半透明 hover 色 + L3 描边、文字用二级色；右侧留给"小鲸鱼"控件；数值在各自定宽区间内**居中**（底衬左右对称）、进位不抖；**「本轮」> ¥0.5 转警示红**）；
- **`conversation.chat.assistant-actions`**（`kind: 'list'`, `scope: 'session'`）：每条回复操作行里这一轮的钱。
官方那排（`MessageIconActions`）的孩子是写死的：

```js
children: [
  clockEl?,            // 有时左侧有时间
  <复制>,
  extraActions,        // ← 插件槽位的全部内容（我们的元素就在这里）
  <分支>,
  …,
  usageAction,         // ← 官方「用量」chip
  clockEl              // ← 官方「用时」
]
```

所以：

- 我们的元素**固定出现在「复制」与「分支」之间**；
- `order`（槽位注册参数）**只在同一个槽位内部**给多个插件项排序 —— 它**无法**把元素排到官方按钮之间，因为那些按钮不是槽位项；
- 还有一条纯 CSS 的 `order: 2`（flex 属性），只有当我们的元素恰好是那一排的直接 flex 子项时才生效；不生效也无害。

**为什么不做 DOM 搬移**：曾经为了"紧挨用量右边"用 `insertBefore` 搬动 React 渲染的节点 ⇒ React 发现虚拟树与真实 DOM 不一致，反复尝试修复 ⇒ **界面卡死几分钟，连新窗口都加载不出会话**。删掉后一切正常。结论：**加自己的东西安全，搬 React 的东西危险。**

## 3. 数据从哪来（三次试错的结论）

| 需要 | 来源 | 备注 |
|---|---|---|
| 会话节点 | **`useChat(s => s.legacy.nodes)`** | 官方 `StatsPills` 同款。**本机 `useSession(...)` 返回空数组**，不能用 |
| 每条回复属于哪一轮 | 节点上 `kind === 'assistant'` + `messageId` → `node.turn` | 与 `dsh-usage-chart` 的定位方式一致 |
| 该轮用量 | **`node.usage`**，把该轮**所有节点求和** | 官方 `assistantStepReading(node)` 读的就是 `node.usage`；官方 `deriveStats` 也是按节点累加 |
| 模型 | `usage.routes[0].model` → `provenance.model` → `requestConfig.model` → 配置默认值 | routes 里带 provider+model |
| 该轮的发生时刻 | 节点上的 **`node.time`**（取该轮最早者） | 计价按它选「生效档 + 峰谷档」；与 `dsh-usage-chart` 取 `startedAt` 同源 |
| 兜底 | 官方 `useProjection('tokenUsage')` 的 `last`（单步）按 step 折成当前轮 | 只在节点没有 usage 时用 |

字段名做过容错（`inputTokens` / `cachedInputTokens` / `completionTokens` 等别名都认），因为字段名猜错的代价是"静默算成 0"。

## 4. 两个实现要点

**(a) 折叠幂等**：兜底路径用 `steps[step] = buckets` 覆盖式写入，重复渲染不会重复累加。

**(b) 快照表（性能关键）**：组件是"每条回复一个实例"，如果每个实例每次渲染都遍历全部节点，工作量 = 条数 × 节点数，聊天越长越卡。所以按**节点数组引用**建一次表：

```js
snapshotTable(nodes) → { byTurn, byMessage, byTurnTime: Map(turn → 该轮最早时刻) }
```

数组引用没变就直接复用（`SNAP.nodes === nodes`），变了才重建一次。

## 5. 计价

元 / 百万 token，**表在 `lib/client.js` 的 `PRICES`**：每行 = 一组模型 + 一个生效时段 + 空闲/高峰两档（`{ models, from, to, off, peak, note }`）。

| 模型 id | 未命中输入（空闲/高峰） | 缓存命中（空闲/高峰） | 输出（空闲/高峰） |
|---|---:|---:|---:|
| `deepseek-flash`（DSH 0.1.5 实际路由短 id）及 `deepseek-v4-flash`、`deepseek-v41-flash`、`deepseek-chat`、`deepseek-reasoner` | 1 / 2 | 0.02 / 0.04 | 4 / 8 |
| `deepseek-v4-pro` | 4.5 / 9 | 0.15 / 0.3 | 13.5 / 27 |

- **高峰**：工作日北京时间 09:00–12:00、14:00–18:00（半开区间），= 空闲 × 2；**周末与法定节假日全天算空闲**。用 UTC+8 手工换算，与机器时区无关。
- **id 归一**：精确优先，其次名称边界前缀（`deepseek-v4-flash-2026-01` → `deepseek-v4-flash`）；`deepseek-v99` 这种不误认，判为未收录并**不显示**。
- **缓存写入**：DeepSeek 无对应单价，按未命中输入价计。
- **按该轮发生时刻选档**（节点上的 `node.time`，取该轮最早者），不是按"现在"——所以翻回历史轮也算得对（这是先前版本的硬伤）。
- **生效起止**（`from` / `to`，北京时间，含起不含止）：同一模型可有多行，**后出现的胜出** ⇒ 改价只需在末尾追加一行，老行留给历史轮。
- **节假日**：`HOLIDAYS` 内置 2026 全年（带 `validFrom` / `validTo`，**超期自动回落成"只看周末"**）；调休上班日官方不认，仍按普通周末算。
- ⚠️ `deepseek-v4-pro` **不采信** 2 区 `prices.txt` 里"2026-09-14 12:00 并入 flash"的记录（官网仍是独立原价）。真要调价，追加一行即可。
- 一轮的多个 step 若横跨峰谷切换点，现按该轮最早时刻统一取价 ⇒ 仍有秒级偏差（刻意的简化）。
- **搜索开销另记一笔**：官方 DeepSeek 搜索是自己 fetch 的独立 LLM 调用、响应 usage 被丢弃（详见 skill/工作区记忆的实证）。配套 Host 插件 `dsh-search-audit` 用 fetch 包装把它落到 `~/.dsh/search-usage.jsonl`；本插件的 Host 半边只读该文件并暴露 `GET /api/turn-usage/search-usage?from=`，客户端每 2 秒轮询、按「轮起始时刻」把记录归到各轮，金额 = token（按记录自己的 ts 折价）+ 每次 ¥0.005 搜索费（`SEARCH_FEE_CNY`，设 0 即只算 token）。

## 6. 三条自我约束（每条都是血的教训）

1. **hook 选择器的空结果必须是同一个常量引用**（`EMPTY_NODES`）。
   返回新建的 `[]` ⇒ React 认为数据一直在变 ⇒ **无限重渲染 ⇒ 界面卡死**；而且每条回复一个实例，聊天越长卡得越狠。
2. **绝不搬动 DOM**（见 §2 末）。
3. **不要在"每条回复"的组件里遍历全部节点**（见 §4b）。

另有一条环境常识：0.1.5 起 `@deepseek-ai/dsh-client-ui-primitives` 不再随 DSH 安装，而客户端 bundle 对未注册模块的 `require()` 会**抛错** —— 一处就够让整个客户端半边加载失败、界面什么都不出现。本插件只 `require('react')`。

## 7. 验证

`node tests/run_tests.mjs`（**220 项**，退出码 0 = PASS）。做法：把 `lib/client.js` 放进 `node:vm` 沙箱、伪造 `window.__ModuleLoader__` 捕获模块，然后断言：

- **纯函数**：峰谷（含 12:00 / 14:00 半开边界、周末）、id 归一、计价（¥5.02 / ¥10.04 / ¥18.15、缓存写入价、未收录返回 null）、usage 归一（真机字段 + 别名）、折叠幂等、节点读取与快照表复用（含"空结果引用稳定"这条回归锁）、文案与悬停三行明细。
- **模块**：注册 id、`inject`、`apply` 注册到 `conversation.chat.assistant-actions`、`order` 为正。
- **组件**：金额 = 该轮求和 × 价目；历史轮用该轮模型；无 usage 时退回投影折叠；缺 hook / 找不到 messageId / 空节点 / 零用量 ⇒ 返回 null；**不挂 ref（不碰 DOM）**；会话隔离；配置 model 生效。
- **按该轮时刻计价**：同一份用量放进高峰 / 空闲 / 法定节假日三种时刻的轮里，金额各不相同（锁住"不按现在算"）。
- **生效起止**：`bjToMs` 解析、切换点含起不含止、多行命中后行胜出、`to` 过期失效（临时 push 行做，用完还原）。
- **节假日与有效期**：国庆 / 中秋 10:00 不收高峰、节假日名、调休上班日仍算空闲、超出 `validTo` 回落成工作日判定。

金额断言用 `pure.costOf(..., Date.now())` 现算，所以与"跑测试时是否高峰"无关。

## 7.5 估算记录（补历史）

装插件之前发生的原生搜索没有任何记录，界面上只能显示"数据缺失"。补法是往 `~/.dsh/search-usage.jsonl` 手工追加记录：

- **请求数是真算的**：从该会话 `web/deepseek-search-llm-request` 事件数出来（与 Host 的 `nativeCallsFromEvents` 同一套归属规则）；
- **token 是估的**：每请求 ≈ 9k 输入 / 760 输出（按官方小时桶与本地日志的差额反推）；
- 必须带 `sessionId`、`source:"estimate"`、`note`，金额照常参与计算（通栏/括号里与实测数据同表）。

2026-10-19 实测：18 次请求（12 + 6）估出 ¥0.4434，官方小时桶差额 ¥0.4586，差 3%。

## 7.6 功能开关（配置页）

三个开关：`chip`（每条回复末尾）、`dock`（输入框上方通栏）、`search`（是否并入原生搜索费用）。默认全开 = 旧行为。

- **配置在哪**：插件行的 `config`（`cordis.patch.yml` / 插件管理的表单）。Host 的 `apply(ctx, config)` 拿到后归一成布尔值，`resolveConfig` 对坏值一律回默认，绝不抛。
- **客户端怎么读**：**客户端那半拿不到插件 config**（实测 `dsh-usage-chart` 的客户端 `apply(ctx)` 只收 ctx），所以由 Host 暴露 `GET /api/turn-usage/config`，客户端 30 秒轮询一次；若 loader 恰好也把 config 传给了客户端，则 `apply` 里同步生效，避免首屏闪烁。
- **关掉不等于卸载槽位**：组件仍然注册，只是渲染 `null`——这样开关改完能立刻生效，不需要重注册槽位。
- **为什么不导出 `Config`**：Cordis 4 的 `Config` 必须是它自己的 Schema 实例（`Schema.object()`，内部用 `@standard-schema/spec`）。本包不 bundling、profile 里也没有 `@deepseek-ai/cordis`；手写「可调用 + `toJSON()` + `~standard.validate`」的副本实测**两次都被拒绝激活**（第一次报 `reading 'validate'`，第二次仍未通过）。已彻底放弃这条路。
- **实际做法**：客户端往 `plugins.bundle.config` 槽位注册自己的卡片（`key` = 包名，与 `dsh-skill-hub` 同一套机制），开关值存 `~/.dsh/turn-usage.json`；Host 的 `GET/POST /api/turn-usage/config` 读写它。不经过任何 schema 校验，因此不会影响插件激活。
- 卡片不用官方 `PluginSettingsCard`（避免 require 未注册模块），直接用 checkbox + 主题变量自己画。

## 8. 文件结构

```
tool/dsh-turn-cost/
├── package.json          # dsh.bundle.patch + dsh.client（platform=web, inject 三个官方模块）
├── cordis.patch.yml      # 往插件树插一行 { id: turn-cost, name: dsh-turn-usage }
├── lib/
│   ├── index.js          # Host 半：空实现（纯客户端插件），main 指向它所以必须存在
│   └── client.js         # 全部逻辑（纯函数区 + 槽位组件）
├── tests/run_tests.mjs   # 一键回归
├── README.md             # 路由：用途 / 安装 / 配置 / 边界
└── DESIGN.md             # 本文件
```

## 9. 已知边界

- 估算值，非账单（要跟账单对齐只能看余额差 `~/.dsh/.dshw-usage.json`）。
- 按该轮发生时刻（最早节点）选价；一轮若横跨峰谷切换点仍有秒级偏差。
- 搜索费的 ¥0.005/次 是按官方"search 每千次 ¥5"折算的**假设**；若官方对 server tool 不计这笔费，把 `SEARCH_FEE_CNY` 设 0 即可。
- **显示判据**：**Host 读会话事件**（`session.ownEvents()`）里的 `web/deepseek-search-llm-request`（每次查询一条、data 无 turn），配给「之前最近的一次 `web_search`/`advanced_search` tool/call」，用后者的 turn 定轮 —— 这是权威判定。客户端只在拿不到服务端数据时退回节点扫描。
- **别按 arguments 判断引擎**：引擎是插件配置，模型调用时不会写进 arguments（真实调用参数只有 `{"queries":[...]}`），按它判断会漏掉全部原生搜索。
- **会话必须严格匹配**：缺少 `sessionId` 的旧记录一律不认，否则时间窗会把它挂到**每个**会话的最后一轮（实测：所有会话都显示同一个 0.018）。
- **工具节点形状容错**：名字可能扁平或在 `data` 里；`turn` 缺失时用节点 `time` 反推所属轮。
- Host 半边用 **`inject: [\x27webServer\x27]` 硬依赖**（不是 `ctx.get` 判空）——否则启动竞态会让 apply 静默跳过、路由根本没注册。启动自检写 `~/.dsh/turn-usage-route.log`，排障第一步看它。
- 搜索归属按时间窗推断（轮起始时刻），同一分钟内搜索与轮次交错的极端情况可能归错一轮。
- 只算当前会话；子代理是独立会话不计入。
- 位置只能待在槽位里（这是插槽渲染器的硬约束，不是 bug）。

## 10. 沿革（为什么代码长这样）

1. 第一版挂 `conversation.composer.dock`（输入框下方那一带）→ 这套 UI 里用户根本看不到那一带，插件装了没反应；
2. 改挂 `assistant-actions`，但用 `useSession` 取节点 → 本机返回空数组，什么都算不出来；
3. 改用 `useChat` 取节点 → 拿到了节点，但找错了字段（找 `data.tokenUsage`，真机是 `node.usage`）；
4. 修好字段 → 出数了，但"每条回复 × 全部节点"重算导致卡顿 ⇒ 加快照表；
5. 为挪位置搬 DOM ⇒ **界面卡死几分钟** ⇒ 删掉搬 DOM 与全部调试代码，定稿为现在这样。
6. 价目表从「静止表 + 按当前时刻判峰谷」改成「带生效起止的行 + 按**该轮时刻**选档 + 2026 节假日表」——修掉"历史轮按今天价算"的根因，并留好以后改价的接口。
7. 加常驻通栏（`conversation.input.dock`）显示「本轮 · 今日 · 会话」，**居中**摆放（右侧是小鲸鱼控件的地盘），数值槽位预留固定宽度（进位不挤动邻居）。只统计**当前打开的会话**——切走不渲染、切回来重算即为最新，不做跨会话、不开 Host 半边。
