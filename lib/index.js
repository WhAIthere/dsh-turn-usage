/**
 * dsh-turn-usage · Host 半边
 *
 * 职责：把浏览器读不到的东西通过两条只读 HTTP 路由交出去。
 *
 * 1) `GET /api/turn-usage/search-usage?from=<epochMs>&session=<id>`
 *    → { records: [...], calls: [{turn,count}], total, returned }
 * 2) `GET /api/turn-usage/config`
 *    → { chip, dock, search }   （功能开关，来自插件行 config）
 *
 * 只回传 `ts >= from` 的记录（客户端用该会话最早的轮次时刻当 from），最多 1000 条。
 * 本半边**不折算金额**（价格表只在客户端 `lib/client.js` 一处），也**不主动写任何文件**
 * （除 `~/.dsh/turn-usage-route.log` 这一行启动自检）。
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-turn-usage'
// 硬依赖：Cordis 会等 webServer 就绪后再调 apply。
// （之前用 ctx.get('webServer') 判空 → 启动竞态里静默跳过，路由根本没注册上。）
export const inject = ['webServer']

export const ROUTE_PATH = '/api/turn-usage/search-usage'
export const CONFIG_PATH = '/api/turn-usage/config'
const MAX_RECORDS = 1000

/** 功能开关的默认值（三个显示开关全开 = 旧行为；extFull 是预留的扩展位）。 */
export const DEFAULT_CONFIG = { chip: true, dock: true, search: true, extFull: false }

/** 把插件行的 config 归一成布尔值；坏值一律回默认，绝不抛。 */
export function resolveConfig(raw) {
  var out = {
    chip: DEFAULT_CONFIG.chip, dock: DEFAULT_CONFIG.dock,
    search: DEFAULT_CONFIG.search, extFull: DEFAULT_CONFIG.extFull
  }
  if (!raw || typeof raw !== 'object') return out
  var keys = ['chip', 'dock', 'search', 'extFull']
  for (var i = 0; i < keys.length; i++) {
    var v = raw[keys[i]]
    if (typeof v === 'boolean') out[keys[i]] = v
  }
  return out
}

// 当前生效的开关（启动时读配置文件，插件页的开关写回文件）
let CFG = resolveConfig(null)
export function currentConfig() { return CFG }

/**
 * ⚠️ 这里**故意不导出 `Config`**。
 *
 * Cordis 4 要求插件的 `Config` 是它自己的 Schema 实例（`Schema.object(...)`，内部依赖
 * `@standard-schema/spec`）。本包不 bundling、profile 里也没有 `@deepseek-ai/cordis`，
 * 手写的「可调用 + toJSON + `~standard`」副本仍会在激活阶段报错并**拒绝激活插件**（实测两次）。
 * 所以改用另一条路：客户端往 `plugins.bundle.config` 槽位注册自己的配置卡
 * （`dsh-skill-hub` 就是这么做的），开关值存 `~/.dsh/turn-usage.json`。
 */

/** 开关文件：`~/.dsh/turn-usage.json`（插件页写它）。 */
export function configPath() {
  const env = process.env.DSH_TURN_USAGE_CONFIG
  return (typeof env === 'string' && env.length > 0) ? env : join(homedir(), '.dsh', 'turn-usage.json')
}

/** 读开关文件；缺文件/坏 JSON 一律回默认（绝不抛）。 */
export function readConfigFile() {
  try {
    return resolveConfig(JSON.parse(readFileSync(configPath(), 'utf8')))
  } catch (e) {
    return resolveConfig(null)
  }
}

/** 写开关文件；失败返回 false。 */
export function writeConfigFile(cfg) {
  try {
    writeFileSync(configPath(), JSON.stringify(resolveConfig(cfg), null, 2) + '\n', 'utf8')
    return true
  } catch (e) {
    return false
  }
}

