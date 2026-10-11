/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { mkdirSync, readFileSync, writeFileSync, renameSync, watch } from "node:fs"
import { join } from "node:path"

const home = process.env.HOME ?? "/root"
const stateDir = join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "goal")
const goalsFile = join(stateDir, "goals.json")
const configFile = join(stateDir, "config.json")
const opencodeConfigFile = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode", "opencode.jsonc")

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
function configStuckTimeoutMs(): number {
  try {
    const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.stuckTimeoutMs)
    if (Number.isInteger(n) && n >= 60000) return n
  } catch {}
  return 600000
}
const stuckTimeoutMin = () => Math.round(configStuckTimeoutMs() / 60000)
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
  // 配置驱动方案：只写 config.json，permission.mode 由插件 ensureAutoAccept 即时对齐（无需改 opencode.jsonc）
  try {
    writeConfig({ autoApprovePermissions: v })
  } catch {
    pluginApi?.ui.toast({ message: "写配置失败", variant: "error" })
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
  pluginApi?.client.session.delete({ sessionID: sid }, { signal }).then((res: unknown) => {
    const r = res as { error?: { message?: string } | string } | undefined
    if (r && r.error) {
      const msg = typeof r.error === "string" ? r.error : r.error?.message ?? "未知错误"
      pluginApi?.ui.toast({ message: `删除子代理会话失败 ${sid.slice(-12)}：${msg}`, variant: "error" })
      return
    }
    deleteGoalIfExists(sid)  // 子会话目标记录同步清理
    pluginApi?.ui.toast({ message: `已删除子代理会话 ${sid.slice(-12)}`, variant: "success" })
    pluginRefresh()
    pluginRefreshSubagents(sid)
  }).catch((e: unknown) => {
    pluginApi?.ui.toast({ message: `删除子代理会话失败 ${sid.slice(-12)}（${e instanceof Error ? e.message : "可能被占用"}）`, variant: "error" })
  })
}

type RouteCurrent = { name: string; params?: Record<string, unknown> }
let pluginApi: TuiPluginApi | undefined
let pluginRefresh: (sessionID?: string) => void = () => {}
let pluginRefreshSubagents: (deletedSid?: string) => void = () => {}
const statusText = (s: string) => ({ active: "推进中", paused: "已暂停", done: "已完成", limited: "达上限", cleared: "无目标", stuck: "卡住", iterating: "待迭代" }[s] ?? s)
const flowText = (f?: string) => ({ explore: "探索", plan: "规划", execute: "执行", audit: "审计" }[f ?? "explore"] ?? f ?? "探索")
const turnsText = (turns: number, max: number) => max > 0 ? `${turns}/${max}` : `${turns}/不限`
const iterText = (count: number) => `迭代 ${count + 1}/${configIterateMaxRounds() > 0 ? configIterateMaxRounds() : "不限"}`
const fmtSid = (sid: string) => sid

