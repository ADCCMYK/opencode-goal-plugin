// V2 迁移：TUI 插件 API 由 @opencode-ai/plugin/tui（V1）换成 @opencode/plugin/tui（V2：Plugin.define + setup(context)）
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { mkdirSync, readFileSync, writeFileSync, renameSync, watch, statSync, openSync, readSync, closeSync, appendFileSync } from "node:fs"
import { join } from "node:path"

const home = process.env.HOME ?? "/root"
const stateDir = join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "goal")
const goalsFile = join(stateDir, "goals.json")
const configFile = join(stateDir, "config.json")
// V2：通知队列与已读偏移（server 半边没有 toast 通道 → 写 notify.jsonl；这里读出来弹 toast）
const notifyFile = join(stateDir, "notify.jsonl")
const notifyOffsetFile = join(stateDir, "notify-offset.json")
const opencodeConfigFile = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode", "opencode.jsonc")
// 键盘/弹窗诊断（仅 config.json 里 debugEvents=true 时写 /tmp/opencode/goal-keymap.log；默认关闭=零副作用）
const INSTANCE_TAG = Math.random().toString(36).slice(2, 7)   // 每次 setup 一个新标记：识别是哪个实例在渲染面板

const kbdLog = (msg: string) => {
  try {
    if (JSON.parse(readFileSync(configFile, "utf8"))?.debugEvents !== true) return
  } catch { return }
  try { appendFileSync("/tmp/opencode/goal-keymap.log", `${new Date().toISOString()} ${msg}\n`) } catch {}
}

function parseJSONC(text: string): Record<string, any> {
  let out = "", inStr = false, esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === "\\") esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') {
      inStr = true; out += ch
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
    } else if (ch === ",") {
      let j = i + 1
      while (j < text.length && /[\s\n\r]/.test(text[j])) j++
      if (text[j] === "}" || text[j] === "]") continue
      out += ch
    } else {
      out += ch
    }
  }
  return JSON.parse(out)
}

function read(p: string, fb = "") {
  try { return readFileSync(p, "utf8").trim() || fb } catch { return fb }
}
function write(p: string, v: string) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(p, v)
}

type GoalTodo = { content: string; status: string; priority?: string }
type GoalStage = { id: string; name: string; status: string; todos?: GoalTodo[] }
type GoalEntry = { goal: string; state: string; turns: number; maxTurns: number; updatedAt: number; stages?: GoalStage[]; planFile?: string; flow?: "explore" | "plan" | "execute" | "audit"; iteration?: { count: number; direction?: string }; history?: { goal: string; count: number; direction?: string; time: number; stages?: GoalStage[]; planFile?: string; state?: string; flow?: string; turns?: number; maxTurns?: number }[] }
function loadGoals(): Record<string, GoalEntry> {
  try {
    const raw = JSON.parse(readFileSync(goalsFile, "utf8"))
    if (raw && typeof raw === "object") return raw
  } catch {}
  return {}
}
function saveGoals(g: Record<string, GoalEntry>) {
  const tmp = goalsFile + ".tmp"
  writeFileSync(tmp, JSON.stringify(g, null, 2))
  renameSync(tmp, goalsFile)
}
function configMaxTurns(): number {
  try {
    const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.maxTurns)
    if (Number.isInteger(n) && n >= 0) return n  // 0 = 无限
  } catch {}
  return 100
}
function configIterateMaxRounds(): number {
  try {
    const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.iterateMaxRounds)
    if (Number.isInteger(n) && n >= 0) return n  // 0 = 无限
  } catch {}
  return 0
}
function configSummaryLen(): number {
  try {
    const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.summaryLen)
    if (Number.isInteger(n) && n >= 5) return n
  } catch {}
  return 30
}
function writeConfig(patch: Record<string, unknown>) {
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(configFile, "utf8")) } catch {}
  Object.assign(cfg, patch)
  write(configFile, JSON.stringify(cfg, null, 2))
}
const summaryLen = () => configSummaryLen()
function configCleanupDays(): number {
  try {
    const n = parseFloat(JSON.parse(readFileSync(configFile, "utf8"))?.cleanupDays)
    if (Number.isFinite(n) && n > 0) return n
  } catch {}
  return 3
}
const cleanupDays = () => configCleanupDays()
// 卡住检测已移除（2026-10-16）：V2 官方自带超时（见 docs/V2-API-对照.md），故 TUI 不再提供「子代理卡住超时」配置项
function configPushIntervalMs(): number {
  try {
    const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.pushIntervalMs)
    if (Number.isInteger(n) && n >= 30000) return n
  } catch {}
  return 300000
}
const pushIntervalMin = () => Math.round(configPushIntervalMs() / 60000)
function configForkPaused(): boolean {
  try { return JSON.parse(readFileSync(configFile, "utf8"))?.forkPaused !== false } catch { return true }
}
function configIterateMode(): boolean {
  try { return JSON.parse(readFileSync(configFile, "utf8"))?.iterateMode === true } catch { return false }
}
function configIterAskMode(): "first" | "every" {
  try { return String(JSON.parse(readFileSync(configFile, "utf8"))?.iterAskMode ?? "first") === "every" ? "every" : "first" } catch { return "first" }
}
function configAuditDelete(): boolean {
  try { return JSON.parse(readFileSync(configFile, "utf8"))?.auditDelete !== false } catch { return true }
}
function configPlanDir(): string {
  try {
    const v = JSON.parse(readFileSync(configFile, "utf8"))?.planDir
    if (typeof v === "string" && v.trim()) return v.trim()
  } catch {}
  return "default"
}
function configAutoApprove(): boolean {
  // 自动批准 = 子代理外部目录全局放行（agent 段 general/explore/scout 的 external_directory 为 allow）
  try {
    const cfg = parseJSONC(readFileSync(opencodeConfigFile, "utf8"))
    const g = cfg?.agent?.general?.permission
    if (g && typeof g === "object" && !Array.isArray(g)) {
      if (g.external_directory === "allow") return true
    }
  } catch {}
  // 兼容旧配置
  try {
    return JSON.parse(readFileSync(configFile, "utf8"))?.autoApprovePermissions === true
  } catch {}
  return false
}
const SUBAGENT_PERMS = ["general", "explore", "scout"]
function replaceAgentBlock(raw: string, name: string, agentBlock: string): string {
  const re = new RegExp(`"${name}"\\s*:\\s*\\{`, "g")
  const m = re.exec(raw)
  if (!m) return raw
  let i = m.index + m[0].lastIndexOf("{")
  let depth = 0
  let inStr = false, esc = false
  for (let j = i; j < raw.length; j++) {
    const ch = raw[j]
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false }
    else if (ch === '"') inStr = true
    else if (ch === "{") depth++
    else if (ch === "}") { depth--; if (depth === 0) { i = j; break } }
  }
  return raw.slice(0, m.index) + `"${name}": ${agentBlock}` + raw.slice(i + 1)
}
function setAutoApproveConfig(v: boolean) {
  // 配置驱动方案：只写 config.json，auto 权限由插件 ensureAutoAccept 即时对齐（无需改 opencode.jsonc）
  try {
    writeConfig({ autoApprovePermissions: v })
  } catch {
    pluginApi?.ui.toast.show({ message: "写配置失败", variant: "error" })
  }
}
const autoApprove = () => configAutoApprove()
function configMaxRetained(): number {
  try {
    const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.maxRetainedSubagents)
    if (Number.isInteger(n) && n >= 0) return n
  } catch {}
  return 60
}
const maxRetained = () => configMaxRetained()
let pluginCleanupSubagents: () => void = () => {}
function cleanupSubagentSessions() {
  pluginCleanupSubagents()
}

function deleteGoalIfExists(sid: string) {
  const goals = loadGoals()
  if (goals[sid]) {
    delete goals[sid]
    saveGoals(goals)
  }
}

function deleteSubagentSession(sid: string) {
  const signal = AbortSignal.timeout(10000)
  // V2：client.session.delete（V1 名）→ client.session.remove；V2 返回 Promise<void>（成功 resolve／失败 reject，无 V1 的 {data|error}）
  pluginApi?.client.session.remove({ sessionID: sid }, { signal }).then(() => {
    kbdLog(`remove ${sid} -> ok`)
    afterSubagentRemoved(sid)
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    kbdLog(`remove ${sid} -> 失败 ${msg}`)
    // 已不存在＝已经删掉了（例如重复按键、或已被自动清理）→ 按成功处理，避免"删了却弹失败"
    if (/not found/i.test(msg)) { afterSubagentRemoved(sid); return }
    pluginApi?.ui.toast.show({ message: `删除子代理会话失败 ${sid.slice(-12)}（${msg || "可能被占用"}）`, variant: "error" })
  })
}
// 删除成功后的统一收尾：先把列表/目标刷新做掉，再弹提示（提示是 V2 的 ui.toast.show；V1 的 ui.toast(...) 在 V2 不存在，
// 之前正因为这里抛 "ui.toast is not a function" 导致刷新被跳过 → 界面像"没删掉"）
function afterSubagentRemoved(sid: string) {
  deleteGoalIfExists(sid)  // 子会话目标记录同步清理
  try { pluginRefresh() } catch {}
  try { pluginRefreshSubagents(sid) } catch {}
  try { pluginApi?.ui.toast.show({ message: `已删除子代理会话 ${sid.slice(-12)}`, variant: "success" }) } catch {}
}

// V2：V1 的类型名 TuiPluginApi 已不存在（@opencode-ai/plugin/tui 移除）→ 用 any（该变量在 setup 里被赋值为 V2 的 context）
let pluginApi: any | undefined
let pluginRefresh: (sessionID?: string) => void = () => {}
let pluginRefreshSubagents: (deletedSid?: string) => void = () => {}
const statusText = (s: string) => ({ active: "推进中", paused: "已暂停", done: "已完成", limited: "达上限", cleared: "无目标", stuck: "卡住", iterating: "待迭代" }[s] ?? s)
const flowText = (f?: string) => ({ explore: "探索", plan: "规划", execute: "执行", audit: "审计" }[f ?? "explore"] ?? f ?? "探索")
const turnsText = (turns: number, max: number) => max > 0 ? `${turns}/${max}` : `${turns}/不限`
const iterText = (count: number) => `迭代 ${count + 1}/${configIterateMaxRounds() > 0 ? configIterateMaxRounds() : "不限"}`
const fmtSid = (sid: string) => sid