/** 节假日覆盖文件：`~/.dsh/turn-usage-holidays.json`，形如 `{"2027-02-06":"春节"}`。 */
export function holidaysPath() {
  const env = process.env.DSH_TURN_USAGE_HOLIDAYS
  return (typeof env === 'string' && env.length > 0) ? env : join(homedir(), '.dsh', 'turn-usage-holidays.json')
}

/** 搜索扩展是否可用：`dsh-search-audit` 的记账文件存在且有内容。 */
export function searchDataAvailable() {
  try {
    return statSync(logPath()).size > 0
  } catch (e) {
    return false
  }
}

/** 外部统计源（agent 接入点）：`~/.dsh/turn-usage-external.json`，形如 `{"sessions":{"<id>":1.23}}`。 */
export function externalStatsPath() {
  const env = process.env.DSH_TURN_USAGE_EXTERNAL
  return (typeof env === 'string' && env.length > 0) ? env : join(homedir(), '.dsh', 'turn-usage-external.json')
}

/** 读外部统计源；缺文件/坏 JSON 一律回空对象。 */
export function readExternalStats() {
  try {
    const raw = JSON.parse(readFileSync(externalStatsPath(), 'utf8'))
    if (!raw || typeof raw !== 'object') return { sessions: {} }
    const out = {}
    const src = (raw.sessions && typeof raw.sessions === 'object') ? raw.sessions : {}
    for (const id of Object.keys(src)) {
      const v = Number(src[id])
      if (typeof id === 'string' && id.length > 0 && isFinite(v) && v >= 0) out[id] = v
    }
    return { sessions: out }
  } catch (e) {
    return { sessions: {} }
  }
}

/** 读覆盖表（`YYYY-MM-DD` → 名称）；坏值/缺文件一律回空对象。 */
export function readHolidays() {
  try {
    const raw = JSON.parse(readFileSync(holidaysPath(), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const key of Object.keys(raw)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
      const label = raw[key]
      out[key] = (typeof label === 'string' && label.length > 0) ? label : '节假日'
    }
    return out
  } catch (e) {
    return {}
  }
}


/** 搜索记账文件的落盘位置（与 dsh-search-audit 同一个默认值，可用环境变量一起改）。 */
export function logPath() {
  const env = process.env.DSH_SEARCH_AUDIT_LOG
  return (typeof env === 'string' && env.length > 0) ? env : join(homedir(), '.dsh', 'search-usage.jsonl')
}

/** JSONL → 记录数组；坏行直接跳过（文件可能正在被追加写入）。 */
export function parseJsonl(text) {
  const out = []
  if (typeof text !== 'string' || text.length === 0) return out
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.length === 0) continue
    let rec
    try { rec = JSON.parse(line) } catch (e) { continue }
    if (rec && typeof rec === 'object' && typeof rec.ts === 'number') out.push(rec)
  }
  return out
}

/** 只保留 ts >= from 的最近 cap 条（按时间升序返回）。 */
export function filterRecords(records, from, cap) {
  const limit = (typeof cap === 'number' && cap > 0) ? cap : MAX_RECORDS
  const lo = (typeof from === 'number' && isFinite(from)) ? from : 0
  const picked = []
  for (let i = records.length - 1; i >= 0 && picked.length < limit; i--) {
    const rec = records[i]
    if (!rec || typeof rec.ts !== 'number' || rec.ts < lo) continue
    picked.push(rec)
  }
  picked.reverse()
  return picked
}

/**
 * 按会话过滤。**严格匹配**：给了 session 就只返回 sessionId 完全相同的记录。
 * 没有 sessionId 的旧记录一律不认——否则它会按时间窗挂到**每一个**会话上（实测 bug：所有会话最后一轮都显示 0.018）。
 */
export function filterBySession(records, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return records
  const out = []
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    if (rec.sessionId !== sessionId) continue
    out.push(rec)
  }
  return out
}

// 文件很小（每条 ~300B），但仍按 mtime+size 缓存，避免每次轮询都重读
let CACHE = { mtime: -1, size: -1, records: [] }

