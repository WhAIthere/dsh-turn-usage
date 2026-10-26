# dsh-turn-usage

DSH Web 插件：在**每条回复的操作行**里显示这一轮花了多少钱；另在**输入框上方**常驻一条居中的 `本轮 0.0123 ¥ · 今日 0.0456 ¥ · 会话 0.7890 ¥`（带半透明底衬与描边；只统计当前打开的会话，切走不渲染、切回来即为最新）。

**搜索开销**：官方 DeepSeek 搜索的模型调用**不进会话账本**，由配套 Host 插件 `dsh-search-audit` 旁路记到 `~/.dsh/search-usage.jsonl`；本插件经 Host 路由 `GET /api/turn-usage/search-usage` 取数，把该轮搜索费标在每条回复后面 `（搜索 0.0180 ¥）`，通栏显示**总价**（对话 + 原生搜索，2 秒轮询），**不单列搜索**——搜索明细放在悬停里。

显示与否由**客户端看到的 `web_search` 工具调用**决定：某轮调过但没拿到记账数据时显示 `（搜索 数据缺失）`（不静默）。记账文件里允许 `source:"estimate"` 的**估算记录**（补装插件之前的历史遗漏），金额照算，`note` 里写明依据。

**归属**：记录自带 `sessionId`（由 dsh-search-audit 在调用时取 `Agent.id`），路由**严格按会话匹配**（没有 sessionId 的旧记录一律不认，否则会挂到每个会话上）。

**「哪一轮搜过」由 Host 读会话事件算**：`session.ownEvents()` 里的 `web/deepseek-search-llm-request` 是权威标记（每次查询一条、不带 turn），把它配给「之前最近的一次 `web_search`/`advanced_search` tool/call」——那个 tool/call 自带 turn。**不要**按 arguments 里的引擎名判断：引擎是插件配置，模型调用时根本不写进 arguments（踩过的坑）。Host 启动会把路由注册结果写进 `~/.dsh/turn-usage-route.log`，排障先看它。

```
复制 · … · 开销 0.2066 ¥ · 分支 · 用量 12.4K tok · 用时 42s · 10:32
```

鼠标悬停可以看到这一轮的分桶明细：

```
命中输入 3,000 × ¥0.02/M = ¥0.0001
未命中输入 1,500 × ¥1.00/M = ¥0.0015
输出 400 × ¥4.00/M = ¥0.0016
合计 0.0032 ¥ · deepseek-flash · 空闲时段
高峰＝工作日北京时间 09:00–12:00、14:00–18:00；周末全天空闲
估算值，非账单
```

## 安装 / 卸载

```powershell
# 安装（已注册过就跳过，直接重启）
dsh.cmd plugin --profile desktop add "C:\Users\57870\Desktop\753\0-ds_harness_0\tool\dsh-turn-cost"
dsh.cmd plugin --profile web     add "C:\Users\57870\Desktop\753\0-ds_harness_0\tool\dsh-turn-cost"

# 改过代码 / 刚从市场里打开：必须重启 dsh web，然后浏览器 Ctrl+Shift+R
# 卸载
dsh.cmd plugin --profile desktop remove dsh-turn-usage
dsh.cmd plugin --profile web     remove dsh-turn-usage
```

不需要 API key、不需要改 settings。

## 配置（可选）

模型默认从节点数据自动认（`usage.routes` / `provenance.model`），认不出才用默认值 `deepseek-flash`。
要强制指定：在 profile 的 `cordis.patch.yml` 里同 id 覆盖

```yaml
- id: turn-cost
  config:
    model: deepseek-v4-pro
```

## 单测

```powershell
node tests/run_tests.mjs      # 220 项断言，退出码 0 = PASS
```

## 边界（请先读）

| 项 | 说明 |
|---|---|
| 数据 | 只读官方会话节点（`node.usage`）与官方投影，**不写盘、不联网、不改任何数据** |
| 范围 | 显示**该轮**花费（一轮多步会求和）；翻回去看历史轮同样有值（只要节点还加载着） |
| 通栏 | 输入框上方**居中**常驻「本轮 · 今日 · 会话」，带半透明底衬+描边、用二级文字色；金额**价钱在前**（`0.0123 ¥`）与每条回复一致；数值在各自**定宽区间内居中**（左右余白对称、进位不挤动邻居）；**单轮 > ¥0.5 时「本轮」转红**；**只算当前打开的会话**，子代理不计入 |
| 精度 | 估算值，非账单；按**该轮发生时刻**（`node.time`）选价，只有一轮正好跨峰谷切换点时才有偏差 |
| 模型 | 从节点自动认；认不出用默认值；价格表未收录的模型不显示（绝不按 0 计） |
| 价目 | 表在 `lib/client.js` 的 `PRICES`，每行带**生效起止**；改价在末尾追加一行即可，历史轮仍按当时的价 |
| 节假日 | 内置 2026 全年（`HOLIDAYS`，带有效期）：周末与法定节假日全天算空闲；超期自动回落成"只看周末" |
| 搜索 | 只统计**原生 DeepSeek 搜索**（server tool）的模型 token + 每次 ¥0.005 搜索费；free-search 等工具本来就在会话账本里，不重复计 |
| 位置 | 只能待在**插件槽位**里（「复制」与「分支」之间），靠 `order` 在本槽位内部排序；**不搬 DOM** |
| 不含 | 余额、每日/历史统计、子代理（子代理是独立会话） |