// V2：setup(context) 里的 context 就是 V2 CLI 插件上下文（下面所有 api.* 调用点已逐处换成 V2 的 API 名称）
const tui = async (api: any) => {
  pluginApi = api
  // ⚠ 重绘机制**按旧版 V1 对齐：只写插件自己的 signal，绝不 invalidate 宿主数据**。
  //   V1 原文（api.slots.register + 槽 render 里直接读 goals()）：
  //     插件 signal 一变 → 该槽所在作用域重跑 render ⇒ 只重绘这一段（局部刷新），全程零 host invalidate、零额外请求。
  //   曾试过 data.session.invalidate 兜底：一次状态落盘会打几十个 watch 事件 ⇒ 高频重绘会卡，已撤掉。
  const [goals, setGoalsRaw] = createSignal<Record<string, GoalEntry>>({})
  // setGoals = 纯 signal 写（与 V1 完全一致；槽 render 读 goals() 自动局部刷新）
  const setGoals = (g: Record<string, GoalEntry>) => { setGoalsRaw(g) }
  const [collapsed, setCollapsed] = createSignal(false)
  const [sessionCollapsed, setSessionCollapsed] = createSignal<Record<string, boolean>>({})
  const [goalTextCollapsed, setGoalTextCollapsed] = createSignal<Record<string, boolean>>({})
  const [stageTodosCollapsed, setStageTodosCollapsed] = createSignal<Record<string, boolean>>({})
  const [manageOpen, setManageOpen] = createSignal(false)
  const [manageCurrent, setManageCurrent] = createSignal<string>("")
  const [subagentCache, setSubagentCache] = createSignal<{ id: string; parentID?: string; time?: { updated: number }; title?: string }[]>([])
  const [subStatusMap, setSubStatusMap] = createSignal<Record<string, string>>({})
  let subDeleteIndex = -1
  const [subSortDesc, setSubSortDesc] = createSignal(true)
  const [confirmSub, setConfirmSub] = createSignal<string>("")
  const [confirmGoal, setConfirmGoal] = createSignal<string>("")
  const [forkOpen, setForkOpen] = createSignal(false)
  const [forkCurrent, setForkCurrent] = createSignal<string>("")
  const [forkSortDesc, setForkSortDesc] = createSignal(true)
  const [forkHint, setForkHint] = createSignal("")
  const [forkParentMap, setForkParentMap] = createSignal<Record<string, boolean>>({})
  // 侧栏槽最近一次渲染拿到的会话 id —— currentSid() 的兜底（路由读取失败时用）
  let lastPanelSessionID = ""
  // 上一次面板渲染观察到的状态（诊断用：证明"写 signal ⇒ 槽局部重绘"真的生效）
  let lastRenderedState: string | undefined

  const refresh = (sessionID?: string, src?: string) => {
    // V1 同款：只把最新的 goals 写进 signal（槽 render 读 goals() ⇒ 局部刷新那一段，零 host invalidate）
    setGoalsRaw(loadGoals())
    kbdLog(`refresh（来源=${src ?? "?"} sid=${String(sessionID ?? currentSid()).slice(-8) || "-"}）`)
  }
  pluginRefresh = refresh

  // ===== 目标模式 auto-accept 自动开关（配置驱动 + 会话判断）=====
  // 读 config.json 的 autoApprovePermissions（总开关）&& 当前会话是否目标模式（goals.json 有 active goal）
  // → 决定开启 auto（会话权限规则 allow）或还原（ask）。
  // 维护 lastGoalMode 跟踪注入状态，避免重复 toggle；会话切换/配置变化时自动对齐。
  let lastGoalMode: boolean | undefined = undefined   // undefined=未注入，true=已注入开启，false=已还原关闭
  // 调试日志已移除（无残留调试代码）；保留调用点为空实现
  // 旧版为空实现：`const aaDebug = (_msg: string) => {}`（已按"改回去"还原，保持与旧版一致）
  const aaDebug = (msg: string) => { kbdLog(`[auto-approve] ${msg}`) }   // 临时取证：定位 auto 开关是否真的在执行（用完还原为空实现）
  const configAutoApprove = (): boolean => {
    try { return JSON.parse(readFileSync(configFile, "utf8"))?.autoApprovePermissions === true } catch { return false }
  }
  aaDebug("plugin loaded")
  // 只有"目标继续推进"时才启用自动批准（用户要求：目标暂停就不该有权限放行）：
  //   active（进行中）/ iterating（迭代轮次之间，下一轮仍会继续）⇒ 启用
  //   paused / limited / done / cleared ⇒ 一律不启用（恢复询问，正常弹窗）
  const isGoalContinuing = (e?: GoalEntry): boolean => !!e && (e.state === "active" || e.state === "iterating")
  const isGoalSession = (sid: string): boolean => {
    try { return isGoalContinuing(loadGoals()[sid]) } catch { return false }
  }
  // ── 内存点（与 V1 同一层次：纯运行时、零持久化、零配置）──
  // V1 的做法是 `M.permission.toggle()`——改的是 TUI 的**内存态**；V2 的插件 API 已无此入口
  //   （实测枚举：api 只有 options/location/app/renderer/client/data/attention/theme/themeMode/markdown/
  //    keymap/storage/ui；state/local/kv/keys/route/tuiConfig 全为 undefined；159 条命令里无权限模式命令；
  //    运行时也没有 permission.ask 钩子）。
  // ⇒ V2 里唯一与 V1 同层的内存点就是**数据层对象本身**：插件与 TUI 共用同一个内存对象，
  //   在这里做两件事即可做到"连弹窗都没有"，且不写任何持久化/配置：
  //     ① 权限请求事件到达 ⇒ 立即按旧版路径应答（client.permission.reply decision:"once"）
  //     ② 把"目标家族（主 + 子代理）"的请求从数据层权限列表里**内存过滤掉** ⇒ 权限弹窗读不到它 ⇒ 不渲染
  const repliedIds = new Set<string>()
  const preexistingReqIds = new Set<string>()   // 重载安全：本实例装载前就存在的请求 ⇒ 永不自动批（交人工决定）
  const scopeCache = new Set<string>()      // 目标家族会话（内存集合，随 tick/事件刷新）
  const refreshScopeCache = async () => {
    scopeCache.clear()
    const cur = currentSid()
    if (!configAutoApprove()) return
    const goals = loadGoals()
    for (const [sid, e] of Object.entries(goals)) if (isGoalContinuing(e)) scopeCache.add(sid)   // 只纳入"继续推进"的目标（暂停/达上限/结束一律不纳入）
    if (cur && isGoalSession(cur)) scopeCache.add(cur)
    if (scopeCache.size === 0) return
    try {                                    // 家族向下扩展（数据层 family + client.list 的 parentID 链）
      const fam = (api.data as any)?.session?.family?.(cur) as string[] | undefined
      if (Array.isArray(fam)) for (const id of fam) if (id) scopeCache.add(String(id))
      const res = (await (api.client as any).session.list({})) as unknown
      const all = (Array.isArray(res) ? res : ((res as { data?: unknown[] })?.data ?? [])) as { id: string, parentID?: string }[]
      for (let depth = 0; depth < 8; depth++) {
        let grew = false
        for (const s of all) if (s?.parentID && scopeCache.has(s.parentID) && !scopeCache.has(s.id)) { scopeCache.add(s.id); grew = true }
        if (!grew) break
      }
    } catch {}
  }
  const replyOnce = async (sessionID: string, requestID: string) => {
    if (!sessionID || !requestID) return
    if (preexistingReqIds.has(requestID)) return          // 重载安全：装载前就存在的请求一律不自动批（交人工决定）
    if (repliedIds.has(requestID)) return
    repliedIds.add(requestID)
    if (repliedIds.size > 500) repliedIds.clear()
    try {
      const cp = (api.client as any).permission
      if (typeof cp?.reply === "function") await cp.reply({ sessionID, requestID, decision: "once" })
      else await (api.client as any).session.permission.reply({ sessionID, requestID, decision: "once" })
      aaDebug(`自动批准（内存点）：已应答 ${sessionID} 的权限请求 ${requestID}`)
    } catch (e) {
      repliedIds.delete(requestID)
      aaDebug(`自动批准应答失败 ${requestID}: ${String(e)}`)
    }
  }
  // ② 内存过滤：目标家族的请求不进界面（幂等安装一次）
  let scopeFilterInstalled = false
  const installScopeFilter = () => {
    if (scopeFilterInstalled) return
    try {
      const dp: any = (api.data as any)?.session?.permission
      const orig = dp?.list
      if (typeof orig !== "function") { aaDebug("内存点安装失败：data.session.permission.list 不存在"); return }
      dp.list = (sid: string) => {
        const rows = (orig.call(dp, sid) ?? []) as { id?: string, sessionID?: string }[]
        if (!configAutoApprove() || scopeCache.size === 0) return rows
        return rows.filter((r) => !scopeCache.has(String(r?.sessionID ?? sid)))
      }
      scopeFilterInstalled = true
      aaDebug("内存点已安装：data.session.permission.list 过滤目标家族请求（请求不进界面）")
    } catch (e) { aaDebug(`内存点安装异常: ${String(e)}`) }
  }
  // 兜底对账（**仅在目标继续推进时**执行）：补答"暂停窗口/插件重载期间"漏掉的待批准请求，
  //   否则恢复后这些请求会被内存过滤隐藏、却仍在阻塞工具调用。
  //   复用现有 10s tick（不新增定时器）；只在有活跃目标时发请求，暂停时一次 HTTP 都不发。
  const reconcilePending = async () => {
    if (!configAutoApprove()) return
    await refreshScopeCache()                               // 实时重算（暂停 ⇒ 范围为空 ⇒ 一条都不批）
    if (scopeCache.size === 0) return                       // 目标暂停/停止 ⇒ 无范围 ⇒ 不做任何事
    for (const sid of scopeCache) {
      let reqs: { id?: string }[] = []
      try {
        const cp = (api.client as any).permission
        const res = (typeof cp?.list === "function") ? await cp.list({ sessionID: sid }) : undefined
        reqs = ((Array.isArray(res) ? res : ((res as { data?: unknown[] })?.data ?? [])) as { id?: string }[])
      } catch {}
      for (const r of reqs) if (r?.id) void replyOnce(sid, String(r.id))
    }
  }
  installScopeFilter()
  // 重载安全（用户要求：重载不批准，防止状态未就绪时误放行）：
  //   装载时**只建缓存**，并把"本实例装载前就存在的待批准请求"登记为 preexistingReqIds ⇒ 永不自动批（交人工决定）。
  //   之后新到达的请求才由内存点接管（事件即时应答 + 10s 兜底对账，二者都实时校验目标状态）。
  void (async () => {
    await refreshScopeCache()
    try {
      const cp = (api.client as any).permission
      for (const sid of scopeCache) {
        const res = (typeof cp?.list === "function") ? await cp.list({ sessionID: sid }) : undefined
        for (const r of ((Array.isArray(res) ? res : ((res as { data?: unknown[] })?.data ?? [])) as { id?: string }[])) {
          if (r?.id) preexistingReqIds.add(String(r.id))
        }
      }
      if (preexistingReqIds.size > 0) aaDebug(`重载安全：登记 ${preexistingReqIds.size} 条"装载前请求"为不自动批（交人工决定）`)
    } catch {}
  })()

  const ensureAutoAccept = () => {
    try {
      // 批准链条不变：仅在此前判断「当前会话是否目标模式 && 总开关开启」
      const sid = currentSid()
      const want = configAutoApprove() && !!sid && isGoalSession(sid)
      // 首次加载（lastGoalMode===undefined）：
      //   want=true  → 自动批准生效；want=false → 不动作（保持默认询问）
      if (lastGoalMode === undefined) {
        lastGoalMode = want
        aaDebug(`init: want=${want} → ${want ? "自动批准生效（目标会话 + 子代理）" : "未开启（非目标会话/配置关闭）"}`)
        return
      }
      if (lastGoalMode === want) return
      lastGoalMode = want
      void refreshScopeCache()   // 目标状态刚变（暂停/恢复/结束）⇒ 立即重算家族：暂停即清空范围、恢复即重建
      aaDebug(`goal session=${!!sid && isGoalSession(sid)} config=${configAutoApprove()} want=${want} → ${want ? "自动批准生效" : "恢复询问"}`)
      api.ui.toast.show({
        message: want ? "自动批准已开启（目标会话 + 子代理，不弹窗）" : "自动批准已关闭（非目标会话/配置关闭，恢复询问）",
        variant: want ? "success" : "info",
        duration: 4000,
      })
    } catch (e) {
      aaDebug(`ensureAutoAccept error: ${String(e)}`)
    }
  }

  const currentSid = () => {
    try {
      const cur = api.ui.router.current() as unknown as { type?: string, sessionID?: string, name?: string, params?: { sessionID?: string } } | undefined
      // V2 Route 形状（官方类型）： { type:"home" } | { type:"session", sessionID } | { type:"plugin", ... }
      //   ⚠ 照抄 V1 的 {name, params.sessionID} 会**永远解析为空** ⇒ 暂停/恢复等"依赖当前会话"的动作静默失效
      //   （实测症状：按暂停无反应、无提示、面板不动；服务端 ESC 暂停后面板也不刷新）
      if (cur?.type === "session" && cur.sessionID) return String(cur.sessionID)
      if (cur?.name === "session") return String(cur.params?.sessionID ?? "")   // 兼容旧形状
    } catch {}
    // 兜底：侧栏槽最近一次渲染拿到的会话（路由读取失败时仍能定位当前会话）
    return lastPanelSessionID
  }

  const notifySession = (sid: string, text: string) => {
    // V1 原文：子代理会话不启用 question 工具（子代理不能询问用户）；主会话保持可用
    // V1：推送带 body.agent="z-goal"、主会话带 tools:{question:true}、parts 标 synthetic（**合成注入，非用户通道**）
    // V2：对应 ctx.session.synthetic —— delivery=queue（回合结束送达）+ resume=true（唤醒新回合）；
    //     PromptInput 没有 agent/tools → 先确保会话在 z-goal 上；子代理会话 deny question
    const push = (isSub: boolean) => {
      // ⚠ switchAgent 会改系统提示（agent 是提示的一部分）⇒ 重复切换会毁 prompt 缓存；
      //   所以先查会话当前 agent，已是 z-goal 就不再切（与服务端 ensureGoalAgent 的守护一致）
      api.client.session.get({ sessionID: sid }).then((res: unknown) => {
        const body = (res as { data?: { agent?: string } })?.data ?? (res as { agent?: string })
        if (body?.agent === "z-goal") return
        api.client.session.switchAgent({ sessionID: sid, agent: "z-goal" }).catch(() => {})
      }).catch(() => {})
      if (isSub) api.client.session.update({ sessionID: sid, permissions: [{ action: "question", resource: "*", effect: "deny" }] }).catch(() => {})
      api.client.session.synthetic({ sessionID: sid, text, delivery: "queue", resume: true }).catch(() => {})
    }
    // V2：client.session.list 返回形状与 V1 一致（{data:[SessionInfo]}，含 parentID）→ 下面归一化逻辑无需改
    api.client.session.list({}).then((res: unknown) => {
      const all = (Array.isArray(res) ? res : ((res as { data?: unknown[] }).data ?? [])) as { id: string; parentID?: string }[]
      push(all.some(s => s?.id === sid && !!s.parentID))
    }).catch(() => push(false))
  }

  const doClear = (sid: string) => {
    const goals = loadGoals()
    if (!goals[sid]) return
    const before = Object.entries(goals).filter(([, e]) => e.state !== "cleared" && e.state !== "done").map(([k]) => k)
    const idx = before.indexOf(sid)
    delete goals[sid]
    saveGoals(goals)
    setGoals(goals)
    if (manageCurrent() === `goal:${sid}`) {
      const rest = Object.entries(goals).filter(([, e]) => e.state !== "cleared" && e.state !== "done").map(([k]) => k)
      if (rest.length > 0) {
        const ni = Math.min(idx >= 0 ? idx : 0, rest.length - 1)
        setManageCurrent(`goal:${rest[ni]}`)
      } else {
        setManageCurrent("")
      }
    }
    api.ui.toast.show({ message: `目标已删除（会话 ${fmtSid(sid)}）`, variant: "success" })
    // M5：对话框仍打开时重新渲染选项列表（静态 options 不会自动刷新，已删条目会残留）
    if (manageOpen()) goalManageDialog()
  }
  // TUI 侧动作的通知：**统一走 notify.jsonl**（与服务端暂停同一条通道）。
  //   为什么不用直接 api.ui.toast.show：实测该直接调用在本版本不显示 —— 用户端确认
  //   "用 goal 工具暂停有弹窗、在 TUI 里按暂停没有"，差别就在于服务端会写通知而 TUI 侧没写。
  const notifyLocal = (kind: "info" | "success" | "warning" | "error", message: string) => {
    try {
      appendFileSync(notifyFile, JSON.stringify({ at: Date.now(), pid: process.pid, kind, message }) + "\n")
    } catch (e) { kbdLog(`notifyLocal 失败: ${String(e)}`) }
  }

  const doPause = (sid: string) => {
    // 全防线：任一步失败都不能挡住"状态写入 + 重渲染 + 提示"这三件事
    // （此前把硬掐回合那行放在中间，TUI client 若无 session.interrupt 会抛异常，
    //   直接吞掉后面的 toast 与重渲染 ⇒ 用户看到"按了暂停但没弹窗、面板不刷新"）
    kbdLog(`doPause 开始 sid=${sid.slice(-8)}`)
    try {
      const goals = loadGoals()
      if (!goals[sid]) { kbdLog("doPause 中止：该会话无目标"); return }
      goals[sid] = { ...goals[sid], state: "paused", updatedAt: Date.now() }
      saveGoals(goals)
      setGoals(goals)
      kbdLog("doPause 状态已写入并刷新")
      notifyLocal("info", `目标已暂停（会话 ${fmtSid(sid)}，可在列表恢复）`)
      try { api.ui.toast.show({ message: `目标已暂停（会话 ${fmtSid(sid)}，可在列表恢复）`, variant: "info", duration: 8000 }) }
      catch (e) { kbdLog(`doPause toast 失败: ${String(e)}`) }
      try { if (manageOpen()) goalManageDialog() } catch (e) { kbdLog(`doPause 重渲染失败: ${String(e)}`) }
      // 最后再做"硬掐回合"（与 goal 工具的 pause 语义对齐）；先探存在性，绝不因它影响上面的提示与刷新
      try {
        const anyApi = api as unknown as { client?: { session?: { interrupt?: (a: unknown) => Promise<unknown> } } }
        const fn = anyApi.client?.session?.interrupt
        if (typeof fn === "function") { void fn.call(anyApi.client!.session, { sessionID: sid }).catch(() => {}) }
        else kbdLog("本 TUI client 无 session.interrupt，跳过硬掐回合")
      } catch (e) { kbdLog(`doPause interrupt 异常（已忽略）: ${String(e)}`) }
    } catch (e) {
      kbdLog(`doPause 异常: ${String(e)}`)
    }
  }
  const doResume = (sid: string) => {
    kbdLog(`doResume 开始 sid=${sid.slice(-8)}`)
    try {
      const goals = loadGoals()
      if (!goals[sid]) { kbdLog("doResume 中止：该会话无目标"); return }
      if (goals[sid].state === "limited") {
        api.ui.toast.show({ message: `已达轮数上限（${goals[sid].maxTurns} 轮），目标停止推进无法恢复；请用 /goal 重新设置目标`, variant: "warning" })
        return
      }
      if (goals[sid].state !== "paused" && goals[sid].state !== "iterating") {
        api.ui.toast.show({ message: `状态为 ${statusText(goals[sid].state)}，无需恢复`, variant: "info" })
        return
      }
      goals[sid] = { ...goals[sid], state: "active", updatedAt: Date.now() }
      saveGoals(goals)
      setGoals(goals)
      kbdLog("doResume 状态已写入并刷新")
      notifyLocal("success", `目标已恢复，继续推进（会话 ${fmtSid(sid)}）`)
      try { api.ui.toast.show({ message: `目标已恢复，继续推进（会话 ${fmtSid(sid)}）`, variant: "success", duration: 8000 }) }
      catch (e) { kbdLog(`doResume toast 失败: ${String(e)}`) }
      try { if (manageOpen()) goalManageDialog() } catch (e) { kbdLog(`doResume 重渲染失败: ${String(e)}`) }
      // 恢复＝解除暂停，立刻推一轮（唤醒链路同样全防线，失败也不影响状态与提示）
      try { notifySession(sid, `【恢复推进】目标已恢复（暂停解除），请继续推进直到完成。按推送规范：目标/阶段/待办有变化就更新（goal 工具 stage/todos），全部完成后 audit 收尾。`) }
      catch (e) { kbdLog(`doResume 唤醒推送失败: ${String(e)}`) }
    } catch (e) {
      kbdLog(`doResume 异常: ${String(e)}`)
    }
  }
  const deleteConfirm = (sid: string) => {
    const goals = loadGoals()
    const e = goals[sid]
    if (!e) return
    // V2：<api.ui.DialogConfirm …/> + dialog.replace → api.ui.dialog.confirm（Promise 式；确认才执行）
    void api.ui.dialog.confirm({
      title: `删除目标（会话 ${fmtSid(sid)}）`,
      message: `确定删除该目标？删除后不可恢复。\n\n${e.goal.length > 80 ? e.goal.slice(0, 80) + "…" : e.goal}`,
    }).then((ok) => { if (ok) doClear(sid) })
  }
  // V2：<api.ui.DialogSelect options=[{…,onSelect}]/> + dialog.replace → api.ui.dialog.select（Promise）
  //     差异：①选项各自带 onSelect → 改为按 select() 返回值分发；②V2 的 promise 对话框选完自动关闭（无需 dialog.clear）
  //     选项 title/value/disabled 与各分支文案**逐字保留**
  const goalActionMenu = (sid: string) => {
    const goals = loadGoals()
    const e = goals[sid]
    if (!e) return
    void api.ui.dialog.select<string>({
      title: `管理目标（会话 ${fmtSid(sid)}）`,
      options: [
        { title: "查看目标", value: "status" },
        { title: "更新目标", value: "edit" },
        { title: "恢复目标", value: "resume", disabled: e.state !== "paused" && e.state !== "iterating" },
        { title: "暂停目标", value: "pause", disabled: e.state !== "active" },
        { title: "跳转目标", value: "goto" },
        { title: "删除目标", value: "delete" },
      ],
    }).then((chosen) => {
      if (chosen === undefined) return
      switch (chosen) {
        case "status": {
          api.ui.toast.show({ title: `目标状态（${fmtSid(sid)}）`, message: `状态：${statusText(e.state)} | 流程：${flowText(e.flow)} | 轮数：${turnsText(e.turns, e.maxTurns)}${(e.iteration || configIterateMode()) ? ` | ${iterText(e.iteration?.count ?? 0)}` : ""}\n目标：${e.goal}${(e.history ?? []).map(h => `\n迭代历史 第${h.count + 1}轮：${h.goal.length > 40 ? h.goal.slice(0, 40) + "…" : h.goal}`).join("")}`, variant: "info" })
          return
        }
        case "edit": {
          void api.ui.dialog.prompt({
            title: `更新目标（会话 ${fmtSid(sid)}）`,
            value: e.goal,
          }).then((v) => {
            if (v === undefined) return
            const g = v.trim()
            if (!g) { api.ui.toast.show({ message: "目标不能为空", variant: "error" }); return }
            const goals = loadGoals()
            if (!goals[sid]) { api.ui.toast.show({ message: "目标已不存在", variant: "error" }); return }
            goals[sid] = { ...goals[sid], goal: g, updatedAt: Date.now() }
            saveGoals(goals)
            setGoals(goals)
            if (goals[sid].state === "active") {
              notifySession(sid, `【目标更新】目标已修改为：${g}。请以新目标为准，重新评估当前进度与计划，必要时调整方向，继续推进直到完成。`)
              api.ui.toast.show({ message: "目标已更新，已立即通知 AI", variant: "success" })
            } else {
              api.ui.toast.show({ message: "目标已更新（暂停中，恢复后生效）", variant: "info" })
            }
          })
          return
        }
        case "resume": doResume(sid); return
        case "pause": doPause(sid); return
        case "goto": {
          try {
            if (api.data.session.get(sid) === undefined) {   // V2：api.state.session.get → api.data.session.get
              api.ui.toast.show({ message: `会话 ${fmtSid(sid)} 不存在或已清理，无法跳转`, variant: "warning" })
              return
            }
            api.ui.router.navigate({ type: "session", sessionID: sid })   // V2：api.route.navigate → api.ui.router.navigate
          } catch {
            api.ui.toast.show({ message: "跳转会话失败，目标会话可能已不存在", variant: "error" })
          }
          return
        }
        case "delete": deleteConfirm(sid); return
      }
    })
  }
  const goalManageDialog = () => {
    setManageOpen(true)
    setConfirmGoal("")
    const cur = currentSid()
    // 选中保持：打开时选中当前会话；已有选中且仍在列表则保持
    const g = manageCurrent()
    const activeSids = new Set(Object.entries(loadGoals()).filter(([, e]) => e.state !== "cleared" && e.state !== "done").map(([sid]) => sid))
    if (g && activeSids.has(g.slice(5))) setManageCurrent(g)
    else if (cur && activeSids.has(cur)) setManageCurrent(`goal:${cur}`)
    else setManageCurrent("")
    // 用 loadGoals() 同步快照（非 goals() signal）：goals.json 被其他进程/插件写入时 watch 触发 setGoals 会导致
    // DialogSelect 持续重挂载、交互冻结（与 subagentListDialog 用局部快照保持一致）
    const genOptions = () => Object.entries(loadGoals()).filter(([, e]) => e.state !== "cleared" && e.state !== "done").map(([sid, e]) => {
      const confirming = confirmGoal() === sid
      return {
        title: confirming
          ? `再次按 Ctrl+d 确认删除：${statusText(e.state)} · ${e.goal.length > summaryLen() ? e.goal.slice(0, summaryLen()) + "…" : e.goal}`
          : `${statusText(e.state)} · ${e.goal.length > summaryLen() ? e.goal.slice(0, summaryLen()) + "…" : e.goal}`,
        value: `goal:${sid}`,
        category: confirming ? "⚠ 确认删除" : (sid === cur ? "当前会话" : "目标"),
          footer: `轮数 ${turnsText(e.turns, e.maxTurns)} · ${sid}`,
      }
    })
    // V2：dialog.replace + <api.ui.DialogSelect …/> → api.ui.dialog.select（Promise）
    //     ①V1 的 onMove（把高亮项同步进 manageCurrent）V2 无等价 → 改为 Enter 提交时记录 + Ctrl+d 由对话框内 actions 承接
    //     ②Ctrl+d 删除逻辑**原样搬到 actions.onTrigger**（同样「再按一次确认」；V2 的 action 不关对话框，与 V1 行为一致）
    void api.ui.dialog.select<string>({
      title: "目标管理",
      placeholder: "Enter 管理选中目标，Ctrl+d 删除（再按一次确认），Esc 关闭",
      // V2 响应式：V1 的 dialog.replace(() => <DialogSelect …/>) 把读取都放在渲染函数里（信号一变即重绘）；
      //   V2 的 select() 只在打开时取一次值 → 必须传 getter，否则「再按一次确认」等状态改了界面也不刷新（表现为"快捷键没生效"）
      get options() { return genOptions() },
      get current() { return manageCurrent() || undefined },
      actions: [
        {
          bind: "ctrl+d",
          title: "删除",
          onTrigger: (v0) => {
            kbdLog(`ACTION ctrl+d(目标管理) value=${String(v0)}`)
            const v = String(v0 ?? "")
            if (!v) return
            setManageCurrent(v)
            if (v.startsWith("sub:")) {
              const sid = v.slice(4)
              if (confirmSub() !== sid) {
                setConfirmSub(sid)
                setConfirmGoal("")
                return
              }
              setConfirmSub("")
              deleteSubagentSession(sid)
              return
            }
            const sid = v.startsWith("goal:") ? v.slice(5) : v
            if (!loadGoals()[sid]) return
            if (confirmGoal() !== sid) {
              setConfirmGoal(sid)
              return
            }
            setConfirmGoal("")
            doClear(sid)
          },
        },
      ],
    }).then((v0) => {
      if (v0 === undefined) return
      const v = String(v0)
      setManageCurrent(v)
      setConfirmGoal("")
      goalActionMenu(v.startsWith("goal:") ? v.slice(5) : v)
    })
  }

  const forkGoalDialog = () => {
    setForkOpen(true)
    setForkHint("")
    setForkCurrent("")
    const cur = currentSid()
    // 区分主会话/子代理：加载 session list 构建 parentID map
    api.client.session.list({}).then((res: unknown) => {
      const all = (Array.isArray(res) ? res : ((res as { data?: unknown[] }).data ?? [])) as { id: string; parentID?: string }[]
      setForkParentMap(Object.fromEntries(all.filter(s => s?.id && s.parentID).map(s => [s.id, true])))
    }).catch(() => {})
    const genOptions = () => {
      const desc = forkSortDesc()
      const sorted = Object.entries(goals()).filter(([, e]) => e.state !== "cleared" && e.state !== "done")
        .sort((a, b) => {
          // 主会话（当前会话）在前，其余按时间最新
          if (a[0] === cur && b[0] !== cur) return -1
          if (b[0] === cur && a[0] !== cur) return 1
          return desc ? (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0) : (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0)
        })
      return sorted.map(([sid, e]) => {
        const sel = forkCurrent() === sid
        const isCur = sid === cur
        const isSub = !!forkParentMap()[sid]
        const tag = isCur ? "主会话" : (isSub ? "子代理" : "目标")
        return {
          title: `${sel ? "▶ " : "  "}${statusText(e.state)} · ${tag} · ${e.goal.length > 26 ? e.goal.slice(0, 26) + "…" : e.goal}`,
          value: `fork:${sid}`,
          category: sel ? "已选中（回车取消）" : tag,
        footer: `轮数 ${turnsText(e.turns, e.maxTurns)} · ${sid}`,
        }
      })
    }
    // V2：dialog.replace + <api.ui.DialogSelect …/> → api.ui.dialog.select（Promise）
    //     ①V1 多步交互（Enter 标记 → Ctrl+1/2/y 执行 → Ctrl+o 排序）在 V2 拆为：
    //        · Enter（select 返回值）→ 标记/取消标记后**重开对话框**（等价 V1「标记后仍留在列表」）
    //        · Ctrl+1/2/y/o → 对话框内 actions（动作体与 V1 的 keymap 处理器同源：setForkCurrent + doForkGoal / 切排序）
    //     ②V1 的 onMove（清 hint）V2 无等价 → hint 改在重开/动作后清除
    void api.ui.dialog.select<string>({
      title: forkHint() || "Fork 目标到当前会话（主会话在前，时间最新排序）",
      placeholder: "Enter 选中/取消，Ctrl+1 完整复制（含阶段/迭代），Ctrl+2 仅目标文本，Ctrl+o 排序，Esc 关闭",
      // V2 响应式：getter 才能让 forkHint/选中态变化立刻反映到弹窗（等价 V1 的 dialog.replace 渲染）
      get options() { return genOptions() },
      get current() { return forkCurrent() || undefined },
      actions: [
        { bind: "ctrl+1", title: "完整复制", onTrigger: (v0) => { const raw = String(v0 ?? ""); if (!raw.startsWith("fork:")) return; setForkCurrent(raw.slice(5)); if (forkHint()) setForkHint(""); doForkGoal("full") } },
        { bind: "ctrl+2", title: "仅文本", onTrigger: (v0) => { const raw = String(v0 ?? ""); if (!raw.startsWith("fork:")) return; setForkCurrent(raw.slice(5)); if (forkHint()) setForkHint(""); doForkGoal("text") } },
        { bind: "ctrl+y", title: "复制", onTrigger: (v0) => { const raw = String(v0 ?? ""); if (!raw.startsWith("fork:")) return; setForkCurrent(raw.slice(5)); if (forkHint()) setForkHint(""); doForkGoal("full") } },
        { bind: "ctrl+o", title: "排序", selection: "none", onTrigger: () => { const keep = forkCurrent(); setForkSortDesc(!forkSortDesc()); forkGoalDialog(); setForkCurrent(keep) } },
      ],
    }).then((v0) => {
      if (v0 === undefined) return
      const v = String(v0)
      if (!v.startsWith("fork:")) return
      const sid = v.slice(5)
      setForkCurrent(forkCurrent() === sid ? "" : sid)
      if (forkHint()) setForkHint("")
      forkGoalDialog()
    })
  }

  const doForkGoal = (mode: "full" | "text" = "full") => {
    const sid = forkCurrent()
    const src = sid ? loadGoals()[sid] : undefined
    if (!src) {
      setForkHint("当前会话无目标")
      return
    }
    const cur = currentSid()
    const goals = loadGoals()
    const curE = goals[cur]
    const paused = configForkPaused()
    // 子代理会话不继承迭代身份（子代理永远正常目标模式）
    const curIsSub = !!forkParentMap()[cur]
    if (curE) {
      goals[cur] = {
        ...curE,
        goal: src.goal,
        state: "active",
        updatedAt: Date.now(),
        ...(mode === "full" ? { stages: src.stages, planFile: src.planFile, flow: src.flow, iteration: (curIsSub ? undefined : src.iteration) } : {}),
      }
    } else {
      goals[cur] = mode === "full"
        ? {
            goal: src.goal,
            state: paused ? "paused" : "active",
            turns: src.turns ?? 0,
            maxTurns: src.maxTurns ?? configMaxTurns(),
            updatedAt: Date.now(),
            startedAt: src.startedAt,
            stages: src.stages ?? [],
            planFile: src.planFile,
            flow: src.flow ?? "explore",
            ...(curIsSub ? {} : { iteration: src.iteration }),
          }
        : { goal: src.goal, state: paused ? "paused" : "active", turns: 0, maxTurns: configMaxTurns(), updatedAt: Date.now(), stages: [] }
    }
    saveGoals(goals)
    setGoals(goals)
    const isFull = mode === "full"
    api.ui.toast.show({
      message: curE
        ? `已 Fork 目标到当前会话（${isFull ? "完整复制" : "仅目标文本"}，直接更新目标）：${src.goal.length > 30 ? src.goal.slice(0, 30) + "…" : src.goal}`
        : `已 Fork 目标到当前会话（${isFull ? "完整复制" : "仅目标文本"}${paused ? "，默认暂停，/goal-resume 恢复推进" : "，立即推进"}）：${src.goal.length > 30 ? src.goal.slice(0, 30) + "…" : src.goal}`,
      variant: "success",
    })
    // fork 覆盖已有目标且 active → 通知 AI（与"更新目标"一致，避免 AI 继续按旧目标推进）
    if (curE && curE.state === "active") {
      notifySession(cur, `【目标更新】目标已通过 Fork 更新为：${src.goal}。请以新目标为准，重新评估当前进度与计划，必要时调整方向，继续推进直到完成。`)
    }
    api.ui.dialog.clear()
    setForkOpen(false)
  }

  const loadSubagentSessions = (): Promise<{ subs: { id: string; parentID?: string; time?: { updated: number }; title?: string }[]; statusMap: Record<string, string> }> => {
    // 用 session.list 全量 + parentID 过滤（children API 在 TUI 插件中签名不匹配返回空）
    return api.client.session.list({}).then(async (res: unknown) => {
      const all = (Array.isArray(res) ? res : ((res as { data?: unknown[] }).data ?? [])) as { id: string; parentID?: string; time?: { updated: number }; title?: string }[]
      const subs = all.filter(s => s?.id && s.parentID)
      const statusMap: Record<string, string> = {}
      const live: Record<string, string> = {}
      try {
        // V2：client.session.status({}) 已取消（状态改由事件/CLI 数据层给）→ 用 api.data.session.status(sid)（"idle"|"running"）
        for (const s of subs) {
          let t = ""
          try { t = api.data.session.status(s.id) } catch { t = "" }
          if (t === "running") { live[s.id] = "busy"; statusMap[s.id] = "进行中" }
        }
      } catch {}
      // idle/无状态 的子代理：查最后一条 assistant 消息判断 已完成/已失败/未知（无法确认完成一律未知，不误删）
      await Promise.all(subs.filter(s => !statusMap[s.id]).map(async (s) => {
        try {
          // V2：client.session.messages({limit}) → CLI 数据层（先 sync 再 list；扁平消息，type 区分角色、完成时间在消息自身）
          await api.data.session.message.sync(s.id).catch(() => {})
          const list = (api.data.session.message.list(s.id) ?? []) as { type?: string; error?: unknown; time?: { completed?: number } }[]
          const lastAsst = [...list].reverse().find(m => m?.type === "assistant")
          if (!lastAsst) {
            statusMap[s.id] = "未知"
          } else if (lastAsst.error) {
            statusMap[s.id] = "已失败"
          } else if (lastAsst.time?.completed !== undefined) {
            statusMap[s.id] = "已完成"
          } else {
            statusMap[s.id] = "未知"
          }
        } catch {
          statusMap[s.id] = "未知"
        }
      }))
      return { subs, statusMap }
    })
  }

  const renderSubagentDialog = () => {
    const subs = subagentCache()
    const statusMap = subStatusMap()
    const desc = subSortDesc()
    const sorted = [...subs].sort((a, b) => desc
      ? (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
      : (a.time?.updated ?? 0) - (b.time?.updated ?? 0))
    // 选中保持：当前选中仍在列表则保持；被删则顺延到同位置下一项（对齐 /sessions preserveSelection）
    const cur = manageCurrent()
    if (!cur || !sorted.some(s => `sub:${s.id}` === cur)) {
      if (sorted.length > 0) {
        const idx = subDeleteIndex >= 0 ? Math.min(subDeleteIndex, sorted.length - 1) : 0
        setManageCurrent(`sub:${sorted[idx].id}`)
      }
      subDeleteIndex = -1
    }
    const stText = (t: string) => ({ busy: "进行中", idle: "空闲", retry: "重试" } as Record<string, string>)[t] ?? "未知"
    const genOptions = () => sorted.map(s => {
      const t = (s.title ?? "子代理").replace(/[@（(]?(general|explore|scout)[@)）]?\s*(subagent)?/i, "").trim()
      const confirming = confirmSub() === s.id
      const st = statusMap[s.id] ?? stText("")
      return {
        title: confirming
          ? `再次按 Ctrl+d 确认删除：${st} · ${(t.length > 20 ? t.slice(0, 20) + "…" : t || "子代理")}`
          : (t.length > 26 ? t.slice(0, 26) + "…" : (t || "子代理")),
        description: `状态：${st}`,
        value: `sub:${s.id}`,
        category: confirming ? "⚠ 确认删除" : new Date(s.time?.updated ?? 0).toLocaleString().slice(0, 16),
        footer: s.id,
      }
    })
    // V2：dialog.replace + <api.ui.DialogSelect …/> → api.ui.dialog.select（Promise）
    //     ①输入搜索：V2 的 select 原生支持（默认按 title 过滤），无需额外代码
    //     ②Ctrl+d（再按一次确认删除）/ Ctrl+o（切排序）→ 对话框内 actions，动作体与 V1 的 keymap 处理器一致
    //     ③V1 的 onMove（同步 manageCurrent）V2 无等价 → Enter 提交时记录；Ctrl 动作直接用当前选中值
    void api.ui.dialog.select<string>({
      title: `子代理会话（${sorted.length} 个 · ${desc ? "最新在前" : "最旧在前"}）`,
      placeholder: "Enter 跳转会话，Ctrl+d 删除（再按一次确认），Ctrl+o 切换排序，输入搜索，Esc 关闭",
      // V2 响应式：同 goalManageDialog —— getter 才能让「再按一次确认」提示随状态刷新（等价 V1 的 dialog.replace 渲染）
      get options() { return genOptions() },
      get current() { return manageCurrent() || undefined },
      actions: [
        {
          bind: "ctrl+d",
          title: "删除",
          onTrigger: (v0) => {
            kbdLog(`ACTION ctrl+d(子代理列表) value=${String(v0)}`)
            const v = String(v0 ?? "")
            if (!v.startsWith("sub:")) return
            const sid = v.slice(4)
            setManageCurrent(v)
            if (confirmSub() !== sid) { setConfirmSub(sid); return }
            setConfirmSub("")
            deleteSubagentSession(sid)
          },
        },
        {
          bind: "ctrl+o",
          title: "排序",
          selection: "none",
          onTrigger: () => {
            const keep = manageCurrent()
            setSubSortDesc(!subSortDesc())
            renderSubagentDialog()  // 用缓存重渲染，保持当前选中（同 V1 处理器）
            setTimeout(() => setManageCurrent(keep), 50)
          },
        },
      ],
    }).then((v0) => {
      if (v0 === undefined) return
      const v = String(v0)
      if (!v.startsWith("sub:")) return
      const sid = v.slice(4)
      setManageCurrent(v)
      try { api.ui.router.navigate({ type: "session", sessionID: sid }) } catch { api.ui.toast.show({ message: "跳转会话失败", variant: "error" }) }
    })
  }

  const subagentListDialog = () => {
    setManageOpen(true)
    setConfirmSub("")
    loadSubagentSessions().then(({ subs, statusMap }) => {
      setSubagentCache(subs)
      setSubStatusMap(statusMap)
      renderSubagentDialog()
    }).catch(() => {
      api.ui.toast.show({ message: "获取子代理会话失败", variant: "error" })
    })
  }

  pluginRefreshSubagents = (deletedSid?: string) => {
    if (deletedSid) {
      const desc = subSortDesc()
      const sorted = [...subagentCache()].sort((a, b) => desc
        ? (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
        : (a.time?.updated ?? 0) - (b.time?.updated ?? 0))
      subDeleteIndex = sorted.findIndex(s => s.id === deletedSid)
      setSubagentCache(prev => prev.filter(s => s.id !== deletedSid))
    }
    if (manageOpen()) renderSubagentDialog()
  }

  pluginCleanupSubagents = () => {
    // 与 server 插件共享同一把清理锁，防跨进程并发重复删
    const lockFile = "/tmp/opencode/goal-cleanup.lock"
    try {
      const now = Date.now()
      const old = readFileSync(lockFile, "utf8")
      const oldTs = parseInt(old, 10)
      if (Number.isFinite(oldTs) && now - oldTs < 120000) {
        api.ui.toast.show({ message: "2 分钟内已有子代理清理在执行，本次跳过", variant: "info" })
        return
      }
      writeFileSync(lockFile, String(now))
    } catch {}
    // 手动清理：不受天数限制，清理所有已完成/已失败子代理（进行中/重试/未知 一律跳过）
    loadSubagentSessions().then(({ subs, statusMap }) => {
      const targets = subs.filter(s => statusMap[s.id] === "已完成" || statusMap[s.id] === "已失败")
      const skipped = subs.filter(s => statusMap[s.id] !== "已完成" && statusMap[s.id] !== "已失败").length
      if (targets.length === 0) {
        api.ui.toast.show({ message: `没有已完成/已失败的子代理会话${skipped > 0 ? `（${skipped} 个进行中/重试/未知已跳过）` : ""}`, variant: "info" })
        return
      }
      const ids = targets.map(s => s.id)
      api.ui.toast.show({ message: `开始清理 ${targets.length} 个子代理会话${skipped > 0 ? `（跳过 ${skipped} 个进行中/重试/未知）` : ""}…`, variant: "info" })
      let done = 0
      let failed = 0
      ids.forEach(sid => {
        pluginApi?.client.session.remove({ sessionID: sid }).then(() => {
          deleteGoalIfExists(sid)  // 子会话目标记录同步清理
          done++
          pluginRefreshSubagents(sid)
          if (done + failed === ids.length) {
            api.ui.toast.show({ message: `已清理 ${done} 个子代理会话${failed ? `，${failed} 个失败` : ""}`, variant: "success" })
            pluginRefresh()
          }
        }).catch(() => {
          failed++
          if (done + failed === ids.length) {
            api.ui.toast.show({ message: `已清理 ${done} 个子代理会话${failed ? `，${failed} 个失败` : ""}`, variant: "success" })
            pluginRefresh()
          }
        })
      })
    }).catch(() => {
      api.ui.toast.show({ message: "获取会话列表失败", variant: "error" })
    })
  }

  // V2：api.keymap.registerLayer({commands,bindings}) → api.keymap.layer(() => ({mode:"global", commands:[…] }))
  //     命令键名 name→id、category→group、namespace:"palette"→palette:true；原 bindings 列表的按键逐条搬到对应命令的 bind（V2 的按键挂在命令上）
  api.keymap.layer(() => ({ mode: "global",
    commands: [
      {
        id: "goal.panel.toggle",
        palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
        title: "Goal：收起/展开目标面板",
        group: "Goal",
        palette: true,   // V2：V1 的 namespace:"palette" → palette:true
        bind: "ctrl+shift+g",
        run() {
          setCollapsed(!collapsed())
        },
      },
    ],
    bindings: [{ key: "ctrl+shift+g", cmd: "goal.panel.toggle", desc: "收起/展开目标面板" }],   // V2：已并入 goal.panel.toggle 命令的 bind（见上）
  }))

  // V2：api.keymap.registerLayer({commands,bindings}) → api.keymap.layer(() => ({mode:"global", commands:[…] }))
  //     命令键名 name→id、category→group、namespace:"palette"→palette:true；原 bindings 列表的按键逐条搬到对应命令的 bind（V2 的按键挂在命令上）
  api.keymap.layer(() => ({ mode: "global",
    commands: [
      {
        id: "goal.manage.sort",
        palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
        title: "子代理/Fork 列表：切换时间排序",
        group: "Goal",
        bind: "ctrl+o",   // V1 的全局绑定原样恢复（V1 `bindings:[{key:"ctrl+o",cmd:…}]` 等价物；由 run() 内的 open 判定守护）
        run() {
          if (forkOpen()) {
            const keep = forkCurrent()
            setForkSortDesc(!forkSortDesc())
            forkGoalDialog()
            setForkCurrent(keep)
            return
          }
          if (!manageOpen()) return
          const v = manageCurrent()
          if (!v || !v.startsWith("sub:")) return
          const keep = v
          setSubSortDesc(!subSortDesc())
          renderSubagentDialog()  // 用缓存重渲染，保持当前选中
          setTimeout(() => setManageCurrent(keep), 50)
        },
      },
      {
        id: "goal.fork.execute.full",
        palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
        title: "Fork 目标：完整复制到当前会话（含阶段/迭代/方案文档）",
        group: "Goal",
        bind: "ctrl+1",
        run() {
          if (!forkOpen()) return
          doForkGoal("full")
        },
      },
      {
        id: "goal.fork.execute.text",
        palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
        title: "Fork 目标：仅目标文本复制到当前会话",
        group: "Goal",
        bind: "ctrl+2",
        run() {
          if (!forkOpen()) return
          doForkGoal("text")
        },
      },
      {
        id: "goal.fork.execute",
        palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
        title: "Fork 目标：复制选中目标到当前会话（默认完整复制）",
        group: "Goal",
        bind: "ctrl+y",
        run() {
          if (!forkOpen()) return
          doForkGoal("full")
        },
      },
      {
        id: "goal.manage.delete",
        palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
        title: "目标列表：删除选中项",
        group: "Goal",
        bind: "ctrl+d",
        run() {
          kbdLog(`GLOBAL run goal.manage.delete manageOpen=${manageOpen()} current=${manageCurrent()} confirmGoal=${confirmGoal()} confirmSub=${confirmSub()}`)
          if (!manageOpen()) return
          const v = manageCurrent()
          if (!v) return
          if (v.startsWith("sub:")) {
            const sid = v.slice(4)
            if (confirmSub() !== sid) {
              setConfirmSub(sid)
              return
            }
            setConfirmSub("")
            deleteSubagentSession(sid)
            return
          }
          const sid = v.startsWith("goal:") ? v.slice(5) : v
          if (!loadGoals()[sid]) return
          if (confirmGoal() !== sid) {
            setConfirmGoal(sid)
            return
          }
          setConfirmGoal("")
          doClear(sid)
        },
      },
    ],
    // V1 的 5 条全局绑定（desc 原文）——按 V2 形态挂在对应命令的 bind 上：
    //   ctrl+o → goal.manage.sort（子代理/Fork 列表切换时间排序（需先打开 /goal-subs 或 /goal-fork））
    //   ctrl+1 → goal.fork.execute.full（Fork 完整复制（含阶段/迭代，需先打开 /goal-fork））
    //   ctrl+2 → goal.fork.execute.text（Fork 仅目标文本（需先打开 /goal-fork））
    //   ctrl+y → goal.fork.execute（Fork 完整复制（默认，需先打开 /goal-fork））
    //   ctrl+d → goal.manage.delete（目标列表删除选中项（需先打开 /goal-all 或 /goal-subs））
    //   ⚠ 2026-10-16 修复：上一版误把这 5 条降级成注释（bind 全丢）→ 弹窗快捷键失效；现按 V1 原样恢复。
    //   注：V2 层 mode:"global" = 在所有输入模式生效（含弹窗的 modal 模式），与 V1 全局绑定同语义。
  }))

  // 诊断（debugEvents=true 时）：加载标记（确认 TUI 半跑的是最新代码）
  //   ⚠ 命令清单的诊断**必须放在 setup 末尾**：keymap 层是按代码顺序注册的，
  //     放在这里（第三个命令层还没注册）会误报"只注册了 6 条 goal 命令"。
  try {
    kbdLog(`TUI 插件已加载 inst=${INSTANCE_TAG}：重绘=V1 信号局部刷新零 invalidate；currentSid=V2 Route 修正；setup 返回 cleanup`)
  } catch (e) { kbdLog(`加载标记异常 ${String(e)}`) }

  // V2：api.event.on → api.data.on；事件名换成 V2 里存在的等价事件（实测诊断日志核对过）：
  //   V1 todo.updated（todowrite 工具事件）→ session.tool.success（工具成功时刷新）
  //   V1 message.updated（assistant 消息信息更新，含 token/成本——面板实时刷新就靠它）
  //     → V2 语义等价物 = session.usage.updated（实测 ~10 次/轮）；另补生成过程中的高频事件，避免面板"慢半拍"
  //   session.idle 同名保留；负载从 e.properties 换成 e.data
  //   ⚠ 修正（2026-10-16）：上一版映射成 session.message.content.updated —— 该事件在 V2 不存在（实测日志 0 次），
  //     订阅成死链 ⇒ 面板退化成只在工具成功/10 秒轮询时刷新（用户反馈"右侧目标刷新有点慢"）。改为下面这组真实事件。
  // ── 资源清理工具（**必须在所有 onData/订阅之前定义**）──
  //   ⚠ 实测坑（2026-10-17，真根因）：把 keepTimer/keepWatcher 定义在订阅之后 ⇒ const 的 TDZ ⇒
  //     每一处 onData 都抛 `Cannot access 'keepWatcher' before initialization` ⇒ 订阅**全部静默失效**
  //     （面板只能退化成轮询、permission.asked 收不到 ⇒ 自动批准要等 10 秒对账）。故前置定义。
  const disposers: (() => void)[] = []
  const keepTimer = (t: ReturnType<typeof setInterval>) => { disposers.push(() => clearInterval(t)); return t }
  const keepWatcher = (w: { close?: () => void }) => { disposers.push(() => { try { w.close?.() } catch {} }); return w }

  const onPanelEvent = (e: any) => {
    const sid = (e?.data?.sessionID ?? e?.data?.info?.sessionID) as string | undefined
    refresh(sid, `event:${String(e?.type ?? "?")}`)
    ensureAutoAccept()
    void refreshScopeCache()          // 家族集合保持新鲜：内存过滤与即时应答都依赖它
  }
  // ⚠ `api.data.on(...)` 返回 `() => void` 退订函数，
  //   此前 6 处（+ 下面 3 处 execution.* ）都没收进 disposers ⇒ 热重载后旧实例的事件订阅仍活着（泄漏）。
  const onData = (ev: Parameters<typeof api.data.on>[0], handler: (e: unknown) => void) => {
    try { keepWatcher({ close: api.data.on(ev, handler as never) as unknown as () => void }) } catch (e) { kbdLog(`订阅 ${String(ev)} 失败：${String(e)}`) }
  }
  onData("session.tool.success", onPanelEvent)     // 等价 V1 todo.updated
  onData("session.usage.updated", onPanelEvent)    // 等价 V1 message.updated（面板刷新的主力）
  onData("session.tool.progress", onPanelEvent)    // 工具执行中（长命令期间面板不"卡住不动"）
  onData("session.step.streamed", onPanelEvent)    // 生成过程中（流式）
  onData("session.step.ended", onPanelEvent)       // 每次 step 收尾
  onData("session.idle", onPanelEvent)
  // 内存点 ①：权限请求到达 ⇒ 命中目标家族（主 + 子代理）即刻应答一次（V1 同路径：permission.asked → reply once）
  onData("permission.asked" as Parameters<typeof api.data.on>[0], (e: unknown) => {
    void (async () => {
      try {
        if (!configAutoApprove()) return
        const ev = e as { data?: { sessionID?: string, id?: string, requestID?: string } }
        const sid = String(ev?.data?.sessionID ?? "")
        const rid = String(ev?.data?.id ?? ev?.data?.requestID ?? "")
        if (!sid || !rid) return
        await refreshScopeCache()                    // 先实时重算（不用可能过期的缓存 ⇒ 暂停后不再误批）
        if (!scopeCache.has(sid)) return
        await replyOnce(sid, rid)
      } catch (err) { aaDebug(`permission.asked 处理异常: ${String(err)}`) }
    })()
  })
  // 启动时对当前会话对齐（同步执行；路由未就绪时由事件触发补上）
  aaDebug("calling ensureAutoAccept on load")
  ensureAutoAccept()

  // ── 资源清理（V2 官方约定：setup 返回 cleanup，插件被 reload 时宿主调用它；工具定义见上方）──
  //   ⚠ 不清理的后果实测过：旧实例的 interval/watch 一直活着 ⇒ 同一条通知被弹 3 次、
  //     日志被旧实例刷屏、旧实例还持有已废弃的 signal/slot 引用。
  keepTimer(setInterval(() => { refresh(currentSid(), "poll:10s"); ensureAutoAccept(); void reconcilePending() }, 10000))
  // ⚠ 为什么监听“目录”而不是 goals.json 文件本身：
  //   两半边的 saveGoals 都是「写 tmp + renameSync」原子改名 ⇒ 目标文件 inode 每次都变，
  //   fs.watch(文件) 绑定的旧 inode 在第一次改名后**再也不会触发**（旧版靠高频 message.updated 掩盖了该缺陷），
  //   表现就是「设置目标后面板要等一会儿才更新」「子代理第二次设目标面板看不到」。
  //   V2 的事件订阅已修好（见上方 usage.updated 等），这里再把文件监听修稳：监听目录 + 按文件名过滤。
  try {
    keepWatcher(watch(stateDir, (_ev, fn) => {
      const name = fn === undefined || fn === null ? "" : String(fn)
      if (!name || name.includes("goals.json")) refresh(currentSid(), `watch:${name || "?"}`)
      if (!name || name.includes("config.json")) ensureAutoAccept()
    }))
  } catch {
    try { keepWatcher(watch(goalsFile, () => refresh(currentSid(), "watch:file-fallback"))) } catch {}      // 兜底：目录监听失败时退回旧写法
    try { keepWatcher(watch(configFile, () => ensureAutoAccept())) } catch {}
  }

  // V2：通知队列 → toast（等价 V1 由 server 侧 client.tui.showToast 弹的那些提示）
  //   server 半边写 ~/.local/state/goal/notify.jsonl（每行 {at,pid,kind,message}），这里增量读出并 api.ui.toast.show
  //   偏移记在 notify-offset.json（持久化，重启不重复弹）；队列被 server 自限长截断时自动从头读
  let notifyOffset = 0
  try { const t = readFileSync(notifyOffsetFile, "utf8").trim(); if (t) notifyOffset = parseInt(t, 10) || 0 } catch {}
  const drainNotify = () => {
    try {
      const size = statSync(notifyFile).size
      if (size < notifyOffset) notifyOffset = 0
      if (size === notifyOffset) return
      const fd = openSync(notifyFile, "r")
      try {
        const buf = Buffer.alloc(size - notifyOffset)
        readSync(fd, buf, 0, buf.length, notifyOffset)
        let allOk = true
        for (const line of buf.toString("utf8").split("\n")) {
          if (!line.trim()) continue
          try {
            const rec = JSON.parse(line) as { kind?: string; message?: string }
            const kind = String(rec.kind ?? "info") as "info" | "success" | "warning" | "error"
            const msg = String(rec.message ?? "")
            // duration 是官方 schema 的显式字段（可不传）⇒ 不传时显示时长不可靠，显式给 8 秒
            api.ui.toast.show({ message: msg, variant: kind, duration: 8000 })
            // 重要通知（暂停/错误）再加一道**系统通知**兜底：即使 TUI 内的提示条不显示，也能看到
            if (kind === "warning" || kind === "error") {
              try {
                void (api as unknown as { attention?: { notify?: (o: unknown) => Promise<unknown> } }).attention?.notify?.({
                  title: "OpenCode 目标",
                  message: msg,
                  notification: { when: "always" },
                  sound: { name: "default", volume: 0.4, when: "always" },
                })
              } catch {}
            }
            kbdLog(`notify→toast 成功: ${msg.slice(0, 44)}`)
          } catch (e) {
            allOk = false
            // 不再静默：弹失败必须留痕（此前 catch{} 把提示吃掉，且偏移已推进 ⇒ 窗口里永远看不到提示）
            kbdLog(`notify→toast 失败: ${String(e)} | 原文=${line.slice(0, 80)}`)
          }
        }
        // 失败也要推进偏移（并留痕）：否则同一条通知每秒重试 ⇒ 弹窗风暴/刷屏
        notifyOffset = size
        writeFileSync(notifyOffsetFile, String(notifyOffset))
        if (!allOk) kbdLog(`notify 弹出有失败条目，已跳过（避免每秒重试）`)
      } finally { closeSync(fd) }
    } catch (e) { kbdLog(`drainNotify 异常: ${String(e)}`) }
  }
  drainNotify()
  keepTimer(setInterval(drainNotify, 1000))
  try { keepWatcher(watch(notifyFile, () => drainNotify())) } catch {}

  // ⚠ 缺口修复（2026-10-17）：TUI 侧此前**没有订阅打断事件**，ESC 打断后只能等文件 watch / 1 秒轮询
  //   去发现状态变了，而 watch 会漏 ⇒ 面板与提示条时好时坏（用户反馈"又没有了"）。
  //   这里直接订阅服务端事件：打断/执行结束 ⇒ 立即刷新面板 + 立即消费通知（不等 watch、不等轮询）。
  for (const ev of ["session.execution.interrupted", "session.execution.succeeded", "session.execution.failed"]) {
    onData(ev as Parameters<typeof api.data.on>[0], () => { refresh(currentSid(), `event:${ev}`); drainNotify() })
  }

  // V2：api.slots.register({slots:{"sidebar_content":(ctx,props)=>…}}) → api.ui.slot({ append:"sidebar.content", render:(input)=>… })
  //     render 入参由 V1 的 (ctx, props) 变成 V2 的 input（sidebar.content 提供 {sessionID}）；主题色改从 api.theme 取
  api.ui.slot({
    append: "sidebar.content",
    render: (input: { sessionID: string }) => (() => {
      // ── 响应式包装（官方同款；对齐 V1 的局部刷新）──
      //   对照 opencode 侧栏官方插件（opencode.sidebar.context / .mcp）的真实写法：
      //     t.ui.slot({ append:"sidebar.content", render:(n)=> a(Comp,{ get sessionID(){return n.sessionID} }) })
      //     内部   const s = D(()=> t.context.data.session.get(t.sessionID))     // D = createMemo
      //   ⇒ 官方靠"**createMemo 包数据 + 在 JSX 里读 memo**"建立响应式：JSX 里的读取会被编译成计算，
      //     memo 一变就只重绘那一处。之前的"函数子节点"写法在这套渲染器里不是跟踪计算，
      //     所以渲染日志只看得到 active、看不到 paused（宿主不重绘时面板永远停在旧画面）。
      const view = createMemo(() => {
        if (input?.sessionID) lastPanelSessionID = String(input.sessionID)   // currentSid() 兜底
        const __inst = INSTANCE_TAG   // 实例标记：用于确认"眼前这个面板"到底是哪个实例在渲染
        const theme = api.theme as unknown as Record<string, string>
        const fg = (c?: string) => c ? { fg: c } : {}
        const stateColor = (s: string) =>
          s === "active" ? theme.primary : s === "done" ? theme.success : s === "paused" ? theme.text : s === "limited" || s === "stuck" ? theme.error : s === "iterating" ? theme.warning : theme.textMuted
        const g = goals()
        sessionCollapsed()
        goalTextCollapsed()
        stageTodosCollapsed()
        // 诊断（debugEvents=true）：面板**是否真的重绘到了新状态**（每个状态变化只记一行，零噪）
        {
          const st = g[input.sessionID]?.state
          if (st !== lastRenderedState) { lastRenderedState = st; kbdLog(`面板重绘：state=${st ?? "-"} inst=${__inst}（响应式生效）`) }
        }
        const entries = Object.entries(g).filter(([, e]) => e.state !== "cleared" && e.state !== "done")
        const own = g[input.sessionID]
        const others = entries.filter(([k]) => k !== input.sessionID)
        const isCollapsed = (sid: string) => sessionCollapsed()[sid] === true
        const statusIcon = (s: string) => ({ in_progress: "●", completed: "✓", pending: "○", cancelled: "✕" }[s] ?? "○")
        const sessionBlock = (sid: string, e: GoalEntry, label: string) => {
          const c = isCollapsed(sid)
          const iterOn = configIterateMode() || !!e.iteration
          // 一个会话的多个目标条目：历史（旧轮，升序 第1轮 第2轮…）+ 当前（最新）；每个条目完整快照（目标/阶段含代办/状态/流程/轮数）
          const items = [
            ...(e.history ?? []).map((h) => ({
              goal: h.goal,
              count: h.count,
              current: false,
              stages: h.stages,
              state: h.state,
              flow: h.flow,
              turns: h.turns,
              maxTurns: h.maxTurns,
            })),
            { goal: e.goal, count: e.iteration?.count ?? (e.history?.length ?? 0), current: true, stages: e.stages, state: e.state, flow: e.flow, turns: e.turns, maxTurns: e.maxTurns },
          ]
          return (
            <box flexDirection="column">
              <box flexDirection="row" gap={1} onMouseDown={() => setSessionCollapsed(s => ({ ...s, [sid]: !s[sid] }))}>
                <text fg={theme.text}>{c ? "▶" : "▼"}</text>
                <text fg={stateColor(e.state)} paddingLeft={1}>{label}</text>
              </box>
              <Show when={!c}>
                <box flexDirection="column" paddingX={1}>
                  <For each={items}>
                    {(item, idx) => {
                      const key = `${sid}:goal:${item.count}`  // L4：用迭代轮 count 做 stable key（防 history 增删导致索引平移串位）
                      const gt = goalTextCollapsed()[key] !== false
                      return (
                        <box flexDirection="column">
                          <box flexDirection="row" gap={1} onMouseDown={() => setGoalTextCollapsed(st => ({ ...st, [key]: !(st[key] ?? true) }))}>
                            <text fg={theme.text}>{gt ? "▶" : "▼"}</text>
                            <text fg={item.current ? stateColor(item.state ?? "active") : theme.text} paddingLeft={1}>
                              <b>{iterOn ? `第${item.count + 1}轮` : `目标${items.length > 1 ? ` ${idx() + 1}` : ""}`}：{item.goal.length > summaryLen() ? item.goal.slice(0, summaryLen()) + "…" : item.goal}</b>
                            </text>
                          </box>
                          <Show when={!gt}>
                            <scrollbox maxHeight={4} verticalScrollbarOptions={{ trackOptions: { fg: "gray" } }}>
                              <text wrap="wrap" fg={theme.text}>{item.goal}</text>
                            </scrollbox>
                          </Show>
                          <Show when={item.stages && item.stages.length > 0}>
                            <For each={item.stages}>
                              {(s) => {
                                const key2 = `${sid}:goal:${idx()}:${s.id}`
                                const coll = stageTodosCollapsed()[key2] ?? s.status === "completed"
                                return (
                                  <box flexDirection="column" paddingLeft={2}>
                                    <box flexDirection="row" gap={1} onMouseDown={() => setStageTodosCollapsed(st => ({ ...st, [key2]: !(st[key2] ?? s.status === "completed") }))}>
                                      {s.status === "pending" ? (
                                        <text fg={theme.text}>○</text>
                                      ) : (
                                        <text fg={theme.text}>{coll ? "▶" : "▼"}</text>
                                      )}
                                      <text style={fg(s.status === "completed" ? theme.success : s.status === "in_progress" ? theme.primary : theme.text)} paddingLeft={1}>{s.name ?? s.content ?? ""}</text>
                                    </box>
                                    <Show when={!coll && s.todos && s.todos.length > 0}>
                                      <box flexDirection="column" paddingX={2}>
                                        <For each={s.todos}>
                                          {(t) => (
                                            <text wrap="wrap" style={fg(t.status === "completed" ? theme.success : t.status === "in_progress" ? theme.primary : theme.text)}>
                                              {t.status === "in_progress" ? "▶" : t.status === "completed" ? "✓" : "○"} [{t.status}] {t.content}
                                            </text>
                                          )}
                                        </For>
                                      </box>
                                    </Show>
                                  </box>
                                )
                              }}
                            </For>
                          </Show>
                          <Show when={(!item.stages || item.stages.length === 0) && item.current && sid === input.sessionID && item.state === "active"}>
                            <text fg={theme.textMuted}>（阶段未规划，AI 规划中…）</text>
                          </Show>
                          <box flexDirection="row" gap={1}>
                            <text fg={stateColor(item.state ?? "active")}>●</text>
                            <text fg={stateColor(item.state ?? "active")} paddingLeft={1}>{statusText(item.state ?? "active")} | 流程：{flowText(item.flow)} | 轮数：{turnsText(item.turns ?? 0, item.maxTurns ?? 0)}{iterOn ? ` | ${iterText(item.count)}` : ""}</text>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </Show>
            </box>
          )
        }
        return (
          <box flexDirection="column" paddingY={1}>
            <box flexDirection="row" gap={1} onMouseDown={() => setCollapsed(!collapsed())}>
              <text fg={theme.text}>{collapsed() ? "▶" : "▼"}</text>
              <text fg={theme.text}><b>目标推进</b></text>
            </box>
            <Show when={!collapsed()}>
              <Show when={entries.length === 0}>
                <text fg={theme.textMuted} paddingX={1}>无活跃目标，请用 Tab 或者 /goal</text>
              </Show>
              <Show when={own && own.state !== "cleared" && own.state !== "done"}>
                {sessionBlock(input.sessionID, own, "本会话")}
              </Show>
              <Show when={own && own.state !== "cleared" && own.state !== "done" && others.length > 0}>
                <text> </text>
              </Show>
              <For each={others}>
                {([sid, e]) => sessionBlock(sid, e, fmtSid(sid))}
              </For>
            </Show>
          </box>
        )
      })
      return <box flexDirection="column">{view()}</box>
    })(),
  })

  // V2：api.command.register(() => [{title,value,category,slash,onSelect}]) → api.keymap.layer(() => ({ mode:"global", commands:[{id,title,group,slash,run}] }))
  //     字段映射：value→id、category→group、onSelect→run（slash 的 name/aliases 形态 V2 一致）
  api.keymap.layer(() => ({ mode: "global", commands: [
    {
      title: "Goal：目标列表管理",
      id: "goal.manage",
      palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
      description: "弹出列表选择任意会话目标（含子代理遗留）：Enter 管理（查看/更新/恢复/暂停/跳转/删除目标），Ctrl + d 删除",
      group: "Goal",
      // V2：V1 的 aliases 在本版会被渲染成独立条目（多余）→ 按用户要求去掉只留主名（主名与 V1 完全一致）
      slash: { name: "goal-all" },
      run: () => goalManageDialog(),
    },
    {
      title: "Goal：子代理会话列表",
      id: "goal.subagents",
      palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
      description: "全部子代理会话：Enter 跳转会话，Ctrl+d 删除，Ctrl+o 切换时间排序，输入搜索",
      group: "Goal",
      slash: { name: "goal-subs" },
      run: () => subagentListDialog(),
    },
    {
      title: "Goal：Fork 目标",
      id: "goal.fork",
      palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
      description: "从所有目标中复制一个到当前会话（回车选中/取消，Ctrl+y 复制，主会话在前+时间最新排序，Ctrl+o 切换）",
      group: "Goal",
      slash: { name: "goal-fork" },
      run: () => forkGoalDialog(),
    },
    {
      title: "Goal：更新目标",
      id: "goal.update",
      palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
      description: "实时修改当前会话目标（保存后立即通知 AI）",
      group: "Goal",
      slash: { name: "goal-update" },
      // V2：命令 run 不再注入 dialog 控制器 → <api.ui.DialogPrompt/>+dialog.replace 改 api.ui.dialog.prompt（Promise 式）
      run: () => {
        const sid = currentSid()
        const e = sid ? loadGoals()[sid] : undefined
        if (!sid || !e || e.state === "cleared" || e.state === "done") {
          api.ui.toast.show({ message: "当前会话没有活跃目标，请先用 /goal 设置", variant: "warning" })
          return
        }
        void api.ui.dialog.prompt({
          title: `更新目标（会话 ${fmtSid(sid)}）`,
          value: e.goal,
        }).then((v) => {
          if (v === undefined) return   // 取消（等价 V1 的 onCancel）
          const g = v.trim()
          if (!g) {
            api.ui.toast.show({ message: "目标不能为空", variant: "error" })
            return
          }
          const goals = loadGoals()
          if (!goals[sid]) {
            api.ui.toast.show({ message: "目标已不存在", variant: "error" })
            return
          }
          goals[sid] = { ...goals[sid], goal: g, updatedAt: Date.now() }
          saveGoals(goals)
          setGoals(goals)
          if (goals[sid].state === "active") {
            notifySession(sid, `【目标更新】目标已修改为：${g}。请以新目标为准，重新评估当前进度与计划，必要时调整方向，继续推进直到完成。`)
            api.ui.toast.show({ message: "目标已更新，已立即通知 AI", variant: "success" })
          } else {
            api.ui.toast.show({ message: "目标已更新（暂停中，恢复后生效）", variant: "info" })
          }
          // 列表里那条的文案会变（状态摘要用目标前 N 字）⇒ 重渲染，避免"更新了但列表没变"
          if (manageOpen()) goalManageDialog()
        })
      },
    },
    {
      title: "Goal：设置配置",
      id: "goal.config",
      palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
      description: "多配置：轮数上限 / 摘要字数 / 清理天数 / 自动批准权限 / 子代理保留上限（立即生效）",
      group: "Goal",
      slash: { name: "goal-config" },
      run: () => {   // V2：命令 run 不再注入 dialog 控制器
        // V2：配置项输入改用 api.ui.dialog.prompt（Promise 式；placeholder/value 初值原样保留）
        const promptConfig = (key: "maxTurns" | "summaryLen" | "cleanupDays" | "maxRetainedSubagents" | "iterateMaxRounds" | "pushIntervalMs", title: string, placeholder: string, current: number, validate: (n: number) => boolean, errMsg: string) => {
          void api.ui.dialog.prompt({
            title,
            placeholder,
            value: String(current),
          }).then((v) => {
            if (v === undefined) return   // 取消（等价 V1 的 onCancel）
            let n: number
            if (key === "cleanupDays") {
              n = parseFloat(v)
            } else if (key === "pushIntervalMs") {
              n = Math.round(parseFloat(v) * 60000)
            } else {
              n = parseInt(v, 10)
            }
            if (!Number.isFinite(n) || !validate(n)) {
              api.ui.toast.show({ message: errMsg, variant: "error" })
              return
            }
            writeConfig({ [key]: n })
            const display = key === "pushIntervalMs" ? `${n / 60000} 分钟` : String(n)
            api.ui.toast.show({ message: `${title}已设置为 ${display}，立即生效`, variant: "success" })
          })
        }
        // V2：<api.ui.DialogSelect …/> + dialog.replace → api.ui.dialog.select（Promise）；选项列表与分发链原样保留
        void api.ui.dialog.select<string>({
          title: "目标推进配置",
          placeholder: "选择要修改的配置项",
          options: [
                {
                  title: `轮数上限：当前 ${configMaxTurns()}`,
                  value: "maxTurns",
                  description: "目标自动推进的最大轮数",
                },
                {
                  title: `推送间隔：当前 ${pushIntervalMin()} 分钟`,
                  value: "pushIntervalMs",
                  description: "AI 自主连续干活时，每 N 分钟推送一次阶段/代办提醒（默认 5 分钟）",
                },
                {
                  title: `目标摘要字数：当前 ${configSummaryLen()}`,
                  value: "summaryLen",
                  description: "目标在面板/列表中的默认摘要显示字数",
                },
                {
                  title: `方案文档位置：当前 ${configPlanDir() === "workspace" ? "工作区 .plan" : configPlanDir() === "default" ? "/tmp/plan（默认）" : configPlanDir()}`,
                  value: "planDir",
                  description: "方案文档生成位置：默认 /tmp/plan / 工作区 .plan / 自定义路径",
                },
                {
                  title: `子代理清理天数：当前 ${cleanupDays()}`,
                  value: "cleanupDays",
                  description: "自动/手动清理仅删已完成/已失败子代理（进行中/重试/未知跳过）",
                },
                {
                  title: `子代理保留上限：当前 ${maxRetained()} 个`,
                  value: "maxRetainedSubagents",
                  description: "已完成/失败子代理最大保留数量，超出自动删除最旧的（0=不限制）",
                },
                {
                  title: `迭代模式：当前 ${configIterateMode() ? "开启" : "关闭"}`,
                  value: "iterateMode",
                  description: "开启后 audit 进入迭代循环（首次询问方向，后续不再询问自主迭代，用户可随时更新目标）",
                },
                {
                  title: `迭代轮数上限：当前 ${configIterateMaxRounds() === 0 ? "无限" : configIterateMaxRounds()}`,
                  value: "iterateMaxRounds",
                  description: "迭代模式最多迭代轮数，0=无限（防止 AI 无限迭代偏离）",
                },
                {
                  title: `迭代询问模式：当前 ${configIterAskMode() === "every" ? "每轮询问" : "仅首轮询问"}`,
                  value: "iterAskMode",
                  description: "迭代开始前是否询问用户方向/限制：仅首轮询问（会话内一次全局生效）或每轮迭代都询问",
                },
                {
                  title: `目标完成默认删除：当前 ${configAuditDelete() ? "是" : "否"}`,
                  value: "auditDelete",
                  description: "audit/finish 后按此配置删除或保留目标（配置优先级最高；迭代模式：audit 保留待迭代，finish 结束同样按本配置处理）",
                },
                {
                  title: `Fork 目标默认暂停：当前 ${configForkPaused() ? "是" : "否"}`,
                  value: "forkPaused",
                  description: "Fork 目标到当前会话后默认暂停（需 /goal-resume 恢复），关闭则 Fork 后立即推进",
                },
                {
                  title: `自动批准权限：当前 ${autoApprove() ? "开启" : "关闭"}`,
                  value: "autoApprovePermissions",
                  description: "开启后所有权限请求自动允许（不再弹出确认，含子代理）",
                },
          ],
        }).then((v0) => {
          if (v0 === undefined) return
          const key = String(v0)
                if (key === "maxTurns") promptConfig("maxTurns", "设置目标轮数上限", "输入数字（0=无限），如 100", configMaxTurns(), n => n >= 0 && Number.isInteger(n), "请输入不小于 0 的整数（0=无限）")
                else if (key === "summaryLen") promptConfig("summaryLen", "设置目标摘要字数", "输入字数，如 30", configSummaryLen(), n => n >= 5 && Number.isInteger(n), "请输入不小于 5 的整数")
                else if (key === "cleanupDays") promptConfig("cleanupDays", "设置子代理清理天数", "输入天数，如 3", cleanupDays(), n => n > 0, "请输入有效正数")
                else if (key === "pushIntervalMs") promptConfig("pushIntervalMs", "设置推送间隔", "输入分钟数，如 5", pushIntervalMin(), n => n >= 1, "请输入有效正数（分钟）")
                else if (key === "autoApprovePermissions") {
                  const now = autoApprove()
                  // V2：嵌套 <api.ui.DialogSelect/> + dialog.replace → api.ui.dialog.select（Promise）
                  void api.ui.dialog.select<string>({
                    title: "自动批准权限",
                    placeholder: "选择操作",
                    options:
                      now
                        ? [{ title: "关闭自动批准（当前：开启）", value: "off", description: "恢复权限询问（TUI 弹窗确认）" }]
                        : [{ title: "开启自动批准（当前：关闭）", value: "on", description: "所有权限请求自动允许，不弹确认" }],
                  }).then((o2) => {
                    if (o2 === undefined) return
                    const v = String(o2) === "on"
                    setAutoApproveConfig(v)
                  })
                }
                else if (key === "maxRetainedSubagents") promptConfig("maxRetainedSubagents", "设置子代理保留上限", "输入数量（0=不限制），如 50", maxRetained(), n => n >= 0 && Number.isInteger(n), "请输入不小于 0 的整数")
                else if (key === "iterateMaxRounds") promptConfig("iterateMaxRounds", "设置迭代轮数上限", "输入数字（0=无限），如 5", configIterateMaxRounds(), n => n >= 0 && Number.isInteger(n), "请输入不小于 0 的整数（0=无限）")
                else if (key === "iterAskMode") {
                  const now = configIterAskMode()
                  // V2：嵌套 <api.ui.DialogSelect/> + dialog.replace → api.ui.dialog.select（Promise）
                  void api.ui.dialog.select<string>({
                    title: "迭代询问模式",
                    placeholder: "选择模式",
                    options:
                      now === "every"
                        ? [{ title: "仅首轮询问（当前：每轮询问）", value: "first", description: "会话内首轮迭代询问一次方向/限制，全局生效，后续不再询问" }]
                        : [
                          { title: "每轮迭代都询问（当前：仅首轮询问）", value: "every", description: "每个迭代目标第 1 轮都询问用户方向/限制" },
                        ],
                  }).then((o2) => {
                    if (o2 === undefined) return
                    const v = String(o2 ?? "first") === "every" ? "every" : "first"
                    writeConfig({ iterAskMode: v })
                  })
                }
                else if (key === "planDir") {
                  const now = configPlanDir()
                  // V2：嵌套 select（含二级 prompt）→ api.ui.dialog.select / api.ui.dialog.prompt（Promise 链）
                  void api.ui.dialog.select<string>({
                    title: "方案文档位置",
                    placeholder: "选择方案文档生成位置",
                    options: [
                      { title: `/tmp/plan（默认）`, value: "default", description: "临时目录，重启可能丢失" },
                      { title: `工作区 .plan`, value: "workspace", description: "项目根目录下 .plan 文件夹，随项目持久化" },
                      { title: `自定义路径…`, value: "custom", description: `当前：${now !== "default" && now !== "workspace" ? now : "未设置"}` },
                    ],
                  }).then((o2) => {
                    if (o2 === undefined) return
                    const v = String(o2)
                    if (v === "custom") {
                      void api.ui.dialog.prompt({
                        title: "自定义方案文档路径",
                        placeholder: "输入绝对路径，如 /root/myproject/.plan",
                        value: now !== "default" && now !== "workspace" ? now : "",
                      }).then((pv) => {
                        if (pv === undefined) return
                        const p = pv.trim()
                        if (!p) { api.ui.toast.show({ message: "路径不能为空", variant: "error" }); return }
                        writeConfig({ planDir: p })
                        api.ui.toast.show({ message: `方案文档位置已设置为 ${p}`, variant: "success" })
                      })
                      return
                    }
                    writeConfig({ planDir: v })
                    api.ui.toast.show({ message: `方案文档位置已设置为 ${v === "workspace" ? "工作区 .plan" : "/tmp/plan（默认）"}，立即生效`, variant: "success" })
                  })
                }
                else if (key === "auditDelete") {
                  const now = configAuditDelete()
                  // V2：嵌套 <api.ui.DialogSelect/> + dialog.replace → api.ui.dialog.select（Promise）
                  void api.ui.dialog.select<string>({
                    title: "目标完成默认删除",
                    placeholder: "选择操作",
                    options:
                      now
                        ? [{ title: "关闭（完成后保留目标）", value: "off", description: "当前：完成后默认删除" }]
                        : [{ title: "开启（完成后默认删除）", value: "on", description: "当前：完成后保留目标" }],
                  }).then((o2) => {
                    if (o2 === undefined) return
                    const v = String(o2) === "on"
                    writeConfig({ auditDelete: v })
                    api.ui.toast.show({ message: `目标完成默认删除已${v ? "开启" : "关闭"}，立即生效`, variant: "success" })
                  })
                }
                else if (key === "iterateMode") {
                  const now = configIterateMode()
                  // V2：嵌套 <api.ui.DialogSelect/> + dialog.replace → api.ui.dialog.select（Promise）
                  void api.ui.dialog.select<string>({
                    title: "迭代模式",
                    placeholder: "选择操作",
                    options:
                      now
                        ? [{ title: "关闭迭代模式", value: "off", description: "当前：开启（audit 后进入迭代循环）" }]
                        : [{ title: "开启迭代模式", value: "on", description: "当前：关闭（audit 后直接收尾）" }],
                  }).then((o2) => {
                    if (o2 === undefined) return
                    const v = String(o2) === "on"
                    writeConfig({ iterateMode: v })
                    api.ui.toast.show({ message: `迭代模式已${v ? "开启" : "关闭"}，立即生效`, variant: "success" })
                  })
                }
                else if (key === "forkPaused") {
                  const now = configForkPaused()
                  // V2：嵌套 <api.ui.DialogSelect/> + dialog.replace → api.ui.dialog.select（Promise；选项三元式原样保留）
                  void api.ui.dialog.select<string>({
                    title: "Fork 目标默认暂停",
                    placeholder: "选择操作",
                    options:
                      now
                        ? [{ title: "关闭（Fork 后立即推进）", value: "off", description: "当前：Fork 后默认暂停" }]
                        : [{ title: "开启（Fork 后默认暂停）", value: "on", description: "当前：Fork 后立即推进" }],
                  }).then((o2) => {
                    if (o2 === undefined) return
                    const v = String(o2) === "on"
                    writeConfig({ forkPaused: v })
                    api.ui.toast.show({ message: `Fork 目标默认暂停已${v ? "开启" : "关闭"}，立即生效`, variant: "success" })
                  })
                }
        })
      },
    },
    {
      title: "Goal：停止清除目标",
      id: "goal.stop",
      palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
      description: "彻底停止当前会话目标推进并清除",
      group: "Goal",
      slash: { name: "goal-stop" },
      run: () => {
        const sid = currentSid()
        const e = sid ? loadGoals()[sid] : undefined
        if (!sid || !e || e.state === "cleared" || e.state === "done") {
          api.ui.toast.show({ message: "当前会话没有活跃目标", variant: "warning" })
          return
        }
        const goals = loadGoals()
        delete goals[sid]
        saveGoals(goals)
        setGoals(goals)
        api.ui.toast.show({ message: `目标已停止并清除（会话 ${fmtSid(sid)}）`, variant: "success" })
      },
    },
    {
      title: "Goal：暂停目标",
      id: "goal.pause",
      palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
      description: "暂停当前会话目标（保留目标，可恢复）",
      group: "Goal",
      slash: { name: "goal-pause" },
      run: () => {
        const sid = currentSid()
        const e = sid ? loadGoals()[sid] : undefined
        if (!sid || !e || e.state === "cleared" || e.state === "done") {
          api.ui.toast.show({ message: "当前会话没有活跃目标", variant: "warning" })
          return
        }
        // 复用唯一实现（与 /goal-all 管理弹窗的"暂停目标"完全同一条路径，含提示/重绘/硬掐回合全防线）
        doPause(sid)
      },
    },
    {
      title: "Goal：恢复目标",
      id: "goal.resume",
      palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
      description: "恢复当前会话已暂停的目标",
      group: "Goal",
      slash: { name: "goal-resume" },
      run: () => {
        const sid = currentSid()
        if (!sid) {
          api.ui.toast.show({ message: "请先进入一个会话", variant: "warning" })
          return
        }
        if (!loadGoals()[sid]) {
          api.ui.toast.show({ message: "当前会话没有目标", variant: "warning" })
          return
        }
        // 复用唯一实现（内部含 limited / 无需恢复 判定与提示，以及"恢复即唤醒一轮"的推送）
        doResume(sid)
      },
    },
    {
      title: "Goal：查看目标",
      id: "goal.status",
      palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
      description: "查看当前会话目标状态",
      group: "Goal",
      slash: { name: "goal-status" },
      run: () => {
        const sid = currentSid()
        const e = sid ? loadGoals()[sid] : undefined
        if (!sid || !e || e.state === "cleared" || e.state === "done") {
          api.ui.toast.show({ message: "当前会话没有活跃目标", variant: "warning" })
          return
        }
        api.ui.toast.show({
          title: `目标状态（${fmtSid(sid)}）`,
          message: `状态：${statusText(e.state)} | 流程：${flowText(e.flow)} | 轮数：${turnsText(e.turns, e.maxTurns)}${(e.iteration || configIterateMode()) ? ` | ${iterText(e.iteration?.count ?? 0)}` : ""}\n目标：${e.goal.length > summaryLen() ? e.goal.slice(0, summaryLen()) + "…" : e.goal}${(e.history ?? []).map(h => `\n迭代历史 第${h.count + 1}轮：${h.goal.length > 40 ? h.goal.slice(0, 40) + "…" : h.goal}`).join("")}`,
          variant: "info",
        })
      },
    },
    {
      title: "Goal：清理子代理",
      id: "goal.cleanup",
      palette: true,   // V2 必须显式声明才进命令面板（V1 靠 category 自动出现；漏了这条=命令面板里找不到）
      description: "清理所有已完成/已失败子代理会话（不受清理天数限制），子会话目标一并清理（进行中/重试/未知跳过，主会话不删，二次确认）",
      group: "Goal",
      slash: { name: "goal-cleanup" },
      run: () => {
        loadSubagentSessions().then(({ subs, statusMap }) => {
          const targets = subs.filter(s => statusMap[s.id] === "已完成" || statusMap[s.id] === "已失败")
          if (targets.length === 0) {
            api.ui.toast.show({ message: `没有已完成/已失败的子代理会话${subs.length - targets.length > 0 ? `（${subs.length - targets.length} 个其他状态跳过）` : ""}`, variant: "info" })
            return
          }
          void api.ui.dialog.confirm({
            title: "清理子代理会话",
            message: `确定清理 ${targets.length} 个已完成/已失败子代理会话？子会话目标记录一并清理（进行中/重试/未知跳过，主会话不删）。`,
          }).then((ok) => { if (ok) cleanupSubagentSessions() })
        }).catch(() => {
          api.ui.toast.show({ message: "获取会话列表失败", variant: "error" })
        })
      },
    },
    {
      title: "Goal：一键清除所有目标",
      id: "goal.clear-all",
      palette: true,
      description: "清除全部目标记录（推进中/已暂停/已完成/迭代中一律清除，不可恢复，需二次确认）",
      group: "Goal",
      slash: { name: "goal-clearall" },
      run: () => {
        const count = Object.keys(loadGoals()).length
        if (count === 0) {
          api.ui.toast.show({ message: "当前没有任何目标记录", variant: "info" })
          return
        }
        void api.ui.dialog.confirm({
          title: "一键清除所有目标",
          message: `确定清除全部 ${count} 个目标记录（含推进中/已暂停/已完成/迭代中）？清除后不可恢复，所有进程的目标推进将停止。`,
        }).then((ok) => {
          if (!ok) return
          saveGoals({})
          api.ui.toast.show({ message: `已清除全部 ${count} 个目标记录`, variant: "success" })
          pluginRefresh()
        })
      },
    },
  ] }))

  // 命令清单诊断（debugEvents=true 时）——**放在全部 keymap 层注册之后**：
  //   用于确认 11 条 Goal 命令是否真的进了命令面板/斜杠表（含 palette 标记，V2 必须显式声明才进面板）
  try {
    const allCmds = ((api.keymap as any).commands?.() ?? []) as { id?: string, palette?: boolean }[]
    const goalCmds = allCmds.filter((c) => String(c?.id ?? "").startsWith("goal."))
    const withPalette = goalCmds.filter((c) => c?.palette === true).map((c) => c.id)
    kbdLog(`keymap 总命令=${allCmds.length} | goal 命令 ${goalCmds.length} 条: ${goalCmds.map((c) => c.id).join(",")}`)
    // 权限链路核对：宿主命令表里的权限相关命令 id
    const permCmds = allCmds.filter((c) => /permission|autoaccept|mode/i.test(String((c as { id?: string })?.id ?? "")))
    kbdLog(`keymap 权限相关命令: ${permCmds.map((c) => (c as { id?: string })?.id).join(",") || "（无）"}`)
    kbdLog(`keymap goal 命令中 palette=true 的 ${withPalette.length} 条: ${withPalette.join(",")}`)
  } catch (e) { kbdLog(`命令清单诊断异常 ${String(e)}`) }

  // 返回清理函数（V2 官方约定：插件被 reload 时宿主调用；不返回 ⇒ 旧实例的 interval/watch 泄漏）
  return () => { for (const d of disposers) { try { d() } catch {} } }
}

// V1 插件模块（TuiPluginModule { id, tui }）→ V2 Plugin.define({ id, setup(context) })
export default Plugin.define({
  id: "opencode-goal-tui",
  setup: (context: any) => tui(context),
})