/** 读文件（带缓存）。文件不存在 → 空数组，绝不抛。 */
export function loadRecords() {
  const file = logPath()
  let st
  try { st = statSync(file) } catch (e) { return [] }
  if (st.mtimeMs === CACHE.mtime && st.size === CACHE.size) return CACHE.records
  let records = []
  try { records = parseJsonl(readFileSync(file, 'utf8')) } catch (e) { records = [] }
  CACHE = { mtime: st.mtimeMs, size: st.size, records: records }
  return records
}

export function resetCache() { CACHE = { mtime: -1, size: -1, records: [] } }

/**
 * 从会话事件里算出「每轮的原生搜索请求数」。
 *
 * 权威标记是官方插件 append 的 `web/deepseek-search-llm-request` 事件（每次查询一条，
 * 且 data 里没有 turn）。归属办法：每条搜索请求配给**它之前最近的一次搜索类 tool/call**
 * （`web_search` / `advanced_search`），那个 tool/call 自带 turn —— 因此不需要猜引擎配置。
 */
export function nativeCallsFromEvents(events) {
  var calls = []
  var requests = []
  if (!Array.isArray(events)) return new Map()
  for (var i = 0; i < events.length; i++) {
    var e = events[i]
    if (!e || typeof e !== 'object') continue
    var at = (typeof e.time === 'number') ? e.time : null
    if (e.type === 'tool/call' && e.data && typeof e.data.turn === 'number') {
      var name = e.data.name
      if (name === 'web_search' || name === 'advanced_search') calls.push({ turn: e.data.turn, time: at })
    } else if (typeof e.type === 'string' && e.type.indexOf('deepseek-search') !== -1) {
      requests.push({ time: at })
    }
  }
  calls.sort(function (a, b) { return (a.time === null ? 0 : a.time) - (b.time === null ? 0 : b.time) })
  var out = new Map()
  for (var k = 0; k < requests.length; k++) {
    var reqAt = requests[k].time
    if (reqAt === null) continue
    var owner = null
    for (var j = 0; j < calls.length; j++) {
      if (calls[j].time !== null && calls[j].time <= reqAt) owner = calls[j].turn
      else if (calls[j].time !== null) break
    }
    if (owner === null) continue
    out.set(owner, (out.get(owner) || 0) + 1)
  }
  return out
}

// 会话事件可能几千条：**一次遍历**抠出「每轮用量行 + 每轮原生搜索次数」，按 seq 缓存。
// 缓存保留最近 4 个会话 —— 切走再切回来不再重算（这就是"进会话像重新统计一遍"的根源）。
let ANALYSIS_CACHE = new Map()

/** 分析一个 live 会话（缓存命中直接返回）。 */
export function analysisOf(live, sessionId) {
  const seq = (live && typeof live.seq === 'number') ? live.seq : -1
  const hit = ANALYSIS_CACHE.get(sessionId)
  if (hit && hit.seq === seq) return hit
  let rows = []
  let calls = []
  try {
    const events = (live && typeof live.ownEvents === 'function') ? live.ownEvents() : []
    rows = turnRowsFromEvents(events)
    nativeCallsFromEvents(events).forEach(function (count, turn) { calls.push({ turn: turn, count: count }) })
  } catch (e) { rows = []; calls = [] }
  const out = { seq: seq, rows: rows, calls: calls, fresh: true }
  ANALYSIS_CACHE.set(sessionId, out)
  if (ANALYSIS_CACHE.size > 4) ANALYSIS_CACHE.delete(ANALYSIS_CACHE.keys().next().value)
  return out
}

/** 取某个会话的「每轮原生搜索次数」；会话不在内存里就给空数组（不猜）。 */
export function searchCallsOf(sessionsService, sessionId) {
  if (!sessionsService || typeof sessionsService.get !== 'function') return []
  if (typeof sessionId !== 'string' || sessionId.length === 0) return []
  let live
  try { live = sessionsService.get(sessionId) } catch (e) { return [] }
  if (!live) return []
  try {
    return analysisOf(live, sessionId).calls
  } catch (e) {
    return []
  }
}