const tui: TuiPlugin = async (api) => {
  pluginApi = api
  const [goals, setGoals] = createSignal<Record<string, GoalEntry>>({})
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

  const refresh = (sessionID?: string) => {
    setGoals(loadGoals())
  }
  pluginRefresh = refresh

  // ===== 目标模式 auto-accept 自动开关（配置驱动 + 会话判断）=====
  // 读 config.json 的 autoApprovePermissions（总开关）&& 当前会话是否目标模式（goals.json 有 active goal）
  // → 决定注入 auto（permission.mode 开启）或还原（关闭）。
  // 维护 lastGoalMode 跟踪注入状态，避免重复 toggle；会话切换/配置变化时自动对齐。
  let lastGoalMode: boolean | undefined = undefined   // undefined=未注入，true=已注入开启，false=已还原关闭
  // 调试日志已移除（无残留调试代码）；保留调用点为空实现
  const aaDebug = (_msg: string) => {}
  const configAutoApprove = (): boolean => {
    try { return JSON.parse(readFileSync(configFile, "utf8"))?.autoApprovePermissions === true } catch { return false }
  }
  aaDebug("plugin loaded")
  const isGoalSession = (sid: string): boolean => {
    try {
      const g = loadGoals()
      const e = g[sid]
      return !!(e && e.state !== "cleared" && e.state !== "done")
    } catch { return false }
  }
  const ensureAutoAccept = () => {
    try {
      // 批准链条不变：仅在此前判断「当前会话是否目标模式 && 总开关开启」
      const sid = currentSid()
      const want = configAutoApprove() && !!sid && isGoalSession(sid)
      // 首次加载（lastGoalMode===undefined）：
      //   want=true  → dispatch 开启（注入 auto）
      //   want=false → 不动作（保持默认询问），仅记录
      if (lastGoalMode === undefined) {
        lastGoalMode = want
        if (want) {
          try {
            const r = (api.keymap as any).dispatchCommand("permission.mode")
            aaDebug(`init: goal session + config on → dispatch permission.mode result=${JSON.stringify(r)}`)
          } catch (err) {
            aaDebug(`init dispatch THREW: ${String(err)}`)
            lastGoalMode = undefined
          }
        } else {
          aaDebug(`init: not goal session or config off (skip dispatch)`)
        }
        return
      }
      if (lastGoalMode === want) return
      lastGoalMode = want
      // 状态变化 → toggle permission.mode（want=true=开启 auto，false=还原关闭）
      try {
        const r = (api.keymap as any).dispatchCommand("permission.mode")
        aaDebug(`goal session=${!!sid && isGoalSession(sid)} config=${configAutoApprove()} want=${want} → dispatch permission.mode result=${JSON.stringify(r)}`)
        api.ui.toast({
          message: want ? "自动批准已开启（当前目标会话，不弹窗）" : "自动批准已关闭（非目标会话/配置关闭，恢复询问）",
          variant: want ? "success" : "info",
          duration: 4000,
        })
      } catch (err) {
        aaDebug(`dispatch permission.mode THREW: ${String(err)}`)
        lastGoalMode = undefined  // 失败重置，下轮重试
      }
    } catch (e) {
      aaDebug(`ensureAutoAccept error: ${String(e)}`)
    }
  }

  const currentSid = () => {
    const cur = api.route.current as RouteCurrent | undefined
    return cur && cur.name === "session" ? String(cur.params?.sessionID ?? "") : ""
  }

  const notifySession = (sid: string, text: string) => {
    // 子代理会话不启用 question 工具（子代理不能询问用户）；主会话保持可用
    api.client.session.list({}).then((res: unknown) => {
      const all = (Array.isArray(res) ? res : ((res as { data?: unknown[] }).data ?? [])) as { id: string; parentID?: string }[]
      const isSub = all.some(s => s?.id === sid && !!s.parentID)
      api.client.session.prompt({ sessionID: sid, agent: "z-goal", ...(isSub ? {} : { tools: { question: true } }), parts: [{ type: "text", text, synthetic: true }] }).catch(() => {})
    }).catch(() => {
      api.client.session.prompt({ sessionID: sid, agent: "z-goal", tools: { question: true }, parts: [{ type: "text", text, synthetic: true }] }).catch(() => {})
    })
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
    api.ui.toast({ message: `目标已删除（会话 ${fmtSid(sid)}）`, variant: "success" })
    // M5：对话框仍打开时重新渲染选项列表（静态 options 不会自动刷新，已删条目会残留）
    if (manageOpen()) goalManageDialog()
  }
  const doPause = (sid: string) => {
    const goals = loadGoals()
    if (!goals[sid]) return
    goals[sid] = { ...goals[sid], state: "paused", updatedAt: Date.now() }
    saveGoals(goals)
    setGoals(goals)
    api.ui.toast({ message: `目标已暂停（会话 ${fmtSid(sid)}，可在列表恢复）`, variant: "info" })
  }
  const doResume = (sid: string) => {
    const goals = loadGoals()
    if (!goals[sid]) return
    if (goals[sid].state === "limited") {
      api.ui.toast({ message: `已达轮数上限（${goals[sid].maxTurns} 轮），目标停止推进无法恢复；请用 /goal 重新设置目标`, variant: "warning" })
      return
    }
    if (goals[sid].state !== "paused" && goals[sid].state !== "iterating") {
      api.ui.toast({ message: `状态为 ${statusText(goals[sid].state)}，无需恢复`, variant: "info" })
      return
    }
    goals[sid] = { ...goals[sid], state: "active", updatedAt: Date.now() }
    saveGoals(goals)
    setGoals(goals)
    api.ui.toast({ message: `目标已恢复，继续推进（会话 ${fmtSid(sid)}）`, variant: "success" })
  }
  const deleteConfirm = (sid: string) => {
    const goals = loadGoals()
    const e = goals[sid]
    if (!e) return
    api.ui.dialog.replace(() => (
      <api.ui.DialogConfirm
        title={`删除目标（会话 ${fmtSid(sid)}）`}
        message={`确定删除该目标？删除后不可恢复。\n\n${e.goal.length > 80 ? e.goal.slice(0, 80) + "…" : e.goal}`}
        onConfirm={() => { doClear(sid); api.ui.dialog.clear() }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
  }
  const goalActionMenu = (sid: string) => {
    const goals = loadGoals()
    const e = goals[sid]
    if (!e) return
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title={`管理目标（会话 ${fmtSid(sid)}）`}
        options={[
          {
            title: "查看目标",
            value: "status",
            onSelect: () => {
              api.ui.toast({ title: `目标状态（${fmtSid(sid)}）`, message: `状态：${statusText(e.state)} | 流程：${flowText(e.flow)} | 轮数：${turnsText(e.turns, e.maxTurns)}${(e.iteration || configIterateMode()) ? ` | ${iterText(e.iteration?.count ?? 0)}` : ""}\n目标：${e.goal}${(e.history ?? []).map(h => `\n迭代历史 第${h.count + 1}轮：${h.goal.length > 40 ? h.goal.slice(0, 40) + "…" : h.goal}`).join("")}`, variant: "info" })
              api.ui.dialog.clear()
            },
          },
          {
            title: "更新目标",
            value: "edit",
            onSelect: () => {
              api.ui.dialog.replace(() => (
                <api.ui.DialogPrompt
                  title={`更新目标（会话 ${fmtSid(sid)}）`}
                  value={e.goal}
                  onConfirm={(v) => {
                    const g = v.trim()
                    if (!g) { api.ui.toast({ message: "目标不能为空", variant: "error" }); return }
                    const goals = loadGoals()
                    if (!goals[sid]) { api.ui.toast({ message: "目标已不存在", variant: "error" }); return }
                    goals[sid] = { ...goals[sid], goal: g, updatedAt: Date.now() }
                    saveGoals(goals)
                    setGoals(goals)
                    if (goals[sid].state === "active") {
                      notifySession(sid, `【目标更新】目标已修改为：${g}。请以新目标为准，重新评估当前进度与计划，必要时调整方向，继续推进直到完成。`)
                      api.ui.toast({ message: "目标已更新，已立即通知 AI", variant: "success" })
                    } else {
                      api.ui.toast({ message: "目标已更新（暂停中，恢复后生效）", variant: "info" })
                    }
                    api.ui.dialog.clear()
                  }}
                  onCancel={() => api.ui.dialog.clear()}
                />
              ))
            },
          },
          {
            title: "恢复目标",
            value: "resume",
            disabled: e.state !== "paused" && e.state !== "iterating",
            onSelect: () => { doResume(sid); api.ui.dialog.clear() },
          },
          {
            title: "暂停目标",
            value: "pause",
            disabled: e.state !== "active",
            onSelect: () => { doPause(sid); api.ui.dialog.clear() },
          },
          {
            title: "跳转目标",
            value: "goto",
            onSelect: () => {
              api.ui.dialog.clear()
              try {
                if (api.state.session.get(sid) === undefined) {
                  api.ui.toast({ message: `会话 ${fmtSid(sid)} 不存在或已清理，无法跳转`, variant: "warning" })
                  return
                }
                api.route.navigate("session", { sessionID: sid })
              } catch {
                api.ui.toast({ message: "跳转会话失败，目标会话可能已不存在", variant: "error" })
              }
            },
          },
          { title: "删除目标", value: "delete", onSelect: () => deleteConfirm(sid) },
        ]}
      />
    ))
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
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="目标管理"
        placeholder="Enter 管理选中目标，Ctrl+d 删除（再按一次确认），Esc 关闭"
        options={genOptions()}
        current={manageCurrent() || undefined}
        onMove={(o) => { if (o) { setManageCurrent(String(o.value)); setConfirmGoal("") } }}
        onSelect={(o) => {
          const v = String(o?.value ?? "")
          goalActionMenu(v.startsWith("goal:") ? v.slice(5) : v)
        }}
      />
    ))
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
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title={forkHint() || "Fork 目标到当前会话（主会话在前，时间最新排序）"}
        placeholder="Enter 选中/取消，Ctrl+1 完整复制（含阶段/迭代），Ctrl+2 仅目标文本，Ctrl+o 排序，Esc 关闭"
        options={genOptions()}
        onMove={() => { if (forkHint()) setForkHint("") }}
        onSelect={(o) => {
          const v = String((o as { value?: unknown }).value ?? "")
          if (!v.startsWith("fork:")) return
          const sid = v.slice(5)
          setForkCurrent(forkCurrent() === sid ? "" : sid)
          if (forkHint()) setForkHint("")
        }}
      />
    ))
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
    api.ui.toast({
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
        const sres = await api.client.session.status({})
        const m = ((sres as { data?: unknown })?.data ?? sres) as Record<string, { type?: unknown }> | undefined
        if (m && typeof m === "object") {
          for (const [k, v] of Object.entries(m)) {
            const t = (v as { type?: unknown })?.type
            if (typeof t === "string") {
              live[k] = t
              if (t === "busy") statusMap[k] = "进行中"
              else if (t === "retry") statusMap[k] = "重试"
            }
          }
        }
      } catch {}
      // idle/无状态 的子代理：查最后一条 assistant 消息判断 已完成/已失败/未知（无法确认完成一律未知，不误删）
      await Promise.all(subs.filter(s => !statusMap[s.id]).map(async (s) => {
        try {
          const mres = await api.client.session.messages({ sessionID: s.id, limit: 50 })
          const list = Array.isArray(mres) ? mres : ((mres as { data?: unknown[] }).data ?? [])
          const lastAsst = [...(list as { role?: string; error?: unknown; time?: { completed?: number }; info?: { time?: { completed?: number } } }[])].reverse().find(m => m?.role === "assistant")
          if (!lastAsst) {
            statusMap[s.id] = "未知"
          } else if (lastAsst.error) {
            statusMap[s.id] = "已失败"
          } else if (lastAsst.time?.completed !== undefined || lastAsst.info?.time?.completed !== undefined) {
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
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title={`子代理会话（${sorted.length} 个 · ${desc ? "最新在前" : "最旧在前"}）`}
        placeholder="Enter 跳转会话，Ctrl+d 删除（再按一次确认），Ctrl+o 切换排序，输入搜索，Esc 关闭"
        options={genOptions()}
        current={manageCurrent() || undefined}
        onMove={(o) => { if (o) { setManageCurrent(String(o.value)); setConfirmSub("") } }}
        onSelect={(o) => {
          const v = String((o as { value?: unknown }).value ?? "")
          if (!v.startsWith("sub:")) return
          const sid = v.slice(4)
          api.ui.dialog.clear()
          try { api.route.navigate("session", { sessionID: sid }) } catch { api.ui.toast({ message: "跳转会话失败", variant: "error" }) }
        }}
      />
    ))
  }

  const subagentListDialog = () => {
    setManageOpen(true)
    setConfirmSub("")
    loadSubagentSessions().then(({ subs, statusMap }) => {
      setSubagentCache(subs)
      setSubStatusMap(statusMap)
      renderSubagentDialog()
    }).catch(() => {
      api.ui.toast({ message: "获取子代理会话失败", variant: "error" })
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
        api.ui.toast({ message: "2 分钟内已有子代理清理在执行，本次跳过", variant: "info" })
        return
      }
      writeFileSync(lockFile, String(now))
    } catch {}
    // 手动清理：不受天数限制，清理所有已完成/已失败子代理（进行中/重试/未知 一律跳过）
    loadSubagentSessions().then(({ subs, statusMap }) => {
      const targets = subs.filter(s => statusMap[s.id] === "已完成" || statusMap[s.id] === "已失败")
      const skipped = subs.filter(s => statusMap[s.id] !== "已完成" && statusMap[s.id] !== "已失败").length
      if (targets.length === 0) {
        api.ui.toast({ message: `没有已完成/已失败的子代理会话${skipped > 0 ? `（${skipped} 个进行中/重试/未知已跳过）` : ""}`, variant: "info" })
        return
      }
      const ids = targets.map(s => s.id)
      api.ui.toast({ message: `开始清理 ${targets.length} 个子代理会话${skipped > 0 ? `（跳过 ${skipped} 个进行中/重试/未知）` : ""}…`, variant: "info" })
      let done = 0
      let failed = 0
      ids.forEach(sid => {
        pluginApi?.client.session.delete({ sessionID: sid }).then(() => {
          deleteGoalIfExists(sid)  // 子会话目标记录同步清理
          done++
          pluginRefreshSubagents(sid)
          if (done + failed === ids.length) {
            api.ui.toast({ message: `已清理 ${done} 个子代理会话${failed ? `，${failed} 个失败` : ""}`, variant: "success" })
            pluginRefresh()
          }
        }).catch(() => {
          failed++
          if (done + failed === ids.length) {
            api.ui.toast({ message: `已清理 ${done} 个子代理会话${failed ? `，${failed} 个失败` : ""}`, variant: "success" })
            pluginRefresh()
          }
        })
      })
    }).catch(() => {
      api.ui.toast({ message: "获取会话列表失败", variant: "error" })
    })
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: "goal.panel.toggle",
        title: "Goal：收起/展开目标面板",
        category: "Goal",
        namespace: "palette",
        run() {
          setCollapsed(!collapsed())
        },
      },
    ],
    bindings: [{ key: "ctrl+shift+g", cmd: "goal.panel.toggle", desc: "收起/展开目标面板" }],
  })

  api.keymap.registerLayer({
    commands: [
      {
        name: "goal.manage.sort",
        title: "子代理/Fork 列表：切换时间排序",
        category: "Goal",
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
        name: "goal.fork.execute.full",
        title: "Fork 目标：完整复制到当前会话（含阶段/迭代/方案文档）",
        category: "Goal",
        run() {
          if (!forkOpen()) return
          doForkGoal("full")
        },
      },
      {
        name: "goal.fork.execute.text",
        title: "Fork 目标：仅目标文本复制到当前会话",
        category: "Goal",
        run() {
          if (!forkOpen()) return
          doForkGoal("text")
        },
      },
      {
        name: "goal.fork.execute",
        title: "Fork 目标：复制选中目标到当前会话（默认完整复制）",
        category: "Goal",
        run() {
          if (!forkOpen()) return
          doForkGoal("full")
        },
      },
      {
        name: "goal.manage.delete",
        title: "目标列表：删除选中项",
        category: "Goal",
        run() {
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
    bindings: [
      { key: "ctrl+o", cmd: "goal.manage.sort", desc: "子代理/Fork 列表切换时间排序（需先打开 /goal-subs 或 /goal-fork）" },
      { key: "ctrl+1", cmd: "goal.fork.execute.full", desc: "Fork 完整复制（含阶段/迭代，需先打开 /goal-fork）" },
      { key: "ctrl+2", cmd: "goal.fork.execute.text", desc: "Fork 仅目标文本（需先打开 /goal-fork）" },
      { key: "ctrl+y", cmd: "goal.fork.execute", desc: "Fork 完整复制（默认，需先打开 /goal-fork）" },
      { key: "ctrl+d", cmd: "goal.manage.delete", desc: "目标列表删除选中项（需先打开 /goal-all 或 /goal-subs）" },
    ],
  })

  api.event.on("todo.updated", (e) => {
    const sid = (e.properties as { sessionID?: string } | undefined)?.sessionID
    refresh(sid)
    ensureAutoAccept()
  })
  api.event.on("session.idle", (e) => {
    const sid = (e.properties as { sessionID?: string } | undefined)?.sessionID
    refresh(sid)
    ensureAutoAccept()
  })
  api.event.on("message.updated", (e) => {
    const sid = (e.properties as { info?: { sessionID?: string } } | undefined)?.info?.sessionID
    refresh(sid)
    ensureAutoAccept()
  })
  // 启动时对当前会话对齐（同步执行；路由未就绪时由事件触发补上）
  aaDebug("calling ensureAutoAccept on load")
  ensureAutoAccept()

  setInterval(() => { refresh(currentSid()); ensureAutoAccept() }, 10000)
  try { watch(goalsFile, () => refresh(currentSid())) } catch {}
  try { watch(configFile, () => ensureAutoAccept()) } catch {}

  api.slots.register({
    order: 150,
    slots: {
      "sidebar_content": (ctx, props: { session_id: string }) => {
        const theme = ctx.theme as Record<string, string>
        const fg = (c?: string) => c ? { fg: c } : {}
        const stateColor = (s: string) =>
          s === "active" ? theme.primary : s === "done" ? theme.success : s === "paused" ? theme.text : s === "limited" || s === "stuck" ? theme.error : s === "iterating" ? theme.warning : theme.textMuted
        const g = goals()
        sessionCollapsed()
        goalTextCollapsed()
        stageTodosCollapsed()
        const entries = Object.entries(g).filter(([, e]) => e.state !== "cleared" && e.state !== "done")
        const own = g[props.session_id]
        const others = entries.filter(([k]) => k !== props.session_id)
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
                          <Show when={(!item.stages || item.stages.length === 0) && item.current && sid === props.session_id && item.state === "active"}>
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
                {sessionBlock(props.session_id, own, "本会话")}
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
      },
    },
  })

  api.command.register(() => [
    {
      title: "Goal：目标列表管理",
      value: "goal.manage",
      description: "弹出列表选择任意会话目标（含子代理遗留）：Enter 管理（查看/更新/恢复/暂停/跳转/删除目标），Ctrl + d 删除",
      category: "Goal",
      slash: { name: "goal-all", aliases: ["goal-list", "goals"] },
      onSelect: () => goalManageDialog(),
    },
    {
      title: "Goal：子代理会话列表",
      value: "goal.subagents",
      description: "全部子代理会话：Enter 跳转会话，Ctrl+d 删除，Ctrl+o 切换时间排序，输入搜索",
      category: "Goal",
      slash: { name: "goal-subs", aliases: ["goal-subagents", "goal-children"] },
      onSelect: () => subagentListDialog(),
    },
    {
      title: "Goal：Fork 目标",
      value: "goal.fork",
      description: "从所有目标中复制一个到当前会话（回车选中/取消，Ctrl+y 复制，主会话在前+时间最新排序，Ctrl+o 切换）",
      category: "Goal",
      slash: { name: "goal-fork", aliases: ["goal-copy"] },
      onSelect: () => forkGoalDialog(),
    },
    {
      title: "Goal：更新目标",
      value: "goal.update",
      description: "实时修改当前会话目标（保存后立即通知 AI）",
      category: "Goal",
      slash: { name: "goal-update" },
      onSelect: (dialog) => {
        const sid = currentSid()
        const e = sid ? loadGoals()[sid] : undefined
        if (!sid || !e || e.state === "cleared" || e.state === "done") {
          api.ui.toast({ message: "当前会话没有活跃目标，请先用 /goal 设置", variant: "warning" })
          return
        }
        dialog?.replace(
          () => (
            <api.ui.DialogPrompt
              title={`更新目标（会话 ${fmtSid(sid)}）`}
              value={e.goal}
              onConfirm={(v) => {
                const g = v.trim()
                if (!g) {
                  api.ui.toast({ message: "目标不能为空", variant: "error" })
                  return
                }
                const goals = loadGoals()
                if (!goals[sid]) {
                  api.ui.toast({ message: "目标已不存在", variant: "error" })
                  return
                }
                goals[sid] = { ...goals[sid], goal: g, updatedAt: Date.now() }
                saveGoals(goals)
                setGoals(goals)
                if (goals[sid].state === "active") {
                  notifySession(sid, `【目标更新】目标已修改为：${g}。请以新目标为准，重新评估当前进度与计划，必要时调整方向，继续推进直到完成。`)
                  api.ui.toast({ message: "目标已更新，已立即通知 AI", variant: "success" })
                } else {
                  api.ui.toast({ message: "目标已更新（暂停中，恢复后生效）", variant: "info" })
                }
                dialog?.clear()
              }}
              onCancel={() => dialog?.clear()}
            />
          )
        )
      },
    },
    {
      title: "Goal：设置配置",
      value: "goal.config",
      description: "多配置：轮数上限 / 摘要字数 / 清理天数 / 卡住超时 / 自动批准权限 / 子代理保留上限（立即生效）",
      category: "Goal",
      slash: { name: "goal-config", aliases: ["goal-cfg"] },
      onSelect: (dialog) => {
        const promptConfig = (key: "maxTurns" | "summaryLen" | "cleanupDays" | "stuckTimeoutMs" | "maxRetainedSubagents" | "iterateMaxRounds" | "pushIntervalMs", title: string, placeholder: string, current: number, validate: (n: number) => boolean, errMsg: string) => {
          dialog?.replace(
            () => (
              <api.ui.DialogPrompt
                title={title}
                placeholder={placeholder}
                value={String(current)}
                onConfirm={(v) => {
                  let n: number
                  if (key === "cleanupDays") {
                    n = parseFloat(v)
                  } else if (key === "stuckTimeoutMs") {
                    n = Math.round(parseFloat(v) * 60000)
                  } else if (key === "pushIntervalMs") {
                    n = Math.round(parseFloat(v) * 60000)
                  } else {
                    n = parseInt(v, 10)
                  }
                  if (!Number.isFinite(n) || !validate(n)) {
                    api.ui.toast({ message: errMsg, variant: "error" })
                    return
                  }
                  writeConfig({ [key]: n })
                  const display = key === "stuckTimeoutMs" || key === "pushIntervalMs" ? `${n / 60000} 分钟` : String(n)
                  api.ui.toast({ message: `${title}已设置为 ${display}，立即生效`, variant: "success" })
                  dialog?.clear()
                }}
                onCancel={() => dialog?.clear()}
              />
            )
          )
        }
        dialog?.replace(
          () => (
            <api.ui.DialogSelect
              title="目标推进配置"
              placeholder="选择要修改的配置项"
              options={[
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
                  title: `子代理卡住超时：当前 ${stuckTimeoutMin()} 分钟`,
                  value: "stuckTimeoutMs",
                  description: "子代理会话超过该时长无活动则自动中止（防卡死）",
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
              ]}
              onSelect={(o) => {
                const key = String((o as { value?: unknown }).value ?? "")
                if (key === "maxTurns") promptConfig("maxTurns", "设置目标轮数上限", "输入数字（0=无限），如 100", configMaxTurns(), n => n >= 0 && Number.isInteger(n), "请输入不小于 0 的整数（0=无限）")
                else if (key === "summaryLen") promptConfig("summaryLen", "设置目标摘要字数", "输入字数，如 30", configSummaryLen(), n => n >= 5 && Number.isInteger(n), "请输入不小于 5 的整数")
                else if (key === "cleanupDays") promptConfig("cleanupDays", "设置子代理清理天数", "输入天数，如 3", cleanupDays(), n => n > 0, "请输入有效正数")
                else if (key === "stuckTimeoutMs") promptConfig("stuckTimeoutMs", "设置子代理卡住超时", "输入分钟数，如 10", stuckTimeoutMin(), n => n >= 1, "请输入有效正数（分钟）")
                else if (key === "pushIntervalMs") promptConfig("pushIntervalMs", "设置推送间隔", "输入分钟数，如 5", pushIntervalMin(), n => n >= 1, "请输入有效正数（分钟）")
                else if (key === "autoApprovePermissions") {
                  const now = autoApprove()
                  dialog?.replace(
                    () => (
                      <api.ui.DialogSelect
                        title="自动批准权限"
                        placeholder="选择操作"
                        options={
                          now
                            ? [{ title: "关闭自动批准（当前：开启）", value: "off", description: "恢复权限询问（TUI 弹窗确认）" }]
                            : [{ title: "开启自动批准（当前：关闭）", value: "on", description: "所有权限请求自动允许，不弹确认" }]
                        }
                        onSelect={(o2) => {
                          const v = String((o2 as { value?: unknown }).value ?? "") === "on"
                          setAutoApproveConfig(v)
                          dialog?.clear()
                        }}
                      />
                    )
                  )
                }
                else if (key === "maxRetainedSubagents") promptConfig("maxRetainedSubagents", "设置子代理保留上限", "输入数量（0=不限制），如 50", maxRetained(), n => n >= 0 && Number.isInteger(n), "请输入不小于 0 的整数")
                else if (key === "iterateMaxRounds") promptConfig("iterateMaxRounds", "设置迭代轮数上限", "输入数字（0=无限），如 5", configIterateMaxRounds(), n => n >= 0 && Number.isInteger(n), "请输入不小于 0 的整数（0=无限）")
                else if (key === "iterAskMode") {
                  const now = configIterAskMode()
                  dialog?.replace(
                    () => (
                      <api.ui.DialogSelect
                        title="迭代询问模式"
                        placeholder="选择模式"
                        options={
                          now === "every"
                            ? [{ title: "仅首轮询问（当前：每轮询问）", value: "first", description: "会话内首轮迭代询问一次方向/限制，全局生效，后续不再询问" }]
                            : [
                              { title: "每轮迭代都询问（当前：仅首轮询问）", value: "every", description: "每个迭代目标第 1 轮都询问用户方向/限制" },
                            ]
                        }
                        onSelect={(o2) => {
                          const v = String((o2 as { value?: unknown }).value ?? "first") === "every" ? "every" : "first"
                          writeConfig({ iterAskMode: v })
                          dialog?.clear()
                        }}
                      />
                    ),
                  )
                }
                else if (key === "planDir") {
                  const now = configPlanDir()
                  dialog?.replace(
                    () => (
                      <api.ui.DialogSelect
                        title="方案文档位置"
                        placeholder="选择方案文档生成位置"
                        options={[
                          { title: `/tmp/plan（默认）`, value: "default", description: "临时目录，重启可能丢失" },
                          { title: `工作区 .plan`, value: "workspace", description: "项目根目录下 .plan 文件夹，随项目持久化" },
                          { title: `自定义路径…`, value: "custom", description: `当前：${now !== "default" && now !== "workspace" ? now : "未设置"}` },
                        ]}
                        onSelect={(o2) => {
                          const v = String((o2 as { value?: unknown }).value ?? "")
                          if (v === "custom") {
                            dialog?.replace(
                              () => (
                                <api.ui.DialogPrompt
                                  title="自定义方案文档路径"
                                  placeholder="输入绝对路径，如 /root/myproject/.plan"
                                  value={now !== "default" && now !== "workspace" ? now : ""}
                                  onConfirm={(pv) => {
                                    const p = pv.trim()
                                    if (!p) { api.ui.toast({ message: "路径不能为空", variant: "error" }); return }
                                    writeConfig({ planDir: p })
                                    api.ui.toast({ message: `方案文档位置已设置为 ${p}`, variant: "success" })
                                    dialog?.clear()
                                  }}
                                  onCancel={() => dialog?.clear()}
                                />
                              )
                            )
                            return
                          }
                          writeConfig({ planDir: v })
                          api.ui.toast({ message: `方案文档位置已设置为 ${v === "workspace" ? "工作区 .plan" : "/tmp/plan（默认）"}，立即生效`, variant: "success" })
                          dialog?.clear()
                        }}
                      />
                    )
                  )
                }
                else if (key === "auditDelete") {
                  const now = configAuditDelete()
                  dialog?.replace(
                    () => (
                      <api.ui.DialogSelect
                        title="目标完成默认删除"
                        placeholder="选择操作"
                        options={
                          now
                            ? [{ title: "关闭（完成后保留目标）", value: "off", description: "当前：完成后默认删除" }]
                            : [{ title: "开启（完成后默认删除）", value: "on", description: "当前：完成后保留目标" }]
                        }
                        onSelect={(o2) => {
                          const v = String((o2 as { value?: unknown }).value ?? "") === "on"
                          writeConfig({ auditDelete: v })
                          api.ui.toast({ message: `目标完成默认删除已${v ? "开启" : "关闭"}，立即生效`, variant: "success" })
                          dialog?.clear()
                        }}
                      />
                    )
                  )
                }
                else if (key === "iterateMode") {
                  const now = configIterateMode()
                  dialog?.replace(
                    () => (
                      <api.ui.DialogSelect
                        title="迭代模式"
                        placeholder="选择操作"
                        options={
                          now
                            ? [{ title: "关闭迭代模式", value: "off", description: "当前：开启（audit 后进入迭代循环）" }]
                            : [{ title: "开启迭代模式", value: "on", description: "当前：关闭（audit 后直接收尾）" }]
                        }
                        onSelect={(o2) => {
                          const v = String((o2 as { value?: unknown }).value ?? "") === "on"
                          writeConfig({ iterateMode: v })
                          api.ui.toast({ message: `迭代模式已${v ? "开启" : "关闭"}，立即生效`, variant: "success" })
                          dialog?.clear()
                        }}
                      />
                    )
                  )
                }
                else if (key === "forkPaused") {
                  const now = configForkPaused()
                  dialog?.replace(
                    () => (
                      <api.ui.DialogSelect
                        title="Fork 目标默认暂停"
                        placeholder="选择操作"
                        options={
                          now
                            ? [{ title: "关闭（Fork 后立即推进）", value: "off", description: "当前：Fork 后默认暂停" }]
                            : [{ title: "开启（Fork 后默认暂停）", value: "on", description: "当前：Fork 后立即推进" }]
                        }
                        onSelect={(o2) => {
                          const v = String((o2 as { value?: unknown }).value ?? "") === "on"
                          writeConfig({ forkPaused: v })
                          api.ui.toast({ message: `Fork 目标默认暂停已${v ? "开启" : "关闭"}，立即生效`, variant: "success" })
                          dialog?.clear()
                        }}
                      />
                    )
                  )
                }
              }}
            />
          )
        )
      },
    },
    {
      title: "Goal：停止清除目标",
      value: "goal.stop",
      description: "彻底停止当前会话目标推进并清除",
      category: "Goal",
      slash: { name: "goal-stop" },
      onSelect: () => {
        const sid = currentSid()
        const e = sid ? loadGoals()[sid] : undefined
        if (!sid || !e || e.state === "cleared" || e.state === "done") {
          api.ui.toast({ message: "当前会话没有活跃目标", variant: "warning" })
          return
        }
        const goals = loadGoals()
        delete goals[sid]
        saveGoals(goals)
        setGoals(goals)
        api.ui.toast({ message: `目标已停止并清除（会话 ${fmtSid(sid)}）`, variant: "success" })
      },
    },
    {
      title: "Goal：暂停目标",
      value: "goal.pause",
      description: "暂停当前会话目标（保留目标，可恢复）",
      category: "Goal",
      slash: { name: "goal-pause" },
      onSelect: () => {
        const sid = currentSid()
        const e = sid ? loadGoals()[sid] : undefined
        if (!sid || !e || e.state === "cleared" || e.state === "done") {
          api.ui.toast({ message: "当前会话没有活跃目标", variant: "warning" })
          return
        }
        const goals = loadGoals()
        goals[sid] = { ...goals[sid], state: "paused", updatedAt: Date.now() }
        saveGoals(goals)
        setGoals(goals)
        api.ui.toast({ message: `目标已暂停（会话 ${fmtSid(sid)}，/goal-resume 恢复）`, variant: "info" })
      },
    },
    {
      title: "Goal：恢复目标",
      value: "goal.resume",
      description: "恢复当前会话已暂停的目标",
      category: "Goal",
      slash: { name: "goal-resume" },
      onSelect: () => {
        const sid = currentSid()
        if (!sid) {
          api.ui.toast({ message: "请先进入一个会话", variant: "warning" })
          return
        }
        const goals = loadGoals()
        if (!goals[sid]) {
          api.ui.toast({ message: "当前会话没有目标", variant: "warning" })
          return
        }
        if (goals[sid].state === "limited") {
          api.ui.toast({ message: `已达轮数上限（${goals[sid].maxTurns} 轮），目标停止推进无法恢复；请用 /goal 重新设置目标`, variant: "warning" })
          return
        }
        if (goals[sid].state !== "paused" && goals[sid].state !== "iterating") {
          api.ui.toast({ message: `当前会话目标状态为 ${statusText(goals[sid].state)}，无需恢复`, variant: "info" })
          return
        }
        goals[sid] = { ...goals[sid], state: "active", updatedAt: Date.now() }
        saveGoals(goals)
        setGoals(goals)
        api.ui.toast({ message: `目标已恢复，继续推进（会话 ${fmtSid(sid)}）`, variant: "success" })
      },
    },
    {
      title: "Goal：查看目标",
      value: "goal.status",
      description: "查看当前会话目标状态",
      category: "Goal",
      slash: { name: "goal-status" },
      onSelect: () => {
        const sid = currentSid()
        const e = sid ? loadGoals()[sid] : undefined
        if (!sid || !e || e.state === "cleared" || e.state === "done") {
          api.ui.toast({ message: "当前会话没有活跃目标", variant: "warning" })
          return
        }
        api.ui.toast({
          title: `目标状态（${fmtSid(sid)}）`,
          message: `状态：${statusText(e.state)} | 流程：${flowText(e.flow)} | 轮数：${turnsText(e.turns, e.maxTurns)}${(e.iteration || configIterateMode()) ? ` | ${iterText(e.iteration?.count ?? 0)}` : ""}\n目标：${e.goal.length > summaryLen() ? e.goal.slice(0, summaryLen()) + "…" : e.goal}${(e.history ?? []).map(h => `\n迭代历史 第${h.count + 1}轮：${h.goal.length > 40 ? h.goal.slice(0, 40) + "…" : h.goal}`).join("")}`,
          variant: "info",
        })
      },
    },
    {
      title: "Goal：清理子代理",
      value: "goal.cleanup",
      description: "清理所有已完成/已失败子代理会话（不受清理天数限制），子会话目标一并清理（进行中/重试/未知跳过，主会话不删，二次确认）",
      category: "Goal",
      slash: { name: "goal-cleanup", aliases: ["goal-clean"] },
      onSelect: () => {
        loadSubagentSessions().then(({ subs, statusMap }) => {
          const targets = subs.filter(s => statusMap[s.id] === "已完成" || statusMap[s.id] === "已失败")
          if (targets.length === 0) {
            api.ui.toast({ message: `没有已完成/已失败的子代理会话${subs.length - targets.length > 0 ? `（${subs.length - targets.length} 个其他状态跳过）` : ""}`, variant: "info" })
            return
          }
          api.ui.dialog.replace(() => (
            <api.ui.DialogConfirm
              title="清理子代理会话"
              message={`确定清理 ${targets.length} 个已完成/已失败子代理会话？子会话目标记录一并清理（进行中/重试/未知跳过，主会话不删）。`}
              onConfirm={() => {
                api.ui.dialog.clear()
                cleanupSubagentSessions()
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ))
        }).catch(() => {
          api.ui.toast({ message: "获取会话列表失败", variant: "error" })
        })
      },
    },
    {
      title: "Goal：一键清除所有目标",
      value: "goal.clear-all",
      description: "清除全部目标记录（推进中/已暂停/已完成/迭代中一律清除，不可恢复，需二次确认）",
      category: "Goal",
      slash: { name: "goal-clearall" },
      onSelect: () => {
        const count = Object.keys(loadGoals()).length
        if (count === 0) {
          api.ui.toast({ message: "当前没有任何目标记录", variant: "info" })
          return
        }
        api.ui.dialog.replace(() => (
          <api.ui.DialogConfirm
            title="一键清除所有目标"
            message={`确定清除全部 ${count} 个目标记录（含推进中/已暂停/已完成/迭代中）？清除后不可恢复，所有进程的目标推进将停止。`}
            onConfirm={() => {
              saveGoals({})
              api.ui.toast({ message: `已清除全部 ${count} 个目标记录`, variant: "success" })
              pluginRefresh()
              api.ui.dialog.clear()
            }}
            onCancel={() => api.ui.dialog.clear()}
          />
        ))
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-goal-tui",
  tui,
}

export default plugin