原理、踩坑与三条自我约束 → `DESIGN.md`；**逐段代码走读（每段为什么这么写）→ `CODE.md`**。


## 配置（插件页 · 插件管理 → dsh-turn-usage）

| 开关 | 默认 | 关掉之后 |
|---|---|---|
| `chip` | 开 | 不在每条回复末尾显示本轮开销 |
| `dock` | 开 | 不在输入框上方显示通栏 |
| `search` | 开 | 不把原生搜索费用并入（括号与通栏都不含搜索） |

开关值存在 `~/.dsh/turn-usage.json`；插件页那张卡通过 `GET`/`POST /api/turn-usage/config` 读写，改动**立刻生效**（客户端本地先改，再异步回写文件）。


## 统计口径（为什么"会话/今日"是准的）

- **本轮**：客户端节点，即时。
- **会话**：Host 读内存里该会话的**完整事件**（`ownEvents()`）逐轮求和 —— 不受"客户端只加载了多少节点"影响。
- **今日**：**本会话今天**花了多少（从本会话的用量行里按北京日期过滤）——不是"今天所有会话"。
- 账本 `~/.dsh/turn-usage-ledger.jsonl` 仍然每轮落一行（跨重启留档），但通栏的「今日」不读它。
- 客户端把 Host 给的数与本地算的取**较大值**；Host 不可用时自动退回纯客户端计算。
- **按会话隔离**：Host 合计带着会话 id，只有和当前会话一致才采用（之前没校验，切会话会一直显示旧数）；切会话立刻重拉，之后每 5 秒刷新；Host 用 `session.seq` 缓存抠出来的行，5 秒轮询也不重复算。


## 节假日覆盖文件（不用重发版）

内置表只到 2026。之后每年公布后，把法定节假日写进 `~/.dsh/turn-usage-holidays.json` 即可：

```json
{ "2027-02-06": "春节", "2027-02-07": "春节", "2027-04-05": "清明" }
```

- 只需列**放假日**（DeepSeek 的峰谷不看调休，调休上班日按假期低谷价算）；
- 键必须是 `YYYY-MM-DD`（北京时间），值是显示用的名称；
- Host 读它并随 `/api/turn-usage/config` 下发，客户端 30 秒内自动生效。


## 拓展（需要额外数据源，不可用则置灰）

| 拓展 | 前置 | 作用 |
|---|---|---|
| 搜索精确统计 | `dsh-search-audit` 且它的记账文件非空 | 把原生 DeepSeek 搜索费用并入总价 |
| 全面统计（外部统计源） | 尚未实现 | 预留给 agent 接入，补齐子 agent / 子会话等不可见开销 |

可用性由 Host 探测（`/api/turn-usage/config` 的 `available` 字段），客户端据此决定复选框是否可勾。


## 给 agent 的接口（没有 skill，只有这三个约定）

本插件不需要 skill：agent 只要知道下面三个数据位置即可参与统计。

| 位置 | 方向 | 用途 |
|---|---|---|
| `GET /api/turn-usage/totals?session=<id>` | 读 | 返回 `{session:[{turn,ts,model,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}],today:[…]}`，Host 从内存会话事件算出，任何统计脚本可直接消费 |
| `~/.dsh/turn-usage-external.json` | 写 | `{"sessions":{"<sessionId>":1.23}}`；写了之后「全面统计」选项变可用，勾选即把该会话金额并进「会话」 |
| `~/.dsh/turn-usage-holidays.json` | 写 | `{"2027-02-06":"春节"}`；法定放假日，DeepSeek 峰谷不看调休 |

另外两条只读数据线：`~/.dsh/turn-usage.json`（开关）与 `~/.dsh/turn-usage-ledger.jsonl`（每轮一行 `{s,t,ts,model,in,out,hit,w}`，跨重启累积）。