function sendJson(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

// ═════════ Host 侧预算：从会话事件抠每轮用量，落账本，客户端直接用 ═════════

export const TOTALS_PATH = '/api/turn-usage/totals'

/** 北京时间日期键 'YYYY-MM-DD'。 */
export function bjDayKey(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return ''
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 从会话事件里抠出「每轮用量行」（同一轮多条 assistant/message 合并）。
 * 只给 token 桶，**不折钱**——价格表只在客户端一处。
 */
export function turnRowsFromEvents(events) {
  const byTurn = new Map()
  if (!Array.isArray(events)) return []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (!e || e.type !== 'assistant/message') continue
    const d = e.data || {}
    const u = d.usage
    if (!u || typeof u !== 'object' || typeof d.turn !== 'number') continue
    let row = byTurn.get(d.turn)
    if (!row) {
      const routes = u.routes
      const model = (Array.isArray(routes) && routes[0] && routes[0].model) ||
        (d.message && d.message.source && d.message.source.model) || null
      row = {
        turn: d.turn,
        ts: (typeof e.time === 'number') ? e.time : null,
        model: model,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0
      }
      byTurn.set(d.turn, row)
    }
    row.inputTokens += (u.inputTokens || 0)
    row.outputTokens += (u.outputTokens || 0)
    row.cacheReadTokens += (u.cacheReadTokens || 0)
    row.cacheWriteTokens += (u.cacheWriteTokens || 0)
    if (row.ts === null && typeof e.time === 'number') row.ts = e.time
  }
  const out = []
  byTurn.forEach(function (r) { out.push(r) })
  out.sort(function (a, b) { return a.turn - b.turn })
  return out
}

/** 账本文件：每轮一行，跨重启累积（`today` 就靠它）。 */
export function ledgerPath() {
  const env = process.env.DSH_TURN_USAGE_LEDGER
  return (typeof env === 'string' && env.length > 0) ? env : join(homedir(), '.dsh', 'turn-usage-ledger.jsonl')
}

let LEDGER_CACHE = { mtimeMs: -1, size: -1, rows: [] }

/** 读账本（按 mtime+size 缓存，坏行跳过）。 */
export function readLedger() {
  try {
    const st = statSync(ledgerPath())
    if (LEDGER_CACHE.mtimeMs === st.mtimeMs && LEDGER_CACHE.size === st.size) return LEDGER_CACHE.rows
    const rows = []
    const lines = readFileSync(ledgerPath(), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.length === 0) continue
      let r
      try { r = JSON.parse(line) } catch (e) { continue }
      if (r && typeof r.t === 'number') rows.push(r)
    }
    LEDGER_CACHE = { mtimeMs: st.mtimeMs, size: st.size, rows: rows }
    return rows
  } catch (e) {
    return []
  }
}

/** 把某会话的轮次行追加进账本（按 session+turn 去重），返回新增条数。 */
export function appendLedgerRows(sessionId, rows) {
  try {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 0
    if (!Array.isArray(rows) || rows.length === 0) return 0
    const seen = new Set()
    const existing = readLedger()
    for (let i = 0; i < existing.length; i++) {
      if (existing[i].s === sessionId) seen.add(existing[i].t)
    }
    let add = ''
    let added = 0
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j]
      if (!r || seen.has(r.turn)) continue
      add += JSON.stringify({
        s: sessionId, t: r.turn, ts: r.ts, model: r.model,
        in: r.inputTokens, out: r.outputTokens, hit: r.cacheReadTokens, w: r.cacheWriteTokens
      }) + '\n'
      added++
    }
    if (added > 0) {
      appendFileSync(ledgerPath(), add, 'utf8')
      LEDGER_CACHE = { mtimeMs: -1, size: -1, rows: [] }   // 让下次读必定重读
    }
    return added
  } catch (e) {
    return 0
  }
}

/**
 * 预算路由：`GET /api/turn-usage/totals?session=<id>`
 *   → { session: [每轮用量行…], today: [账本里今天的所有行…] }
 * `session` 来自内存里的完整会话事件（不受客户端加载窗口限制），
 * `today` 来自跨重启累积的账本。
 */
