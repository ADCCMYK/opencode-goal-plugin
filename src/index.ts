import type { Plugin, PluginModule, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"

const home = process.env.HOME ?? "/root"
const stateDir = join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "goal")
mkdirSync(stateDir, { recursive: true })
const goalsFile = join(stateDir, "goals.json")
const configFile = join(stateDir, "config.json")
const DEFAULT_PLAN_DIR = "/tmp/plan"
mkdirSync(DEFAULT_PLAN_DIR, { recursive: true })

function read(p: string, fb = "") {
  try { return readFileSync(p, "utf8").trim() || fb } catch { return fb }
}
function write(p: string, v: string) { writeFileSync(p, v) }

function loadConfig(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(configFile, "utf8"))
    if (raw && typeof raw === "object") return raw
  } catch {}
  return {}
}
// planDir：default=/tmp/plan、workspace=<工作区>/.plan、其他=自定义路径
function resolvePlanDir(): string {
  const v = loadConfig().planDir
  if (typeof v === "string" && v.trim()) {
    const t = v.trim()
    if (t === "workspace") return join(process.cwd(), ".plan")
    if (t === "default") return DEFAULT_PLAN_DIR
    return t
  }
  return DEFAULT_PLAN_DIR
}
function configIterateMode(): boolean {
  return loadConfig().iterateMode === true
}
function configAuditDelete(): boolean {
  return loadConfig().auditDelete !== false
}
function configIterateMaxRounds(): number {
  const n = parseInt(String(loadConfig().iterateMaxRounds))
  if (Number.isInteger(n) && n >= 0) return n  // 0 = 无限
  return 0  // 默认 0（无限）
}
// 迭代询问模式：first = 会话内首轮询问一次（默认）；every = 每轮迭代开始前都询问
function configIterAskMode(): "first" | "every" {
  const v = String(loadConfig().iterAskMode ?? "first")
  return v === "every" ? "every" : "first"
}

type GoalStage = { id: string; name: string; status: string; todos?: GoalTodo[] }
type GoalTodo = { content: string; status: string; priority?: string }
type GoalHistoryItem = { goal: string; count: number; direction?: string; time: number; stages?: GoalStage[]; planFile?: string; state?: string; flow?: string; turns?: number; maxTurns?: number }
type GoalEntry = { goal: string; state: string; turns: number; maxTurns: number; updatedAt: number; startedAt?: number; stages?: GoalStage[]; planFile?: string; flow?: "explore" | "plan" | "execute" | "audit"; iteration?: { count: number; direction?: string }; history?: GoalHistoryItem[] }
function loadGoals(): Record<string, GoalEntry> {
  try {
    const raw = JSON.parse(readFileSync(goalsFile, "utf8"))
    if (raw && typeof raw === "object") return raw
  } catch {}
  return {}
}
function saveGoals(g: Record<string, GoalEntry>) {
  // 唯一 tmp 文件名（pid+时间戳）：多进程/AI 并发写 goals.json 时，固定 tmp 名会互相覆盖/rename 失败抛错
  // （其他 AI 反馈"更新阶段、代办报错"的根因）；rename 是原子的，并发下最终文件一致
  // 兜底：写入/重命名失败时清理自己的 tmp（防残留累积）并抛错（execute 的 try/catch 会转友好提示）
  const tmp = `${goalsFile}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(g, null, 2))
    renameSync(tmp, goalsFile)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}

function normalizeTodos(arr: unknown[]): GoalTodo[] {
  return (arr as { content?: unknown; status?: unknown; priority?: unknown }[])
    .map(t => {
      const o = (t ?? {}) as { content?: unknown; status?: unknown; priority?: unknown }
      return {
        content: String(o.content ?? ""),
        status: String(o.status ?? "pending"),
        priority: o.priority !== undefined ? String(o.priority) : undefined,
      }
    })
    .filter(t => t.content)
}

function autoCompleteDoneTodos(stage: GoalStage): number {
  if (!stage.todos) return 0
  let n = 0
  // M6：AI 提交阶段完成（标 completed）时，该阶段所有未完成代办（含 pending 遗留）全部自动打勾，
  // 防止 AI 直接推进下一阶段后旧阶段代办空挂/被遗忘。触发点仅限"提交 completed"：
  // AI 有时先开新阶段（in_progress）之后再补提交完成，若在推进时提前收尾会把未完成阶段误标完成。
  for (const t of stage.todos) if (t.status !== "completed") { t.status = "completed"; n++ }
  return n
}

function loadRuntimeMaxTurns(): number | null {
  try {
    const cfg = JSON.parse(readFileSync(configFile, "utf8"))
    const n = parseInt(cfg?.maxTurns)
    if (Number.isInteger(n) && n >= 0) return n  // 0 = 无限
  } catch {}
  return null  // 配置里没有 → 用 defaultMaxTurns
}

const GoalPlugin: Plugin = async ({ client }, options: PluginOptions = {}) => {
  const cfgMax = parseInt(String(options.maxTurns ?? ""))
  const defaultMaxTurns = Number.isInteger(cfgMax) && cfgMax >= 0 ? cfgMax : 100
  const currentMaxTurns = () => {
    const rt = loadRuntimeMaxTurns()
    return rt === null ? defaultMaxTurns : rt  // 0 = 无限
  }

  const busySet = new Set<string>()
  const interrupted = new Set<string>()
  const lastPushedMsg = new Map<string, string>()   // sessionID -> 最后已推送的 assistant 消息 id（idle/消息完成双驱动去重）
  const lastPushTime = new Map<string, number>()    // sessionID -> 最后推送时间（消息完成驱动限频）
  const rePushIterCount = new Map<string, number>() // sessionID -> 已推送【迭代继续】的迭代轮 count（同轮只推一次）
  // 事件驱动插话（无轮询）：msg 驱动忙时挂起标记，flow 推送内容挂起队列——session.idle 事件到达（AI 回合自然完成）时发送
  const pendingMsgDrive = new Set<string>()
  const pendingPushQueue = new Map<string, string[]>()
  const pendingRetryPush = new Map<string, string[]>() // sid -> 被 opencode Session is busy 拒绝的推送，消息完成/idle 事件时重试送达
  // 会话内迭代模式已提醒询问用户（first 模式：首轮询问一次，当前会话全局生效，后续迭代不再提醒）——持久化，重启不丢失（防重启后误判首轮）
  const iterAskedFile = join(stateDir, "iter-asked.json")
  let iterAsked = new Set<string>()
  try { iterAsked = new Set(JSON.parse(readFileSync(iterAskedFile, "utf8"))) } catch {}
  const persistIterAsked = () => { try { writeFileSync(iterAskedFile, JSON.stringify([...iterAsked])) } catch {} }
  // every 模式：按迭代轮记录已提醒（sid -> iteration.count），同一迭代轮内不重复提醒（防止按推进轮次重复询问）
  const iterAskedForRound = new Map<string, number>()
  // 二次审计/迭代结束推送：AI 本轮完全结束（session.idle）后再推送一次，避免与 AI 生成交错导致重复生成
  const pendingSecondaryPush = new Map<string, string>()

  // 统一推送：子代理永远不启用 question 工具（子代理不能询问用户）；主代理（非子代理）保持 question 可用
  const pushPrompt = async (sid: string, text: string, opts?: { noReply?: boolean }) => {
    let tools: { question: true } | undefined
    const cached = isSubagentCache.get(sid)
    if (cached === true) {
      // 子代理：不带 question 工具
    } else if (cached === false) {
      tools = { question: true }
    } else {
      // 未缓存：主动确认（子代理不预缓存场景，如 fork 到子代理会话）
      try { await isSubagent(sid) } catch {}
      if (isSubagentCache.get(sid) !== true) tools = { question: true }
    }
    const body: Record<string, unknown> = { agent: "z-goal", parts: [{ type: "text", text, synthetic: true }] }
    if (tools) body.tools = tools
    if (opts?.noReply) body.noReply = true
    try {
      await client.session.prompt({ path: { id: sid }, body })
    } catch (e) {
      // opencode 对生成中（busy）会话的 prompt 直接拒绝（Session is busy，不排队不中断）
      // → 挂起重试（事件驱动：下个消息完成/idle 事件到达时送达），不丢弃不轮询
      const arr = pendingRetryPush.get(sid) ?? []
      arr.push(text)
      pendingRetryPush.set(sid, arr)
      console.error(`[goal] pushPrompt busy 拒绝，已挂起等待重试 (${sid})`)
    }
  }

  // 立即推送第一轮（goal set / 消息设目标 / iterate 通用）：设目标后第一时间让 AI 收到推进提示（不等 idle）
  const pushFirstRound = (sid: string) => {
    setTimeout(async () => {
      try {
        const cur = loadGoals()
        const entry = cur[sid]
        if (!entry) return
        entry.turns = 1
        saveGoals(cur)
        await pushPrompt(sid, `（第 1 轮，上限 ${entry.maxTurns > 0 ? `${entry.maxTurns} 轮` : "不限"}）\n\n【目标】${entry.goal}\n\n【当前流程】探索：先确认完成条件（读文件/搜索/交叉验证），探索充分后用 goal 工具 action=flow（flow=plan）进入规划\n\n${((configIterateMode() && isSubagentCache.get(sid) !== true) || entry.iteration) ? `【迭代】${entry.iteration && entry.iteration.count > 0 ? `第 ${entry.iteration.count + 1} 轮${entry.iteration.direction ? ` · 方向：${entry.iteration.direction}` : ""}（迭代模式已启用）` : `迭代模式已启用（上限 ${configIterateMaxRounds() > 0 ? `${configIterateMaxRounds()} 轮` : "不限"}）：审计后不删目标，插件将推送【迭代继续】指令`}\n\n` : `【迭代】迭代模式未启用：审计后正常收尾（无迭代循环）\n\n`}【目标阶段】（未规划）\n\n计划文件：${entry.planFile}\n\n本轮为第 1 轮：请按 z-goal 规范先探索确认完成条件，再创建计划文档（write，路径=上方「计划文件：」行）、规划目标阶段与当前阶段代办（update_stages，规划后 goal 工具 action=flow flow=execute），然后执行。`)
        // M7：第一轮推送成功即记录限频时间（防 AI 首条消息立即触发 msg 驱动重复推送）
        lastPushTime.set(sid, Date.now())
      } catch (e) {
        console.error("[goal] first round push failed:", e)
      }
    }, 300)
  }

  const buildPrompt = (entry: GoalEntry, turns: number, sid: string) => {
    const stages = entry.stages ?? []
    let stageBlock: string
    if (stages.length > 0) {
      stageBlock = "\n\n【目标阶段】\n" + stages.map(s => {
        const mark = s.status === "in_progress" ? "▶" : s.status === "completed" ? "✓" : "○"
        return `${mark} ${s.name ?? s.content ?? ""}${s.status === "in_progress" ? "（当前阶段）" : ""}`
      }).join("\n")
    } else {
      stageBlock = "\n\n【目标阶段】（未规划）"
    }
    const planLine = entry.planFile ? `\n\n计划文件：${entry.planFile}` : ""
    // 子代理永远按正常目标模式推进（不可迭代）：即使 config iterateMode 开启也不显示迭代状态
    const isSub = isSubagentCache.get(sid) === true
    const iterOn = (configIterateMode() && !isSub) || !!entry.iteration
    const maxRounds = configIterateMaxRounds()
    const iterCount = entry.iteration?.count ?? 0
    const isLast = maxRounds > 0 && iterCount + 1 >= maxRounds
    // 迭代方向/限制询问提醒：放在规划阶段（与正常提问时机一致）
    // first = 会话内首次迭代规划提醒一次；every = 每个迭代轮（count 变化）规划提醒一次，同一迭代轮内不重复
    const askEvery = configIterAskMode() === "every"
    const showAsk = iterOn && entry.flow === "plan" && (askEvery ? iterAskedForRound.get(sid) !== iterCount : !iterAsked.has(sid))
    if (showAsk) {
      if (askEvery) iterAskedForRound.set(sid, iterCount)
      else { iterAsked.add(sid); persistIterAsked() }
    }
    // 规划阶段提问提醒（flow=plan 时显示）：
    // 正常目标（仅主代理，子代理不允许询问用户）→ 通用提醒（目标/方向/理解不确定 → question 澄清+确认提问+记录到方案文档）
    // 迭代模式 → 受 iterAskMode 配置控制（first=首轮一次全局生效 / every=每轮都问），每次推送明确告知询问状态
    const askNote = entry.flow === "plan"
      ? (iterOn
        ? (showAsk
          ? `；【迭代询问】本轮规划需用 question 询问用户方向/限制（模式：${askEvery ? "每轮询问" : "仅首轮"}），澄清后做确认提问，确认内容记录到 direction`
          : (askEvery ? `；【迭代询问】每轮询问模式，本轮已提醒过，无需重复` : `；【迭代询问】仅首轮模式，已确认全局生效，本轮无需询问`))
        : (!isSub ? `；规划阶段提问：目标/方向/理解不确定 → 用 question 工具询问澄清（不限次数直到完全理解），完全理解后做一次确认提问（复述理解），确认后记录（写入方案文档）` : ""))
      : ""
    const flowLine = {
      explore: `\n\n【当前流程】探索：先确认完成条件（读文件/搜索/交叉验证），充分后 action=flow（flow=plan）进入规划`,
      plan: `\n\n【当前流程】规划：高质量规划——先 write 方案文档（非常详细），再 update_stages 规划阶段（带 todos，覆盖全部完成条件）；不足 action=flow（flow=explore）回探索；完成前核对（方案文档已写且详细、阶段覆盖完成条件、当前阶段代办明确）→ action=flow（flow=execute）${askNote}`,
      execute: `\n\n【当前流程】执行：推进当前阶段代办（stage / todos 流转）；阶段/代办过时主动修改（update_stages / todos）；每步验证真实有效（编译/测试）；全部阶段 completed → action=flow（flow=audit）`,
      audit: `\n\n【当前流程】审计：先做一次审计（带探索辅助理解：重读关键改动/运行验证/交叉核对；重读改动/编译/对照方案文档），通过后 action=audit`,
    }[entry.flow ?? "explore"]
    const iterLine = !iterOn
      ? `\n\n【迭代】迭代模式未启用：审计后正常收尾（无迭代循环）`
      : (entry.iteration && entry.iteration.count > 0
        ? `\n\n【迭代】第 ${iterCount + 1} 轮${entry.iteration.direction ? ` · 方向：${entry.iteration.direction}` : ""}（上限 ${maxRounds > 0 ? `${maxRounds} 轮` : "不限"}${isLast ? `；**本轮为最后一轮：审计后迭代结束，请 finish 收尾**` : ""}；审计后按插件推送指令继续迭代）`
        : `\n\n【迭代】迭代模式已启用（上限 ${maxRounds > 0 ? `${maxRounds} 轮` : "不限"}）：审计后不删目标，插件将推送【迭代继续】指令（goal 工具 action=iterate 继续 / finish 结束）`)
    // 迭代历史完整信息（与右侧面板一致）：每轮历史目标（目标文本 + 状态 + 方案文档位置 + 阶段）
    const historyBlock = (entry.history ?? []).length > 0
      ? "\n\n【迭代历史】\n" + entry.history.map(h =>
        `第${h.count + 1}轮：${h.goal}（${h.state === "done" ? "已完成" : h.state ?? "已完成"}）` +
        (h.planFile ? `\n  方案文档：${h.planFile}` : "") +
        ((h.stages ?? []).length ? "\n" + h.stages.map(s => `  ${s.status === "in_progress" ? "▶" : s.status === "completed" ? "✓" : "○"} ${s.name ?? s.content ?? ""}${(s.todos ?? []).length ? `（${s.todos.length} 项代办）` : ""}`).join("\n") : "")
      ).join("\n")
      : ""
    return `（第 ${turns} 轮，上限 ${entry.maxTurns > 0 ? `${entry.maxTurns} 轮` : "不限"}）

【目标】${entry.goal}

【系统提醒】本推送为系统自动推送（每 ${Math.round(pushIntervalMs() / 60000)} 分钟检查推送一次）：阶段/代办**完成一项更新一项**（stage/todos 流转），无需逐条更新${flowLine}${iterLine}${historyBlock}${stageBlock}${planLine}

完成全部工作后，最后一步调用 goal 工具 action=audit 结束推进。\n`
  }

  // 迭代快照（audit/finish/重推复用）
  const buildSnap = (e: GoalEntry): string[] => {
    const snap: string[] = [`目标：${e.goal}`]
    if (e.iteration) snap.push(`迭代：第 ${e.iteration.count + 1} 轮${e.iteration.direction ? ` · 方向：${e.iteration.direction}` : ""}`)
    if (e.planFile) snap.push(`计划文件：${e.planFile}`)
    for (const s of e.stages ?? []) {
      snap.push(`  ${s.status === "in_progress" ? "▶" : s.status === "completed" ? "✓" : "○"} ${s.name ?? s.content ?? ""}`)
      for (const t of s.todos ?? []) snap.push(`      ${t.status === "in_progress" ? "▶" : t.status === "completed" ? "✓" : "○"} ${t.content}`)
    }
    return snap
  }

  // iterating 状态重推【迭代继续】（ESC 中断推送响应 / AI 未调用 iterate 的兜底）
  const rePushIterating = async (sessionID: string) => {
    const goals = loadGoals()
    const e = goals[sessionID]
    if (!e || e.state !== "iterating") return
    // ESC 中断：转 paused 停止重推循环（不干扰 ESC 取消）
    if (interrupted.has(sessionID)) {
      interrupted.delete(sessionID)
      e.state = "paused"
      e.updatedAt = Date.now()
      saveGoals(goals)
      await client.tui.showToast({ body: { message: "迭代已被 ESC 中断，目标暂停，/goal-resume 或 goal 工具 resume 恢复", variant: "warning" } })
      return
    }
    const count = e.iteration?.count ?? 0
    // 去重：同一迭代轮只推一次（防 idle 反复触发重复推送【迭代继续】）
    if (rePushIterCount.get(sessionID) === count) return
    rePushIterCount.set(sessionID, count)
    const maxRounds = configIterateMaxRounds()
    const isLast = maxRounds > 0 && count + 1 >= maxRounds
    const text = isLast
      ? `【迭代结束】已达迭代上限 ${maxRounds} 轮，本轮迭代已完成。请立即调用 goal 工具 action=finish 结束迭代收尾。\n\n【本轮快照】\n${buildSnap(e).join("\n")}`
      : `【迭代继续】第 ${count + 1} 轮迭代已完成（迭代模式）。请立即调用 goal 工具 action=iterate 设置下一轮迭代目标：goal = 基于上轮目标、本轮结果与用户反馈改进后的新目标（无反馈则沿当前方向持续优化）。若对目标/方向理解不清或迭代可能偏离 → 先用 question 工具询问用户澄清，不限次数；**完全理解后做一次确认提问（复述你的理解：方向/限制），用户确认后把确认内容写入 iterate 的 direction 参数（确认记录）再 iterate**。\n\n用户例外：若用户已更新目标或明确要求结束，以用户要求为准（结束 → action=finish 收尾）。\n\n【本轮快照】\n${buildSnap(e).join("\n")}`
    await pushPrompt(sessionID, text).catch(() => {})
  }


  const autoContinue = async (sessionID: string, via: "idle" | "msg" = "idle") => {
    // M1 修复：检查后立即占用互斥（原检查与 add 之间隔多个 await，idle/msg 双定时器并发时 TOCTOU 双推进）
    busySet.add(sessionID)
    setTimeout(() => busySet.delete(sessionID), 120000)
    const goals = loadGoals()
    const entry = goals[sessionID]
    if (!entry) {
        // 子代理无目标 + 父代理有目标 → 推送一次完整设目标指导（兜底主 AI 未在 task prompt 写引导）
        await maybePushSubagentGoalGuide(sessionID)
        return
      }
      // 预缓存子代理身份：fork 到子代理会话的目标首次推送前必须确认，避免误判迭代状态/权限
      if (!isSubagentCache.has(sessionID)) {
        try { await isSubagent(sessionID) } catch {}
      }
      // ESC 中断即时信号（session.error 事件，无写入竞态）
      if (interrupted.has(sessionID)) {
        interrupted.delete(sessionID)
        entry.state = "paused"
        entry.updatedAt = Date.now()
        saveGoals(goals)
        await client.tui.showToast({ body: { message: "生成被中断（ESC），目标已暂停，/goal-resume 或 goal 工具 resume 恢复", variant: "warning" } })
        return
      }
      // 状态守卫：非 active（paused/limited/iterating/done）不推进——修复调试日志删除时误删的 state 检查（曾导致 paused 目标被 idle/msg 驱动持续推送）
      if (entry.state !== "active") return
      // 推进时机（权威信号驱动，全部直接推送——opencode prompt 在 busy 时排队，回合完成后自动附加，不打断生成）：
      // via=idle：session.idle 事件 = AI 回合自然完成的权威信号 → 每回合都推（不限频，goal 推进节奏）
      // via=msg：assistant 消息完成驱动 → 限频提醒（AI 连续干活 1 小时也能每 5 分钟插话，不依赖 idle status）
      // 两种驱动不再查 status/挂起——idle 事件/消息完成本身就是回合结束信号，直接推由 opencode 排队附加
      // 去重：lastPushedMsg 按最后消息 id——同一回合两种驱动都触发也只推一次
      // 限频仅用于 msg 驱动（AI 干活中提醒，避免频繁）；idle 驱动（回合结束推进）不限频，每回合都推
      try {
      const res = await client.session.messages({ path: { id: sessionID } })
      const msgs = Array.isArray(res) ? res : ((res as { data?: { info: { role: string, error?: unknown, time?: { completed?: number } }, parts: { type: string, text?: string }[] }[] }).data ?? [])
      // 长思考/生成中保护：最后 assistant 消息未 completed（仍在生成）→ 本轮未真正结束，不推进不暂停，等消息完成后的 session.idle 再处理（避免思考几分钟被误判中断）
      // 跳过插件自身推送的 synthetic 消息（无 completed 是正常状态，不是生成中），避免 idle 驱动被推送消息卡死
      const lastAsst = [...msgs].reverse().find(m => {
        if (m.info.role !== "assistant") return false
        const parts = m.parts ?? []
        return !parts.some(p => p.type === "text" && (p as { synthetic?: boolean }).synthetic === true)
      })
      if (lastAsst && lastAsst.info.time?.completed === undefined) {
        return
      }
      if (lastAsst?.info?.error) {
        entry.state = "paused"
        entry.updatedAt = Date.now()
        saveGoals(goals)
        await client.tui.showToast({ body: { message: "生成被中断（ESC），目标已暂停，/goal-resume 或 goal 工具 resume 恢复", variant: "warning" } })
        return
      }
      // 每回合只推进一次：idle 与消息完成双驱动，按最后 assistant 消息 id 去重（避免重复推送）
      // H2：lastAsst undefined = 尚无任何真实 AI 完成消息（只有插件 synthetic 推送）→ 不推进（防 turns 注水/重复推送）
      const lastMsgId = lastAsst?.id ?? lastAsst?.info?.id
      if (lastPushedMsg.get(sessionID) === lastMsgId) return
      const turns = entry.turns + (via === "idle" ? 1 : 0)
      entry.turns = turns
      entry.updatedAt = Date.now()
      // 迭代模式不设内部推进轮次上限（仅受 iterateMaxRounds 迭代轮数限制）；正常目标模式保持 maxTurns 限制；子代理永远正常模式（不受 config iterateMode 影响）
      const isIterGoal = (configIterateMode() && isSubagentCache.get(sessionID) !== true) || !!entry.iteration
      if (!isIterGoal && entry.maxTurns > 0 && turns > entry.maxTurns) {
        entry.state = "limited"
        saveGoals(goals)
        await client.tui.showToast({ body: { message: `已达轮数上限 ${entry.maxTurns}，目标停止推进（终态；如需继续请用 /goal 重新设置目标）`, variant: "warning" } })
        return
      }
      saveGoals(goals)
      const curStage = (entry.stages ?? []).find(s => s.status === "in_progress")
      const todos = curStage?.todos ?? []
      let todoBlock = ""
      if (todos.length > 0) {
        todoBlock = `\n【代办】（当前阶段：${curStage?.name ?? ""}）\n` + todos.map(t => {
          const mark = t.status === "in_progress" ? "▶" : t.status === "completed" ? "✓" : "○"
          return `${mark} [${t.status}] ${t.content}`
        }).join("\n")
      }
      const prompt = buildPrompt(entry, turns, sessionID) + todoBlock
      await pushPrompt(sessionID, prompt)
      lastPushTime.set(sessionID, Date.now())
      // M3：推送成功后才记录去重 id（推送失败则不记录，后续 idle/msg 驱动可重试，避免静默丢轮）
      lastPushedMsg.set(sessionID, lastMsgId)
    } catch (e) {
      console.error("[goal] auto continue failed:", e)
    } finally {
      busySet.delete(sessionID)
    }
  }

  const subGoalGuideText = `请先调用 goal 工具（action=set）设置你的目标：goal 参数用**主代理下发的任务描述原话**（不要用本消息文本），之后按推送推进直至 goal 工具（action=audit）结束。注意：子代理不允许询问用户，如有疑问按你的理解推进或回报主代理。`
  const subGuideInFlight = new Set<string>()
  // 已推送过设目标引导的子代理（持久化，防重启丢失）：不再重复推送（防子代理 audit 清理目标后死循环重设目标）
  const subGuideGuidedFile = join(stateDir, "sub-goal-guided.json")
  const loadSubGuideGuided = (): Set<string> => {
    try { return new Set(JSON.parse(readFileSync(subGuideGuidedFile, "utf8"))) } catch { return new Set() }
  }
  const saveSubGuideGuided = (s: Set<string>) => writeFileSync(subGuideGuidedFile, JSON.stringify([...s]))
  const maybePushSubagentGoalGuide = async (sid: string) => {
    if (subGuideInFlight.has(sid)) return
    if (loadSubGuideGuided().has(sid)) return
    try {
      subGuideInFlight.add(sid)
      if (!(await isSubagent(sid))) return
      const pinfo = await client.session.get({ path: { id: sid } })
      const pbody = Array.isArray(pinfo) ? pinfo[0] : ((pinfo as { data?: { parentID?: string } }).data ?? pinfo) as { parentID?: string }
      const parentID = pbody?.parentID
      if (!parentID) return
      const p = loadGoals()[parentID]
      // 仅父代理有目标（active/iterating/limited/paused，排除 done/cleared）时才要求子代理设子目标
      if (!p || p.state === "done" || p.state === "cleared") return
      const guided = loadSubGuideGuided()
      guided.add(sid)
      saveSubGuideGuided(guided)
      await pushPrompt(sid, subGoalGuideText)
    } catch (e) {
      console.error("[goal] push subagent goal guide failed:", e)
    } finally {
      subGuideInFlight.delete(sid)
    }
  }

  const handled = new Set<string>()
  const HANDLED_MAX = 5000
  const markHandled = (id: string) => {
    handled.add(id)
    if (handled.size > HANDLED_MAX) handled.clear()  // 旧消息不会再次触发 updated，安全清空
  }

  // ============ 卡住止损 watchdog（opencode #20096/#4061 兜底） ============
  const DEFAULT_STUCK_MS = parseInt(String(options.stuckTimeoutMs ?? "600000"))
  const AUTO_ABORT_SUBAGENT = String(options.autoAbortSubagent ?? "true") !== "false"
  // 消息完成驱动推送的限频间隔（ms）：AI 自主连续干活时每 N 分钟提醒一次（阶段/代办更新），默认 5 分钟
  // H1 修复：优先读 config.json（TUI /goal-config 写入源），回退插件 options（opencode.jsonc）——与 stuckTimeoutMs 读取模式一致
  const pushIntervalMs = () => {
    try {
      const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.pushIntervalMs)
      if (Number.isInteger(n) && n >= 30000) return n
    } catch {}
    return Math.max(30000, Number(options.pushIntervalMs ?? 300000) || 300000)
  }
  const DEFAULT_CLEANUP_DAYS = parseFloat(String(options.cleanupDays ?? "3"))
  const stuckTimeoutMs = () => {
    try {
      const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.stuckTimeoutMs)
      if (Number.isInteger(n) && n >= 60000) return n
    } catch {}
    return DEFAULT_STUCK_MS
  }
  const cleanupDays = () => {
    try {
      const n = parseFloat(JSON.parse(readFileSync(configFile, "utf8"))?.cleanupDays)
      if (Number.isFinite(n) && n > 0) return n
    } catch {}
    return DEFAULT_CLEANUP_DAYS
  }
  const maxRetainedSubagents = () => {
    try {
      const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.maxRetainedSubagents)
      if (Number.isInteger(n) && n >= 0) return n
    } catch {}
    return 60
  }
  const cleanupMs = () => cleanupDays() * 24 * 3600 * 1000
  const lastActivity = new Map<string, number>()   // sessionID -> 最后 part 活动时间
  const isSubagentCache = new Map<string, boolean>()

  const isSubagent = async (sid: string): Promise<boolean> => {
    if (isSubagentCache.has(sid)) return isSubagentCache.get(sid)!
    try {
      const res = await client.session.get({ path: { id: sid } })
      const info = Array.isArray(res) ? res[0] : ((res as { data?: { parentID?: string } }).data ?? res) as { parentID?: string }
      const v = !!info?.parentID
      isSubagentCache.set(sid, v)
      return v
    } catch {
      return false
    }
  }

  const cleanupStuck = async () => {
    const now = Date.now()
    if (lastActivity.size === 0) return
    let statusMap: Record<string, { type: string }> = {}
    try {
      const res = await client.session.status({})
      const body = Array.isArray(res) ? res[0] : ((res as { data?: unknown }).data ?? res)
      if (body && typeof body === "object") statusMap = body as Record<string, { type: string }>
    } catch {}
    for (const [sid, last] of lastActivity) {
      if (now - last < stuckTimeoutMs()) continue
      try {
        const st = statusMap[sid]
        if (st?.type === "idle") {
          lastActivity.delete(sid)
          continue
        }
        const sub = await isSubagent(sid)
        if (sub && AUTO_ABORT_SUBAGENT) {
          // 先注入通知（await 保证写入完成），再中止子代理：主 AI 处理 task 取消结果的同一轮就能看到中止原因
          try {
            const pinfo = await client.session.get({ path: { id: sid } })
            const pbody = Array.isArray(pinfo) ? pinfo[0] : ((pinfo as { data?: unknown }).data ?? pinfo)
            const parentID = (pbody as { parentID?: string } | undefined)?.parentID
            if (parentID) {
              await pushPrompt(parentID, `【系统通知】子代理会话 ${sid.slice(-8)} 因超过 ${stuckTimeoutMs() / 60000} 分钟无活动，被卡住检测自动中止（并非你或用户主动取消）。如需继续该工作，请重新发起子代理任务。`, { noReply: true }).catch(() => {})
            }
          } catch {}
          await client.session.abort({ path: { id: sid } }).catch(() => {})
          await client.tui.showToast({ body: { message: `子代理会话 ${sid.slice(-8)} 疑似卡住（>${stuckTimeoutMs() / 60000} 分钟无活动），已自动中止`, variant: "warning" } })
        } else if (!sub) {
          // 主会话：仅等待子代理期间（最后消息含 running 的 task 工具）不算卡住；长命令（bash 等）仍提示
          let waiting = false
          try {
            const mres = await client.session.messages({ path: { id: sid } })
            const msgs = Array.isArray(mres) ? mres : ((mres as { data?: unknown[] }).data ?? [])
            const lastAsst = [...(msgs as { info?: { role?: string }, parts?: { type?: string, tool?: string, state?: { status?: string } }[] }[])].reverse().find(m => m?.info?.role === "assistant")
            waiting = (lastAsst?.parts ?? []).some(p => p?.type === "tool" && p?.tool === "task" && p?.state?.status === "running")
          } catch {}
          if (waiting) {
            lastActivity.set(sid, Date.now())
            continue
          }
          await client.tui.showToast({ body: { message: `会话 ${sid.slice(-8)} 疑似卡住（>${stuckTimeoutMs() / 60000} 分钟无活动），可 Esc 中断`, variant: "warning" } })
        }
        lastActivity.delete(sid)
      } catch {
        lastActivity.delete(sid)
      }
    }
  }

  // ============ 子代理会话自动清理（完成后超时删除，默认 3 天） ============
  const cleanupLockFile = "/tmp/opencode/goal-cleanup.lock"
  const tryAcquireCleanupLock = (): boolean => {
    try {
      const now = Date.now()
      const old = read(cleanupLockFile, "0")
      const oldTs = parseInt(old, 10)
      if (Number.isFinite(oldTs) && now - oldTs < 120000) return false  // 2 分钟内已有进程执行过
      writeFileSync(cleanupLockFile, String(now))
      return true
    } catch {
      return true
    }
  }
  const cleanupSubagents = async (manual = false): Promise<{ removed: number; failed: number; skipped?: boolean }> => {
    if (!tryAcquireCleanupLock()) return { removed: 0, failed: 0, skipped: true }  // 2 分钟内已有清理执行，跳过（防并发重复删）
    const deadline = Date.now() - cleanupMs()
    const maxRetain = maxRetainedSubagents()
    try {
      const res = await client.session.list({})
      const roots = (Array.isArray(res) ? res : ((res as { data?: unknown[] }).data ?? [])) as { id: string; parentID?: string; time?: { updated: number }; title?: string }[]
      const allSubs: { id: string; parentID?: string; time?: { updated: number }; title?: string }[] = []
      for (const r of roots) {
        if (!r?.id) continue
        try {
          const cres = await client.session.children({ path: { id: r.id } })
          const kids = (Array.isArray(cres) ? cres : ((cres as { data?: unknown[] }).data ?? [])) as { id: string; parentID?: string; time?: { updated: number }; title?: string }[]
          for (const k of kids) if (k?.id) allSubs.push(k)
        } catch {}
      }
      // 主会话保护：仅处理 parentID 非空的子代理，杜绝误删主会话
      const subOnly = allSubs.filter(s => !!s?.parentID)
      let statusMap: Record<string, { type: string }> = {}
      try {
        const sres = await client.session.status({})
        const body = Array.isArray(sres) ? sres[0] : ((sres as { data?: unknown }).data ?? sres)
        if (body && typeof body === "object") statusMap = body as Record<string, { type: string }>
      } catch {}
      // 精确状态判断：busy/retry 跳过；idle 再查最后消息区分 已完成/已失败/未完成（中断）
      const doneStatus = new Set<string>()
      const idleSubs = subOnly.filter(s => statusMap[s.id]?.type === "idle")
      await Promise.all(idleSubs.map(async (s) => {
        try {
          const mres = await client.session.messages({ path: { id: s.id } })
          const msgs = Array.isArray(mres) ? mres : ((mres as { data?: unknown[] }).data ?? [])
          const lastAsst = [...(msgs as { info?: { role?: string, error?: unknown, time?: { completed?: number } } }[])].reverse().find(m => m?.info?.role === "assistant")
          if (!lastAsst?.info) return
          if (lastAsst.info.error) doneStatus.add(s.id)
          else if (lastAsst.info.time?.completed !== undefined) doneStatus.add(s.id)
        } catch {}
      }))
      let removed = 0
      let failed = 0
      const failedIds: string[] = []
      const delOne = async (s: { id: string; parentID?: string }) => {
        if (!s?.parentID) return  // 主会话不删（双保险）
        try {
          await client.session.delete({ path: { id: s.id } })
          const g = loadGoals()
          if (g[s.id]) { delete g[s.id]; saveGoals(g) }  // 子会话目标记录同步清理
          removed++
        } catch (e) {
          failed++
          if (failedIds.length < 5) failedIds.push(s.id)
          console.error(`[goal] 删除子代理会话失败 ${s.id}:`, (e as Error)?.message ?? e)
        }
      }
      // 1) 超过保留上限：仅对已完成/已失败子代理按更新时间排序，删最旧的超出部分；进行中/重试/未完成/未知不统计不删除（手动清理不受上限限制）
      if (maxRetain > 0 && !manual) {
        const done = subOnly.filter(s => doneStatus.has(s.id))
          .sort((a, b) => (a.time?.updated ?? 0) - (b.time?.updated ?? 0))  // 最旧在前
        const excess = done.length - maxRetain
        if (excess > 0) {
          for (let i = 0; i < excess; i++) await delOne(done[i])
        }
      }
      // 2) 超期删除：仅已完成/已失败（进行中/重试/未完成/未知一律保留）；手动清理跳过天数限制，全部已完成/已失败直接删除
      for (const s of subOnly) {
        if (!doneStatus.has(s.id)) continue  // 只删已完成/已失败，防止误删进行中
        if (!manual && (s.time?.updated ?? 0) > deadline) continue
        await delOne(s)
      }
      if (removed > 0 || failed > 0) {
        await client.tui.showToast({ body: { message: `${manual ? "手动清理" : "自动清理"}子代理会话：成功 ${removed} 个${failed ? `，失败 ${failed} 个${failedIds.length ? `（如 ${failedIds.map(id => id.slice(-8)).join(",")}…）` : ""}` : ""}${!manual && maxRetain > 0 ? `（保留上限 ${maxRetain} 个）` : ""}`, variant: failed > 0 ? "warning" : "info" } }).catch(() => {})
      }
      return { removed, failed }
    } catch (e) {
      console.error("[goal] cleanup subagents failed:", e)
      return { removed: 0, failed: 0 }
    }
  }

  // 卡住检测 15s 间隔：远小于最小超时（1 分钟），保证窗口不遗漏
  // 动态间隔卡住检测：间隔 = 阈值/4（上限 60s、下限 5s），保证间隔远小于阈值，避免"间隔≈阈值"边界漏检/延迟截止
  const scheduleStuckCheck = async () => {
    const interval = Math.min(60000, Math.max(5000, Math.floor(stuckTimeoutMs() / 4)))
    setTimeout(() => { scheduleStuckCheck().catch(() => {}) }, interval)
    await cleanupStuck().catch(() => {})
  }
  scheduleStuckCheck().catch(() => {})
  setInterval(() => { cleanupSubagents().catch(() => {}) }, 3600000)
  setTimeout(() => { cleanupSubagents().catch(() => {}) }, 60000)

  return {
    event: async ({ event }) => {
      if (event.type === "message.part.updated") {
        const props = (event.properties as { sessionID?: string } | undefined)
        const sid = props?.sessionID
        if (sid) lastActivity.set(sid, Date.now())
      }
      if (event.type === "session.idle") {
        const sid = (event.properties as { sessionID?: string } | undefined)?.sessionID
        if (sid) {
          lastActivity.delete(sid)
          // 重试被 busy 拒绝的推送（生成结束/idle 窗口送达）
          const retry = pendingRetryPush.get(sid)
          if (retry && retry.length > 0) {
            pendingRetryPush.delete(sid)
            for (const t of retry) pushPrompt(sid, t).catch(() => {})
            lastPushTime.set(sid, Date.now())
          }
          // 事件驱动插话：AI 回合自然完成（idle）→ 发送挂起的推送（busy 期间挂起的 msg 驱动/flow 推送），无轮询
          const pend = pendingPushQueue.get(sid)
          if (pend && pend.length > 0) {
            pendingPushQueue.delete(sid)
            for (const t of pend) pushPrompt(sid, t).catch(() => {})
            lastPushTime.set(sid, Date.now())
          }
          if (pendingMsgDrive.delete(sid)) {
            setTimeout(() => { autoContinue(sid, "msg").catch(() => {}) }, 1200)
          }
          setTimeout(() => autoContinue(sid, "idle"), 1200)
          // iterating 状态兜底：ESC 打断/未执行 iterate 时重推迭代指令
          setTimeout(() => rePushIterating(sid), 1500)
          // 非迭代 audit / finish 的二次审计推送：本轮完全结束后推送一次
          const sec = pendingSecondaryPush.get(sid)
          if (sec) {
            pendingSecondaryPush.delete(sid)
            pushPrompt(sid, sec).catch(() => {})
          }
        }
      }
      if (event.type === "session.error") {
        const props = (event.properties as { sessionID?: string; error?: { name?: string } } | undefined)
        const sid = props?.sessionID
        const name = (props?.error as { name?: string } | undefined)?.name
        if (sid && name === "MessageAbortedError") {
          interrupted.add(sid)
        }
      }
      if (event.type === "message.updated") {
        const info = (event.properties as {
          info?: { sessionID?: string; id?: string; role?: string; agent?: string; error?: unknown }
        } | undefined)?.info
        if (!info?.sessionID || !info.id) return
        const sid = info.sessionID
        // assistant 消息更新 → 限频驱动推进（不依赖 idle：goal 模式 AI 自主连续干活时 idle 不触发，阶段/代办长期不推送不更新）
        // 只在消息已完成（time.completed）时触发——生成结束窗口 pushPrompt 才能成功（流式中触发会被 opencode Session is busy 拒绝丢失）
        if (info.role === "assistant") {
          const completed = (info.time as { completed?: number } | undefined)?.completed
          // 消息完成 = 生成结束窗口：优先送达被 busy 拒绝的挂起推送
          const retry = pendingRetryPush.get(sid)
          if (completed && retry && retry.length > 0) {
            pendingRetryPush.delete(sid)
            for (const t of retry) pushPrompt(sid, t).catch(() => {})
            lastPushTime.set(sid, Date.now())
          }
          if (completed && loadGoals()[sid] && Date.now() - (lastPushTime.get(sid) ?? 0) >= pushIntervalMs()) {
            setTimeout(() => { autoContinue(sid, "msg").catch(() => {}) }, 1200)
          }
          return
        }
        if (handled.has(info.id)) return
        if (info.role !== "user") return
        const mid = info.id
        const agent = info.agent
        setTimeout(async () => {
          try {
            markHandled(mid)  // H1 修复：回调开头即标记，同一消息多次 updated 只处理一次（防重复设目标/重复推送第 1 轮）
            const res = await client.session.message({ path: { id: sid, messageID: mid } })
            const body = Array.isArray(res) ? res[0] : ((res as { data?: unknown }).data ?? res) as { info?: { parts?: { type: string, text?: string, synthetic?: boolean }[] }, parts?: { type: string, text?: string, synthetic?: boolean }[] }
            const parts = body?.parts ?? body?.info?.parts ?? []
            if (parts.some(p => (p as { synthetic?: boolean }).synthetic === true)) return
            const text = parts.filter(p => p.type === "text").map(p => p.text ?? "").join("\n").trim()
            if (!text) return
            // 子代理收到任务消息（task prompt）：若尚无目标 → 立即推送设目标引导（不等 idle 结束后才推，否则子代理已完成任务引导无意义）
            try {
              if (await isSubagent(sid)) {
                if (!loadGoals()[sid]) await maybePushSubagentGoalGuide(sid)
              }
            } catch {}
            if (text.startsWith("---GOAL-END---")) return
            if (/^（第 \d+ 轮，上限 /.test(text)) return

            // 解析 /goal 命令（用户显式设/换目标，优先级最高）；仅匹配开头且 /goal 后跟空格或结尾，避免 /goal-xxx 命令被误判
            // /goal-iter：临时开启一次迭代模式（iteration={count:0} 标记）
            let goalText = ""
            let forceIterate = false
            const isGoalIterCmd = /^\/goal-iter(?:\s|$)/.test(text)
            const isGoalCmd = !isGoalIterCmd && /^\/goal(?:\s|$)/.test(text)
            if (isGoalIterCmd || isGoalCmd) {
              const marker = "---GOAL-END---"
              const idx = text.indexOf(marker)
              const goalPart = idx >= 0 ? text.slice(0, idx) : text
              goalText = goalPart.replace(/^\/goal-iter\s*/, "").replace(/^\/goal\s*/, "").trim()
              forceIterate = isGoalIterCmd
              if (!goalText) {
                await client.tui.showToast({ body: { message: `${isGoalIterCmd ? "/goal-iter" : "/goal"} 目标不能为空`, variant: "warning" } })
                return
              }
            }

            const existing = loadGoals()[sid]
            if (existing && !isGoalCmd && !isGoalIterCmd) {
              // 已有目标 + 非 /goal：不覆盖（防误发）；paused 且 z-goal → 视为澄清回答恢复推进
              if (existing.state === "paused" && agent === "z-goal") {
                const g2 = loadGoals()
                g2[sid].state = "active"
                g2[sid].updatedAt = Date.now()
                saveGoals(g2)
                await client.tui.showToast({ body: { message: "已收到澄清回答，目标恢复推进", variant: "success" } })
                // 不在此立即 autoContinue：让 AI 自然响应用户消息，session.idle 后再推进，避免检测到中断旧消息误判暂停
              }
              return
            }

            // 设置/覆盖目标：/goal 显式覆盖；无目标时 z-goal agent 消息设为目标
            if (!isGoalCmd && !isGoalIterCmd) {
              if (agent !== "z-goal") return
              goalText = text
            }
            const goals = loadGoals()
            const ts = Date.now()
            await isSubagent(sid)  // 预缓存子代理身份，供 buildPrompt 同步判断（子代理不迭代）
            goals[sid] = { goal: goalText, state: "active", turns: 0, maxTurns: (forceIterate || configIterateMode()) ? 0 : currentMaxTurns(), updatedAt: ts, startedAt: existing?.startedAt ?? ts, stages: [], planFile: existing?.planFile ?? `${resolvePlanDir()}/${sid}-${ts}.md`, flow: "explore", ...(forceIterate ? { iteration: { count: 0 } } : {}) }
            saveGoals(goals)
            // H3/M2 修复：新目标不受旧 ESC 标记误暂停；推进去重/限频状态重置（防新目标第一轮被旧记录吞掉）
            interrupted.delete(sid)
            lastPushedMsg.delete(sid)
            lastPushTime.delete(sid)
            // 新目标设置：重置 every 模式的询问提醒记录（新迭代目标规划时重新提醒）
            iterAskedForRound.delete(sid)
            await client.tui.showToast({ body: { message: (isGoalCmd || isGoalIterCmd) ? `目标已设置/更新${forceIterate ? "（临时迭代模式）" : ""}，开始自主推进` : "目标已自动设置，开始自主推进", variant: "success" } })
            // 立即推送第一轮（z-goal agent，带强制规划指令），确保 z-goal 提示词第一时间到位
            pushFirstRound(sid)
          } catch (e) {
            console.error("[goal] auto set failed:", e)
          }
        }, 300)
      }
    },
    tool: {
      goal: tool({
        description:
          "目标推进管理（ /goal 风格，按会话隔离）：每个会话独立目标，支持阶段与代办。设置后插件每轮自动发送「目标+阶段总览+代办」直到完成、暂停或达轮数上限。" +
          "调用时机：用户要求持续工作直到完成/修到全绿/持续推进时先 set；**流程切换用 flow（explore→plan→execute→audit，探索/规划中发现信息不足可回 explore）**；阶段流转用 stage；阶段整体修改用 update_stages；**当前阶段代办用 todos**；**全部工作完成并审计通过后，最后一步必须调用 audit 结束推进**；暂停、恢复、查看进度、取消分别对应 pause/resume/status/clear；手动清理已完成/已失败子代理会话用 cleanup（不受清理天数限制）。" +
          "迭代模式（config iterateMode 开启）：audit 后不删目标，插件在本轮结束后推送【迭代继续】指令（goal 工具 action=iterate 继续下一轮 / finish 结束收尾）。",
        args: {
          action: tool.schema
            .string()
            .describe("操作：set 设置目标 / flow 切换当前流程（explore/plan/execute/audit，规划中发现不足可回 explore）/ update_stages 整体替换阶段 / stage 更新阶段状态（支持 updates 批量）/ todos 更新当前阶段代办清单 / audit 审计（迭代模式下不删目标，插件推送【迭代继续】指令）/ iterate 设置下一轮迭代目标 / finish 迭代结束收尾 / status 查看进度 / pause 暂停 / resume 恢复 / clear 清除 / cleanup 手动清理已完成已失败子代理（不受天数限制）"),
          goal: tool.schema.string().optional().describe("目标描述（action=set / iterate 必填）"),
          direction: tool.schema.string().optional().describe("迭代方向（action=iterate 可选，缺省沿用上次迭代方向或 goal）"),
          stageID: tool.schema.string().optional().describe("阶段 id（action=stage 单个更新时必填；action=todos 可选，缺省=当前 in_progress 阶段，指定后可更新任意阶段代办，如补充其他阶段代办）"),
          stageStatus: tool.schema.string().optional().describe("阶段状态：in_progress/completed/pending（action=stage，单个更新时必填）"),
          updates: tool.schema.string().optional().describe("批量更新阶段状态 JSON（action=stage，与 stageID 二选一）：[{\"id\":\"s1\",\"status\":\"completed\"},{\"id\":\"s2\",\"status\":\"completed\"}]，一次标记多个阶段完成"),
          stages: tool.schema.string().optional().describe("阶段列表 JSON（action=update_stages 必填）"),
          flow: tool.schema.string().optional().describe("当前流程（action=flow 必填）：explore 探索 / plan 规划 / execute 执行 / audit 审计；规划中发现信息不足可用 flow=explore 回探索"),
          todos: tool.schema.string().optional().describe("当前阶段代办清单 JSON（action=todos 必填）：[{\"content\":\"...\",\"status\":\"pending\"},…]"),
        },
        async execute(args, context) {
          const sid = context.sessionID
          try {
          const goals = loadGoals()
          const action = args.action ?? ""
          // 公共收尾：audit 非迭代 与 finish 复用（删除/保留目标 + 推送二次审计）
          const finishGoal = (e: GoalEntry, kind: "audit" | "finish") => {
            const snap = buildSnap(e)
            const planText = e.planFile ? (() => { try { const t = readFileSync(e.planFile, "utf8").trim(); return t || "" } catch { return "" } })() : ""
            const deleting = configAuditDelete()
            if (deleting) delete goals[sid]
            else { e.state = "done"; e.updatedAt = Date.now() }
            lastPushedMsg.delete(sid)
            lastPushTime.delete(sid)
            saveGoals(goals)
            const text = `【二次审计】${kind === "finish" ? "迭代已结束" : "目标已提交审计"}，${deleting ? "并清理" : "（已保留）"}。请做最终完成度确认：① 目标验收点是否全部达成 ② 有无遗漏未完成事项 ③ 是否可确认收尾。**确认通过即完成；如发现遗漏未完成，请用 goal 工具（action=set）重新设置原目标（完完整整原话）后继续推进。**\n\n【审计快照】\n${snap.join("\n")}${planText ? `\n\n【方案文档】\n${planText}` : ""}`
            pendingSecondaryPush.set(sid, text)
            return deleting
          }
          switch (action) {
            case "set": {
              const g = (args.goal ?? "").trim()
              if (!g) return "缺少目标描述，请提供 goal 参数"
              const max = currentMaxTurns()
              const prev = goals[sid]
              await isSubagent(sid)  // 预缓存子代理身份，供 buildPrompt 同步判断（子代理不迭代）
              // M8：子代理永远正常模式（不受 iterateMode 影响）——iterateMode 只对主代理目标取消内部轮次上限
              goals[sid] = { goal: g, state: "active", turns: 0, maxTurns: (configIterateMode() && isSubagentCache.get(sid) !== true) ? 0 : max, updatedAt: Date.now(), startedAt: prev?.startedAt ?? Date.now(), stages: [], planFile: prev?.planFile ?? `${resolvePlanDir()}/${sid}-${Date.now()}.md`, flow: "explore" }
              saveGoals(goals)
              interrupted.delete(sid)
              lastPushedMsg.delete(sid)  // M2：推进去重状态重置（防新目标第一轮被旧记录吞掉）
              lastPushTime.delete(sid)
              pendingSecondaryPush.delete(sid)  // M6：设新目标时丢弃旧二次审计推送
              pendingPushQueue.delete(sid)
              pendingMsgDrive.delete(sid)
              pendingRetryPush.delete(sid)
              iterAskedForRound.delete(sid)
              await client.tui.showToast({ body: { message: "目标已设置，开始自主推进", variant: "success" } })
              // 立即推送第一轮（不等 idle），子代理 set 后第一时间收到推进提示
              pushFirstRound(sid)
              return `目标已设置：${g}（上限 ${max > 0 ? `${max} 轮` : "不限"}，仅本会话自动推进）。请规划目标阶段（goal 工具 action=update_stages）。全部完成后最后一步调用 goal 工具 action=audit 结束推进。`
            }
            case "stage": {
              const e = goals[sid]
              if (!e) return "本会话没有目标"
              if (args.updates) {
                let arr: { id: string; status: string }[]
                try {
                  // 兼容数组或字符串（部分模型直接传 JSON 数组）
                  const raw = args.updates
                  const parsed = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : (() => { throw new Error("not string or array") })()
                  if (!Array.isArray(parsed)) throw new Error("not array")
                  arr = parsed
                } catch {
                  return "updates 参数必须是数组：[{\"id\":\"s1\",\"status\":\"completed\"},…]"
                }
                const done: string[] = []
                const VALID = ["pending", "in_progress", "completed"]
                for (const u of arr) {
                  if (!u?.id || !u?.status) return "updates 每项需含 id 与 status"
                  if (!VALID.includes(u.status)) return `非法阶段状态：${u.status}（可用 pending/in_progress/completed）`  // M5
                  const stage = (e.stages ?? []).find(s => s.id === u.id)
                  if (!stage) return `找不到阶段 ${u.id}`
                  stage.status = u.status
                  const auto = u.status === "completed" ? autoCompleteDoneTodos(stage) : 0
                  done.push(`${stage.name}→${u.status}${auto ? `（自动打勾 ${auto} 条未完成代办）` : ""}`)
                }
                saveGoals(goals)
                return `阶段批量更新完成：${done.join("；")}`
              }
              const id = args.stageID ?? ""
              const st = args.stageStatus ?? ""
              if (!id || !st) return "缺少 stageID+stageStatus，或用 updates 批量更新"
              if (!["pending", "in_progress", "completed"].includes(st)) return `非法阶段状态：${st}（可用 pending/in_progress/completed）`  // M5
              const stage = (e.stages ?? []).find(s => s.id === id)
              if (!stage) return `找不到阶段 ${id}（当前阶段：${(e.stages ?? []).map(s => s.id).join(",") || "无"}）`
              stage.status = st
              const auto = st === "completed" ? autoCompleteDoneTodos(stage) : 0
              saveGoals(goals)
              return `阶段「${stage.name}」状态已更新为 ${st}${auto ? `（自动打勾 ${auto} 条未完成代办）` : ""}`
            }
            case "update_stages": {
              const e = goals[sid]
              if (!e) return "本会话没有目标"
              let arr: GoalStage[] = []
              try {
              // 兼容数组或字符串：部分模型把 stages 直接传 JSON 数组（对象），JSON.parse(数组) 会失败报错
              const raw = args.stages ?? "[]"
              const parsed = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : (() => { throw new Error("not string or array") })()
              if (!Array.isArray(parsed)) throw new Error("not array")
              arr = (parsed as { id?: unknown; name?: unknown; content?: unknown; status?: unknown; todos?: unknown[] }[])
                .map(s => {
                  if (!s.name && s.content) s.name = s.content
                  return { id: String(s.id ?? ""), name: String(s.name ?? ""), status: String(s.status ?? "pending"), ...(Array.isArray(s.todos) ? { todos: normalizeTodos(s.todos) } : {}) }
                })
                .filter(s => s.id && s.name)
              } catch {
                return "stages 参数必须是阶段 JSON 数组：[{\"id\":\"s1\",\"name\":\"阶段名\",\"status\":\"pending\"},…]"
              }
              e.stages = arr
              saveGoals(goals)
              const emptyStages = arr.filter(s => (s.todos ?? []).length === 0).map(s => s.name)
              return `阶段列表已更新（共 ${arr.length} 个阶段）${emptyStages.length ? `\n提示：阶段 ${emptyStages.join("、")} 无代办（一次全写规则下建议每阶段 ≥1 条）` : ""}`
            }
            case "todos": {
              const e = goals[sid]
              if (!e) return "本会话没有目标"
              const stages = e.stages ?? []
              const target = args.stageID ? stages.find(s => s.id === args.stageID) : stages.find(s => s.status === "in_progress")
              if (!target) return args.stageID
                ? `找不到阶段 ${args.stageID}（现有阶段：${stages.map(s => s.id).join(",") || "无"}）`
                : "没有当前阶段（无 in_progress 阶段），请先用 update_stages 规划阶段，或传 stageID 指定阶段"
              let arr: unknown[] = []
              try {
                const raw = args.todos ?? "[]"
                if (typeof raw === "string") {
                  arr = JSON.parse(raw)
                } else if (Array.isArray(raw)) {
                  arr = raw
                } else {
                  throw new Error("not string or array")
                }
                if (!Array.isArray(arr)) throw new Error("not array")
              } catch {
                return `todos 参数解析失败（收到：${String(args.todos ?? "").slice(0, 120)}）。请用 JSON 数组：[{"content":"xxx","status":"pending"}]，或 [{"content":"xxx","status":"completed"}]`
              }
              target.todos = arr
                .map(t => {
                  const o = (t ?? {}) as { content?: unknown; status?: unknown; priority?: unknown }
                  return {
                    content: String(o.content ?? ""),
                    status: ["pending", "in_progress", "completed"].includes(String(o.status)) ? String(o.status) : "pending",  // M5：非法状态兜底为 pending
                    priority: o.priority !== undefined ? String(o.priority) : undefined,
                  }
                })
                .filter(t => t.content)
              saveGoals(goals)
              return `阶段「${target.name}」代办已更新（共 ${target.todos.length} 条${args.stageID ? `，指定阶段 ${args.stageID}` : ""}）`
            }
            case "audit": {
              const e = goals[sid]
              if (!e) return "本会话没有目标"
              // 状态守卫：iterating/done 拒绝重复审计（防重复 finishGoal → 二次审计反复推送）
              if (e.state === "iterating") return "本轮迭代已完成，等待 iterate 继续或 finish 结束（无需重复审计）"
              if (e.state === "done") return "目标已完成（done），无需重复审计"
              if (configIterateMode() || e.iteration) {
                // 子代理目标（无 iteration）不受全局 iterateMode 影响，按非迭代收尾，防止子代理进入迭代循环无限迭代偏离
                if (configIterateMode() && !e.iteration && await isSubagent(sid)) {
                  const deleting = finishGoal(e, "audit")
                  await client.tui.showToast({ body: { message: `目标完成：审计通过${deleting ? "并清理" : "（已保留）"}`, variant: "success" } })
                  return `审计通过，目标已${deleting ? "清理" : "标记完成保留"}，推进已停止。`
                }
                // 迭代流程：不删目标，只转 iterating；【迭代继续】直接推送（不依赖 idle——AI 连续干活无 idle 时 rePushIterating 不触发会卡死迭代；
                // busy 拒绝时 pushPrompt 挂起到 pendingRetryPush，消息完成窗口自动送达；rePushIterCount 去重防重复）
                const count = e.iteration?.count ?? 0
                const maxRounds = configIterateMaxRounds()
                const isLast = maxRounds > 0 && count + 1 >= maxRounds
                e.state = "iterating"
                e.updatedAt = Date.now()
                saveGoals(goals)
                await client.tui.showToast({ body: { message: `目标完成：迭代模式第 ${count + 1} 轮完成${isLast ? `（已达迭代上限 ${maxRounds} 轮，请 finish 结束）` : "，已推送继续指令"}`, variant: "success" } })
                setTimeout(() => { rePushIterating(sid).catch(() => {}) }, 2000)
                return isLast
                  ? `第 ${count + 1} 轮迭代完成（已达迭代上限 ${maxRounds} 轮，本轮为最后一轮），迭代结束。请调用 goal 工具 action=finish 结束收尾。`
                  : `第 ${count + 1} 轮迭代完成，推进进入 iterating，本轮结束后插件推送【迭代继续】指令，AI 调用 iterate 继续。`
              }
              // 非迭代流程：按 auditDelete 删除/保留；【二次审计】由 session.idle 在本轮结束后推送一次
              const deleting = finishGoal(e, "audit")
              await client.tui.showToast({ body: { message: `目标完成：审计通过${deleting ? "并清理" : "（已保留）"}`, variant: "success" } })
              return `审计通过，目标已${deleting ? "清理" : "标记完成保留"}，推进已停止。`
            }
            case "iterate": {
              const g = (args.goal ?? "").trim()
              if (!g) return "缺少迭代目标，请提供 goal 参数（迭代方向原话）"
              const prev = goals[sid]
              if (!prev) return "本会话没有目标，无法迭代（迭代模式需用户通过 /goal-iter 命令或 config iterateMode 开启，AI 不能主动开启）"
              if (prev.state !== "iterating" && prev.state !== "paused" && prev.state !== "limited") {
                return `当前状态 ${prev.state} 不是迭代等待，无需 iterate（仅 iterating/paused/limited 可迭代）`
              }
              // 仅迭代模式目标可迭代（用户 /goal-iter 或 config iterateMode 开启），防止 AI 主动开启迭代导致子代理一直迭代偏离
              if (!configIterateMode() && !prev.iteration) {
                return "当前目标不是迭代模式（需用户通过 /goal-iter 命令或 config iterateMode 开启），AI 不能主动开启迭代"
              }
              // 子代理永远按正常目标模式推进，不可迭代（迭代仅主代理，由用户通过 /goal-iter 或 config iterateMode 开启）
              if (await isSubagent(sid)) {
                return "子代理目标按正常目标模式推进，不支持迭代（迭代仅主代理可用，由用户 /goal-iter 或 config iterateMode 开启）"
              }
              // 迭代轮数上限（config iterateMaxRounds，0 = 无限）
              const maxRounds = configIterateMaxRounds()
              const nextCount = (prev?.iteration?.count ?? 0) + 1
              if (maxRounds > 0 && nextCount > maxRounds) {
                return `已达迭代轮数上限 ${maxRounds} 轮，请调用 goal 工具 action=finish 结束迭代`
              }
              const it = { count: nextCount, direction: String(args.direction ?? prev?.iteration?.direction ?? g) }
              const pdir = resolvePlanDir()
              mkdirSync(pdir, { recursive: true })
              // 保留迭代历史完整快照：上一轮目标无条件压入（goal/阶段含代办/方案文档/流程/轮数）；进入下一轮 → 上一轮状态统一为已完成
              const history: GoalHistoryItem[] = [
                ...(prev?.history ?? []),
                ...(prev ? [{
                  goal: prev.goal,
                  count: prev.iteration?.count ?? 0,
                  direction: prev.iteration?.direction,
                  time: prev.updatedAt,
                  stages: prev.stages,
                  planFile: prev.planFile,
                  state: "done",
                  flow: prev.flow,
                  turns: prev.turns,
                  maxTurns: prev.maxTurns,
                }] : []),
              ]
              goals[sid] = {
                goal: g,
                state: "active",
                turns: 0,
                maxTurns: 0,
                updatedAt: Date.now(),
                startedAt: prev?.startedAt ?? Date.now(),
                stages: [],
                planFile: join(pdir, `${sid}-${Date.now()}.md`),
                flow: "explore",
                iteration: it,
                history,
              }
              saveGoals(goals)
              interrupted.delete(sid)
              lastPushedMsg.delete(sid)  // M2：新迭代轮推进去重状态重置
              lastPushTime.delete(sid)
              // 新迭代轮开始，重置 every 模式的询问提醒记录（让新迭代轮规划时重新提醒）
              iterAskedForRound.delete(sid)
              await client.tui.showToast({ body: { message: `第 ${it.count + 1} 轮迭代已开始`, variant: "success" } })
              // 新迭代轮 = 新目标：立即推送第 1 轮推进提示（与 set 一致，不等 idle——AI 连续干活时 idle 驱动不触发会卡停）
              pushFirstRound(sid)
              return `第 ${it.count + 1} 轮迭代目标已设置：${g}（方向：${it.direction}）。请规划阶段（update_stages）并推进；完成后再 audit。`
            }
            case "finish": {
              const e = goals[sid]
              if (!e) return "本会话没有目标"
              // finish 仅用于迭代模式结束；非迭代目标请用 audit 收尾（防止语义混乱）
              if (!configIterateMode() && !e.iteration) {
                return "本目标不是迭代模式，请用 goal 工具 action=audit 收尾（finish 仅用于迭代结束）"
              }
              // 状态守卫：仅 iterating 可 finish（防 active 目标被提前 finish 跳过整个流程）
              if (e.state !== "iterating") {
                return `当前状态 ${e.state} 不是迭代等待（iterating），无法 finish——需先 audit 完成本轮迭代后进入 iterating 才能结束`
              }
              const deleting = finishGoal(e, "finish")
              await client.tui.showToast({ body: { message: `迭代结束：审计通过${deleting ? "并清理" : "（已保留）"}`, variant: "success" } })
              return `迭代结束，目标已${deleting ? "清理" : "标记完成保留"}，推进已停止。`
            }
            case "status": {
              const e = goals[sid]
              if (!e) return "本会话没有目标"
              const lines = [`状态=${e.state} 流程=${e.flow ?? "explore"} 轮数=${e.turns}/${e.maxTurns > 0 ? e.maxTurns : "不限"}${(e.iteration || configIterateMode()) ? ` 迭代=${(e.iteration?.count ?? 0) + 1}/${configIterateMaxRounds() > 0 ? configIterateMaxRounds() : "不限"}${e.iteration?.direction ? ` 方向=${e.iteration.direction}` : ""}` : ""} 目标=${e.goal}`]
              for (const h of e.history ?? []) lines.push(`  迭代历史 第${h.count + 1}轮：${h.goal.slice(0, 60)}${h.direction ? `（方向：${h.direction.slice(0, 40)}）` : ""}`)
              for (const s of e.stages ?? []) {
                lines.push(`  ${s.status === "in_progress" ? "▶" : s.status === "completed" ? "✓" : "○"} ${s.name ?? s.content ?? ""} (${s.status})`)
                for (const t of s.todos ?? []) lines.push(`      ${t.status === "in_progress" ? "▶" : t.status === "completed" ? "✓" : "○"} [${t.status}] ${t.content}`)
              }
              return lines.join("\n")
            }
            case "pause":
              if (!goals[sid]) return "本会话没有目标"
              goals[sid].state = "paused"
              saveGoals(goals)
              return "目标已暂停，不再自动继续（可调用 goal resume 恢复）"
            case "resume":
              if (!goals[sid]) return "本会话没有目标"
              if (goals[sid].state === "paused") {
                // 暂停恢复：不重置轮数，从当前轮数继续
                goals[sid].state = "active"
                goals[sid].updatedAt = Date.now()
                saveGoals(goals)
                interrupted.delete(sid)
                return `目标已恢复，继续推进（当前第 ${goals[sid].turns} 轮）`
              }
              if (goals[sid].state === "limited") {
                // limited 是终态（达 maxTurns 上限），不接受 resume，避免死循环
                return `已达轮数上限（${goals[sid].maxTurns} 轮），目标停止推进无法恢复；如需继续请用 /goal 重新设置目标`
              }
              if (goals[sid].state === "iterating") {
                goals[sid].state = "active"
                goals[sid].updatedAt = Date.now()
                saveGoals(goals)
                interrupted.delete(sid)
                return "迭代等待已恢复推进（iterating→active），继续按当前目标推进，完成后可再 audit。"
              }
              return `当前状态 ${goals[sid].state}，无需恢复`
            case "clear": {
              if (!goals[sid]) return "本会话没有目标"
              delete goals[sid]
              lastPushedMsg.delete(sid)
              lastPushTime.delete(sid)
              pendingSecondaryPush.delete(sid)  // M6：清除目标时丢弃挂起的二次审计推送（防旧快照推给新目标）
              pendingPushQueue.delete(sid)
              pendingMsgDrive.delete(sid)
              pendingRetryPush.delete(sid)
              pendingRetryPush.delete(sid)
              saveGoals(goals)
              return "本会话目标已清除"
            }
            case "cleanup": {
              const r = await cleanupSubagents(true)
              if (r.skipped) return "2 分钟内已有子代理清理在执行，本次跳过（稍后重试）"
              return `手动清理完成：删除已完成/已失败子代理 ${r.removed} 个（不受清理天数限制）${r.failed ? `，失败 ${r.failed} 个` : ""}。进行中/重试/未完成会话一律保留。`
            }
            case "flow": {
              if (!goals[sid]) return "本会话没有目标"
              if (goals[sid].state !== "active") return `目标未进行中（当前 ${goals[sid].state}），无法切换流程`
              const f = String(args.flow ?? "")
              if (f !== "explore" && f !== "plan" && f !== "execute" && f !== "audit") {
                return `flow 参数无效：${f}（可用 explore/plan/execute/audit）`
              }
              goals[sid].flow = f as GoalEntry["flow"]
              goals[sid].updatedAt = Date.now()
              saveGoals(goals)
              // 事件驱动插话：busy 时挂起到队列，等 session.idle（AI 回合完成）到达时发送——无轮询、不打断生成
              const fe = goals[sid]
              // 直接推送（opencode prompt 排队，回合结束后附加，不打断）——flow 切换是 AI 主动操作，即时同步状态
              pushPrompt(sid, buildPrompt(fe, fe.turns, sid)).catch(() => {})
              lastPushTime.set(sid, Date.now())  // M7：流程切换推送后记录限频时间（防 msg 驱动立即重复触发）
              return `当前流程已切换为：${f}（将等待当前回合完成后推送新流程提醒）`
            }
            default:
              return `未知 action：${action}（可用 set/stage/update_stages/todos/audit/iterate/finish/status/pause/resume/clear/cleanup/flow）`
          }
          } catch (e) {
            console.error("[goal] execute error:", e)
            return `goal 工具执行异常：${e instanceof Error ? e.message : String(e)}。目标状态未变更（goals.json 并发写冲突？请重试一次）`
          }
        },
      }),
    },
  }
}

const plugin: PluginModule = {
  id: "opencode-goal",
  server: GoalPlugin,
}

export default plugin