export function createTotalsHandler(deps) {
  const getSession = (deps && typeof deps.getSession === 'function') ? deps.getSession : function () { return null }
  const append = (deps && typeof deps.appendLedger === 'function') ? deps.appendLedger : appendLedgerRows
  const read = (deps && typeof deps.readLedger === 'function') ? deps.readLedger : readLedger
  return function handler(req, res) {
    try {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
      let session = ''
      try { session = String(new URL(req.url, 'http://localhost').searchParams.get('session') || '') } catch (e) { session = '' }
      let rows = []
      let fresh = false
      try {
        const live = session ? getSession(session) : null
        if (live) {
          const hit = ANALYSIS_CACHE.get(session)
          const sameSeq = hit && live && (typeof live.seq === 'number') && hit.seq === live.seq
          const a = analysisOf(live, session)
          rows = a.rows
          fresh = !sameSeq
        }
      } catch (e) { rows = [] }
      if (session && fresh && rows.length > 0) { try { append(session, rows) } catch (e) { } }
      const key = bjDayKey(Date.now())
      const today = []
      const all = read()
      for (let i = 0; i < all.length; i++) {
        if (bjDayKey(all[i].ts) === key) today.push(all[i])
      }
      sendJson(res, 200, { session: rows, today: today })
    } catch (e) {
      try { sendJson(res, 500, { error: String((e && e.message) || e) }) } catch (e2) { }
    }
  }
}

/** 路由处理器：只读、只 GET、参数坏就当 0。 */
export function createHandler(deps) {
  const load = (deps && typeof deps.loadRecords === 'function') ? deps.loadRecords : loadRecords
  return function handler(req, res) {
    try {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
      let from = 0
      let session = ''
      try {
        const url = new URL(req.url, 'http://localhost')
        from = Number(url.searchParams.get('from') || 0)
        session = String(url.searchParams.get('session') || '')
      } catch (e) { from = 0; session = '' }
      if (!isFinite(from) || from < 0) from = 0
      const all = load()
      const scoped = filterBySession(all, session)
      const picked = filterRecords(scoped, from, MAX_RECORDS)
      const calls = (deps && typeof deps.getCalls === 'function') ? deps.getCalls(session) : []
      sendJson(res, 200, { records: picked, calls: calls, total: scoped.length, returned: picked.length })
    } catch (e) {
      try { sendJson(res, 500, { error: String((e && e.message) || e) }) } catch (e2) { }
    }
  }
}

/**
 * 配置路由：GET 读当前开关；POST { chip?, dock?, search? } 合并后写 `~/.dsh/turn-usage.json`。
 * 插件页那张卡片（客户端 `plugins.bundle.config` 槽位）就是调这两条。
 */
export function createConfigHandler(deps) {
  const read = (deps && typeof deps.getConfig === 'function') ? deps.getConfig : currentConfig
  const save = (deps && typeof deps.saveConfig === 'function') ? deps.saveConfig : null
  return function handler(req, res) {
    try {
      if (req.method === 'GET') {
        const body = resolveConfig(read())
        body.holidays = (deps && typeof deps.getHolidays === 'function') ? deps.getHolidays() : {}
        const ext = (deps && typeof deps.getExternal === 'function') ? deps.getExternal() : { sessions: {} }
        body.external = ext
        // 拓展可用性：搜索看记账文件；全面统计看有没有 agent 写的外部源
        body.available = {
          search: (deps && typeof deps.searchAvailable === 'function') ? deps.searchAvailable() : false,
          full: !!ext && !!ext.sessions && Object.keys(ext.sessions).length > 0
        }
        sendJson(res, 200, body)
        return
      }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
      if (typeof save !== 'function') { sendJson(res, 501, { error: 'read only' }); return }
      let raw = ''
      let closed = false
      req.on('data', function (chunk) {
        if (closed) return
        raw += chunk
        if (raw.length > 8192) { closed = true; try { req.destroy() } catch (e) { } }
      })
      req.on('end', function () {
        if (closed) return
        let body = null
        try { body = JSON.parse(raw || '{}') } catch (e) { body = null }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { error: 'bad json' }); return }
        const next = resolveConfig(Object.assign({}, resolveConfig(read()), body))
        const ok = save(next)
        sendJson(res, ok ? 200 : 500, { ok: ok, config: next })
      })
      req.on('error', function () { if (!closed) { closed = true; try { sendJson(res, 400, { error: 'bad request' }) } catch (e) { } } })
    } catch (e) {
      try { sendJson(res, 500, { error: String((e && e.message) || e) }) } catch (e2) { }
    }
  }
}

/** 自检日志路径：每次启动写一行，用来判断"路由到底注册上没有"。 */
export function routeLogPath() {
  const env = process.env.DSH_TURN_USAGE_ROUTE_LOG
  return (typeof env === 'string' && env.length > 0) ? env : join(homedir(), '.dsh', 'turn-usage-route.log')
}

/** 追加一行自检日志（失败也绝不抛出）。文件超过 64KB 先清空，只留最近的启动记录。 */
export function appendLog(message) {
  try {
    const file = routeLogPath()
    try { if (statSync(file).size > 64 * 1024) writeFileSync(file, '', 'utf8') } catch (e) { }
    appendFileSync(file, new Date().toISOString() + '  ' + message + '\n', 'utf8')
  } catch (e) { /* 记日志失败绝不能影响插件 */ }
}

export function apply(ctx, config) {
  // 插件行没给 config 时读文件；给了就用行里的（向后兼容）
  const fromRow = (config && typeof config === 'object' && (typeof config.chip === 'boolean' || typeof config.dock === 'boolean' || typeof config.search === 'boolean'))
  CFG = fromRow ? resolveConfig(config) : readConfigFile()
  const server = (ctx && ctx.webServer) ? ctx.webServer : null
  if (!server || typeof server.register !== 'function') {
    appendLog('apply: webServer 不可用，路由未注册')
    return
  }
  try {
    const disposers = []
    disposers.push(server.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: createHandler({
        // 客户端没给会话就返回空；给了就现算（会话事件在内存里，按 seq 缓存）
        getCalls: function (sessionId) {
          try {
            const sessionsService = (ctx && typeof ctx.get === 'function') ? ctx.get('sessions') : null
            return searchCallsOf(sessionsService, sessionId)
          } catch (e) { return [] }
        }
      })
    }))
    disposers.push(server.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: createConfigHandler({
        getConfig: currentConfig,
        getHolidays: readHolidays,
        searchAvailable: searchDataAvailable,
        getExternal: readExternalStats,
        saveConfig: function (next) {
          CFG = resolveConfig(next)
          return writeConfigFile(CFG)
        }
      })
    }))
    disposers.push(server.register({
      kind: 'exact',
      path: TOTALS_PATH,
      handler: createTotalsHandler({
        // 只取内存里的完整会话事件：这样「会话合计」不受客户端只加载了多少节点影响
        getSession: function (sessionId) {
          try {
            const svc = (ctx && typeof ctx.get === 'function') ? ctx.get('sessions') : null
            if (!svc || typeof svc.get !== 'function') return null
            return svc.get(sessionId) || null
          } catch (e) { return null }
        }
      })
    }))
    appendLog('apply: 已注册 ' + ROUTE_PATH + ' + ' + CONFIG_PATH + ' + ' + TOTALS_PATH +
      '（chip=' + CFG.chip + ' dock=' + CFG.dock + ' search=' + CFG.search + '）')
    if (typeof ctx.effect === 'function') {
      try {
        ctx.effect(function () {
          return function () {
            for (let i = 0; i < disposers.length; i++) {
              try { disposers[i]() } catch (e) { }
            }
          }
        })
      } catch (e) { }
    }
  } catch (e) {
    appendLog('apply: 注册失败 ' + String((e && e.message) || e))
  }
}
