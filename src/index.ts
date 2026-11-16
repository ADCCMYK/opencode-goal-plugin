// V2 迁移：插件 API 由 @opencode-ai/plugin（V1：Plugin 函数返回 hooks）换成 @opencode/plugin（V2：Plugin.define + setup(ctx)）
import { Plugin } from "@opencode/plugin"
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync } from "node:fs"
import { join } from "node:path"

// V2 里插件 options 由宿主通过 ctx.options 传入（V1 是 opencode.jsonc 里 plugin 条目的第二项）——形状不变
type PluginOptions = Record<string, unknown>

const home = process.env.HOME ?? "/root"
const stateDir = join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "goal")
mkdirSync(stateDir, { recursive: true })
const goalsFile = join(stateDir, "goals.json")

// ── 团队事件统一通知（唯一入口）──────────────────────────────────────────────
//   事件来源：① 目标变更（saveGoals 的唯一写入路径挂钩）② 收到消息（action=tell 成功投递）
//   作用：叫醒 action=wait 的等待者（团队等待工具：自定义时长，收到消息或目标更新即结束等待）
type TeamEvent = { kind: "goal" | "message"; sid: string; detail?: string }
// waiter 返回 true = 认领该事件（已唤醒）；false = 与它无关（自己/队外）→ 必须保留，继续等
type TeamWaiter = (e: TeamEvent) => boolean
let lastGoalsSnapshot: Record<string, GoalEntry> = {}
const teamWaiters = new Set<TeamWaiter>()
let onGoalRemoved: (sid: string) => void = () => {}
function notifyTeamEvent(kind: TeamEvent["kind"], sid: string, detail?: string) {
  // ⚠ 只有认领（true）才移除 waiter：否则任意无关事件（自己会话/队外会话）都会把等待者误删，
  //   队友随后完成也叫不醒 → wait 只能干等到超时（实测踩过：目标已完成，wait 仍在等）
  for (const w of [...teamWaiters]) {
    let handled = false
    try { handled = w({ kind, sid, detail }) } catch {}
    if (handled) teamWaiters.delete(w)
  }
}

const configFile = join(stateDir, "config.json")
const DEFAULT_PLAN_DIR = "/tmp/plan"
mkdirSync(DEFAULT_PLAN_DIR, { recursive: true })
// V2：server 插件没有 TUI toast 通道（V1 的 client.tui.showToast）→ 写通知队列，由 CLI 插件读取后弹 toast；同时打日志兜底
const notifyFile = join(stateDir, "notify.jsonl")
// ── 用户通道（唯一函数 / 唯一出口）───────────────────────────────────────────────
//   纪律：**用户通道 与 模型通道 不得混杂** —— 本函数只写"给人看"的通道（notify.jsonl → CLI 侧 drainNotify → toast），
//   绝不把文本送进模型上下文；反之 pushPrompt 也绝不把模型侧文本写进本队列。
//   （V1 的 client.tui.showToast 等价物；调用点不得绕过本函数直接写队列/直调 toast。）
function notify(variant: string, message: string) {
  try { appendFileSync(notifyFile, JSON.stringify({ at: Date.now(), pid: process.pid, kind: variant || "info", message }) + "\n") } catch (e) { console.error("[goal] notify failed:", e) }
  if (variant === "warning" || variant === "error") console.error(`[goal] ${message}`)
  else console.log(`[goal] ${message}`)
}

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
  // 唯一写入路径 ⇒ 在这里挂“团队事件统一通知”（谁的目标变了），叫醒 action=wait 的等待者
  let removed: string[] = []
  try {
    const changed: string[] = []
    for (const [k, v] of Object.entries(g)) {
      const prev = lastGoalsSnapshot[k]
      if (!prev || JSON.stringify(prev) !== JSON.stringify(v)) changed.push(k)
    }
    for (const k of Object.keys(lastGoalsSnapshot)) if (!(k in g)) { changed.push(k); removed.push(k) }
    if (changed.length > 0) notifyTeamEvent("goal", changed.join(","), undefined)
  } catch {}
  lastGoalsSnapshot = JSON.parse(JSON.stringify(g))
  // 目标被删除（audit 清理 / clear / finish）= 完成事件 ⇒ 清理该会话排队中的推送
  for (const k of removed) { try { onGoalRemoved(k) } catch {} }

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

const GoalPlugin = async (ctx: any, options: PluginOptions = {}): Promise<() => void> => {
  const cfgMax = parseInt(String(options.maxTurns ?? ""))
  const defaultMaxTurns = Number.isInteger(cfgMax) && cfgMax >= 0 ? cfgMax : 100
  const currentMaxTurns = () => {
    const rt = loadRuntimeMaxTurns()
    return rt === null ? defaultMaxTurns : rt  // 0 = 无限
  }

  // V2：诊断开关（config.json 里 debugEvents=true 才写 /tmp/opencode/goal-events.log；默认关闭，不产生任何写盘）
  const debugEventsFile = "/tmp/opencode/goal-events.log"
  const debugLog = (msg: string) => {
    try {
      if (loadConfig().debugEvents !== true) return
      appendFileSync(debugEventsFile, `${new Date().toISOString()} ${msg}\n`)
      const sz = readFileSync(debugEventsFile, "utf8").length
      if (sz > 512 * 1024) writeFileSync(debugEventsFile, "")
    } catch {}
  }

  const busySet = new Set<string>()
  const interrupted = new Set<string>()
  // V2 官方判据（与 CLI 自身实现一致）：session.inbox.delivered 带 inboxID，CLI 用 "inboxID===自己插入的项"
  //   判定"这次 execution.interrupted 是我自己插入消息造成的，不是用户中止"。
  //   ⚠ 统一判定设计（2026-10-17，替换此前所有零散补丁）：
  //     ourInboxIds  = id → 会话（本插件 synthetic 插入的 inbox 项；带会话号才能判断"本会话是否还有未送达的自插消息"）
  //     selfDelivered= 我们自己的插入已送达、用来解释某次中断
  //     interrupted  = 收到 reason:"user" 的中断、等待判定（唯一判定函数 judgeUserStop 消费）
  //   三种中断都不会误伤用户 ESC：用户 ESC 没有对应的插入 id，也不会命中"最后一条是用户消息"。
  const ourInboxIds = new Map<string, string>()
  const selfDelivered = new Set<string>()
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
  // V2 迁移说明（与 V1 逐句对应，机制等价）：
  //   V1：统一推送里带 body.tools = { question: true } ——「子代理：不带 question 工具 / 未缓存：主动确认
  //       （子代理不预缓存场景，如 fork 到子代理会话）/ 非子代理：保持 question 可用」
  //   V2：PromptInput 没有 tools 字段 → 改为对子代理会话一次性 deny question（maybePushSubagentGoalGuide 里 ctx.session.update permissions）
  // V1：推送消息用 parts.synthetic=true 标记（无 completed 是正常状态，不是生成中），避免 idle 驱动被推送消息卡死
  // V2：推送用 metadata.goalPush 标记（autoContinue 按 m.type==="assistant" 找真实回合，等价）
  // V2：V1 每次推送都用 body.agent="z-goal" 指定执行代理 → V2 PromptInput 无 agent 字段，改为推送前确保会话跑在 z-goal 上（按会话缓存判定）
  const agentEnsured = new Set<string>()
  const ensureGoalAgent = async (sid: string) => {
    if (agentEnsured.has(sid)) return
    try {
      // V1：每条推送带 body.agent="z-goal"（等效于那些回合跑在 z-goal 下）；V2 只能切会话 agent。
      // 实测确认：**不切就"没有 goal 工具"**——子代理（explore/general…）的工具面里没有 goal，
      // 只有切到 z-goal 才能设目标/推进；这正是 V1 子代理能设目标的原因 → **主/子会话都切**（用户确认切换正常）。
      // 注：若在 z-goal 定义被改写的瞬间（配置重载窗口）触发，日志可能出现一次
      //     "Failed to drain Session: AgentNotFoundError: z-goal"（瞬时，重载完成后自愈）。
      const info = await ctx.session.get({ sessionID: sid })
      if (info?.agent !== "z-goal") await ctx.session.switchAgent({ sessionID: sid, agent: "z-goal" })
      agentEnsured.add(sid)
    } catch (e) { console.error("[goal] switchAgent failed:", e) }
  }

  // ── 唯一投递口（模型通道）★【用户通道与模型通道不得混杂】─────────────────────────
  //   DSH：「pushTo 是唯一投递口，调用点与闸门都不许再各判一次」。本插件的对应物就是 **pushPrompt**：
  //   set/flow/audit/引导/看门狗通知/二次审计 全部只经它，通道判据**只在这一个函数里判一次**。
  //   ⚠ 本函数只走**模型通道**（synthetic / 上下文注入），**绝不调用 notify()**；
  //     "给人看"的通知一律由 notify()（用户通道）负责 —— 若将来需要"双通道通知"，
  //     请在调用点**分别调两次**（模型侧 pushPrompt(sid, …, {noReply:true}) + 用户侧 notify(…)），
  //     禁止把两者合成一个函数（用户纪律：用户和模型不能混杂）。
  //   通道分工（用户定的纪律：以「会话在不在跑」为唯一判据）：
  //     运行中 ⇒ 上下文注入（拼进该会话下一次请求的 system；不占排队位、不新开回合）＝ V1 的"忙时排队附加到当前回合末"
  //     空闲/完全结束 ⇒ 唤醒注入（synthetic queue+resume:true，叫醒的唯一手段）
  //     通知类（noReply）⇒ 绝不唤醒，一律上下文注入
  // ⚠ 2026-10-16 移除「上下文注入（event.system.push）」：
  //   它把推送文本塞进**系统上下文** ⇒ 等于改前缀 ⇒ **prompt 缓存整段失效**（实测命中率从 98~99% 掉到 91~94%）。
  //   现在全部改为"**只追加、不动前缀**"的投递（与 V1 的 session.prompt(parts:[{synthetic}]) 语义一致）：
  //     运行中 ⇒ delivery:"steer"（即时追加进当前回合；用户在 2026-10-17 明确要求"回合结束投递太晚"）
  //     通知类 ⇒ delivery:"queue"（不 resume：会话下次自己跑时送达，绝不唤醒）
  //     空闲   ⇒ delivery:"queue" + resume:true（唤醒推进的唯一手段）
  //   ⚠ steer 会打断在跑的一步（服务端因此记 reason:"user" 的打断事件）⇒ 假暂停的源头在判据侧处理，
  //     不改投递方式（用户要求即时投递）。

  // 记住本插件插入的 inbox 项 id（供 session.inbox.delivered 精确匹配；拿不到 id 只记日志，不影响推送本身）
  const rememberPushId = (sid: string, res: unknown) => {
    try {
      const id = (res as { id?: string } | undefined)?.id ?? (res as { data?: { id?: string } } | undefined)?.data?.id
      if (id) {
        ourInboxIds.set(String(id), sid)
        // 封顶：正常靠"送达即删"回收；若某条送达永不到（进程重启/会话删除/投递丢失）也不能无限增长
        if (ourInboxIds.size > 200) {
          const oldest = ourInboxIds.keys().next()
          if (!oldest.done) ourInboxIds.delete(oldest.value)
        }
      }
      debugLog(`插入消息 id=${id ? String(id) : `未返回（${JSON.stringify(res).slice(0, 120)}）`}`)
    } catch {}
  }

  const pushPrompt = async (sid: string, text: string, opts?: { noReply?: boolean; noThrottle?: boolean }) => {
    if (!text) return
    // A1（照 DSH pushTo）：推送刷新限频时间；noThrottle（安静提醒）不占用限频，避免压制 idle/msg 驱动
    if (!opts?.noThrottle) lastPushTime.set(sid, Date.now())
    try { if (!isSubagentCache.has(sid)) await isSubagent(sid) } catch {}
    await ensureGoalAgent(sid)
    try {
      // V1 对照：V1 的推送是 client.session.prompt({ agent:"z-goal", parts:[{type:"text",text,synthetic:true}] })
      //   —— 忙时 opencode 把它"排队附加到当前回合末"（不新开回合）＝本实现「运行中 ⇒ steer」；
      //      空闲时它同样会起新回合 ⇒ 本实现「空闲 ⇒ queue + resume」。
      // 三者都只**追加到末尾**，绝不改前缀（prompt 缓存友好；改前缀会把整段缓存废掉）
      if (opts?.noReply) {
        // 通知类：绝不唤醒 ⇒ 入队但不 resume，会话下次自己跑时送达
        rememberPushId(sid, await ctx.session.synthetic({ sessionID: sid, text, delivery: "queue" }))
        return
      }
      // ⚠ 未知状态不能默认 busy（插件重启后 sessionStatus 为空！）：
      //   当 busy 会走 steer（不 resume）⇒ 空闲会话收到消息也不起回合 ⇒ 表现为
      //   "tell/唤醒显示已投递，但没人执行"（2026-10-20 20:46 重启后实测踩坑）。
      //   未知 ⇒ 按空闲处理（queue+resume 唤醒）；若服务端真忙会拒绝 → 挂 pendingRetryPush 重试，不丢。
      const st = sessionStatus.get(sid)
      const running = st === "busy" || st === "retry"
      if (running) {
        // 运行中 ⇒ steer：**即时追加进当前回合**（用户明确要求：回合结束投递太晚，必须即时）
        //   ⚠ 代价：steer 会打断在跑的这一步（服务端记 execution.interrupted{reason:"user"}）⇒
        //     插件**绝不能**把这个"自己造成的打断"当成用户 ESC ⇒ 假暂停。该误判在 autoContinue 的
        //     "统一判据"里处理（见注释：其后有 synthetic/相邻 synthetic ⇒ 不暂停）。
        rememberPushId(sid, await ctx.session.synthetic({ sessionID: sid, text, delivery: "steer" }))
        return
      }
      // 空闲/完全结束 ⇒ 唤醒注入（推进继续的唯一手段）
      rememberPushId(sid, await ctx.session.synthetic({ sessionID: sid, text, delivery: "queue", resume: true }))
    } catch (e) {
      // opencode 对生成中（busy）会话的 prompt 直接拒绝（Session is busy，不排队不中断）
      // → 挂起重试（事件驱动：下个消息完成/idle 事件到达时送达），不丢弃不轮询
      const arr = pendingRetryPush.get(sid) ?? []
      arr.push(text)
      pendingRetryPush.set(sid, arr)
      console.error(`[goal] pushPrompt busy 拒绝，已挂起等待重试 (${sid})`)
    }
  }

  // 目标文件里没有该会话 = 目标已完成 ⇒ 清掉它排队中的所有推送（【二次审计】/【交流消息】除外）
  const cancelQueuedPushes = async (sid: string) => {
    let url = ""
    let password = ""
    try {
      const svc = JSON.parse(readFileSync(join(home, ".local/state/opencode/service.json"), "utf8"))
      url = String(svc?.url ?? "")
      password = String(svc?.password ?? "")
    } catch {}
    if (!url) return
    const headers = password ? { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") } : {}
    let n = 0
    try {
      const res = await fetch(`${url}/api/session/${sid}/inbox`, { headers })
      const items = ((await res.json()) as { data?: { id?: string; type?: string; payload?: { text?: string } }[] })?.data ?? []
      for (const it of items) {
        if (!it?.id || it.type !== "synthetic") continue
        const text = String(it?.payload?.text ?? "")
        if (text.includes("【二次审计】") || text.includes("【交流消息】")) continue
        try { await fetch(`${url}/api/session/${sid}/inbox/${it.id}`, { method: "DELETE", headers }) } catch {}
        ourInboxIds.delete(it.id)
        n++
      }
    } catch {}
    if (n > 0) debugLog(`已清理排队推送 ${n} 条（会话 …${sid.slice(-8)}，目标已完成）`)
  }

  onGoalRemoved = (sid: string) => { cancelQueuedPushes(sid) }

  // 立即推送第一轮（goal set / 消息设目标 / iterate 通用）：设目标后第一时间让 AI 收到推进提示（不等 idle）
  const pushFirstRound = (sid: string) => {
    debugLog(`pushFirstRound sid=${sid.slice(-8)}`)
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
    // ESC 中断的暂停统一由 judgeUserStop 负责（含 iterating 文案）；这里只做"重推循环"，不重复判暂停。
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


  // 用户中断的判定（**事件驱动、立即执行、不排任何定时器**）
  //   为什么需要它：暂停判定原本只由 session.idle 驱动，而实测按 ESC 之后服务端**不发 session.idle**
  //   （2026-10-17 16:55:28 实证：interrupted → 直接下一条消息）⇒ 标记永远等不到判定，表现就是"按 ESC 没反应"。
  //   这里在收到"用户中断"事件时直接读消息流判定：被打断的 assistant 之后若仍有 user/synthetic 消息
  //   （用户已接着说 / 插件刚推过）⇒ 不暂停；否则暂停 + 通知。
  //   判据与 autoContinue 里的一致；若此处已暂停，后续 autoContinue 会在状态守卫处直接返回 ⇒ 不会重复暂停。
  // 本会话是否还有"未送达的自插消息"（决定能否立即判定：有则等它的送达事件，避免先后竞态）
  const hasOutstandingInsert = (sid: string) => { for (const v of ourInboxIds.values()) if (v === sid) return true; return false }
  // 判定并发护栏：同一会话同时只让一次判定在跑（见 judgeUserStop 头注释）
  const judgeInFlight = new Set<string>()

  // ── 唯一判定：用户中断 ⇒ 是否暂停（**整个插件只有这里能因"用户中断"而暂停**）──
  //   ① 本插件自己插入的消息已送达 ⇒ 这次中断是自己造成的，不是用户停 ⇒ 不暂停
  //   ② 消息流最后一条有效消息是 user ⇒ 用户插话顶轮 ⇒ 不暂停
  //   ③ 其余 ⇒ 暂停 + 通知（active / iterating 两种文案）
  //   用户按 ESC 没有对应的插入 id，也不会命中② ⇒ **该暂停一定暂停**。
  const judgeUserStop = async (sessionID: string) => {
    // 幂等 + 并发护栏：本函数有 3 个调用点（自插送达 / 中断事件 / 新回合兜底）。
    //   判定改成"取消息成功后才消费标记"之后，两次调用可能都通过 has 检查 ⇒ 重复暂停 + 重复通知，
    //   故用 in-flight 集合保证同一会话同时只判一次。
    if (!interrupted.has(sessionID)) return
    if (judgeInFlight.has(sessionID)) { debugLog(`用户中断判定：已有一次在跑，跳过重复调用`); return }
    judgeInFlight.add(sessionID)
    try {
      // ⚠ 先取消息、后消费标记：原实现先 `interrupted.delete` 再 `await ctx.session.context()`，
      //   一旦取消息抛错（会话忙/已删/DB 抖动），唯一出口是门控日志（debugEvents 默认关）
      //   ⇒ 用户的 ESC 被完全静默忽略且无法重试。现在取消息失败 ⇒ 保留标记（下个事件再次判定）。
      const goals = loadGoals()
      const entry = goals[sessionID]
      if (!entry) { interrupted.delete(sessionID); return }
      if (entry.state !== "active" && entry.state !== "iterating") {
        interrupted.delete(sessionID)
        debugLog(`用户中断判定：state=${entry.state} ⇒ 不处理`)
        return
      }
      let msgs: unknown
      try {
        msgs = await ctx.session.context({ sessionID })
      } catch (e) {
        console.error(`[goal] 用户中断判定：读取消息失败，保留待判定标记（下个事件重试）：${String(e)}`)
        return
      }
      interrupted.delete(sessionID)                      // 拿到消息、结论可定 ⇒ 此刻才消费标记
      if (selfDelivered.delete(sessionID)) { debugLog(`用户中断判定：本插件插入的消息造成 ⇒ 不暂停`); return }
      const list = (msgs ?? []) as { type?: string }[]
      const lastMsg = [...list].reverse().find((m) => m?.type === "user" || m?.type === "assistant")
      if (lastMsg?.type === "user") { debugLog(`用户中断判定：最后一条是用户消息 ⇒ 判为插话，不暂停`); return }
      const wasIterating = entry.state === "iterating"
      entry.state = "paused"
      entry.updatedAt = Date.now()
      saveGoals(goals)
      notify("warning", wasIterating
        ? "迭代已被 ESC 中断，目标暂停，/goal-resume 或 goal 工具 resume 恢复"
        : "生成被中断（ESC），目标已暂停，/goal-resume 或 goal 工具 resume 恢复")
      debugLog(`用户中断判定：确认为用户主动停 ⇒ 已暂停${wasIterating ? "（迭代）" : ""}`)
    } catch (e) {
      console.error(`[goal] 用户中断判定失败（已暂停未生效）：${String(e)}`)
    } finally {
      judgeInFlight.delete(sessionID)
    }
  }

  const autoContinue = async (sessionID: string, via: "idle" | "msg" = "idle") => {
    debugLog(`autoContinue enter sid=${sessionID.slice(-8)} via=${via}`)
    // M1 修复：检查后立即占用互斥（原检查与 add 之间隔多个 await，idle/msg 双定时器并发时 TOCTOU 双推进）
    // V2 补：busySet 在 V1 只写不读（潜在 TOCTOU：idle/msg 双驱动可并发双推）；V2 的 delivery=queue 会把两条都收下
    //        → 这里补上读取，做成「状态化互斥」（DSH 版教训：防重复靠状态、不靠时间节流）
    if (busySet.has(sessionID)) { debugLog(`autoContinue 跳过（busy 互斥中）`); return }
    busySet.add(sessionID)
    setTimeout(() => busySet.delete(sessionID), 120000)
    // ⚠ 以下两处"早退"原先在 try/finally 之外，
    //   不会释放 busySet ⇒ 最长 120s 静默（目标 paused 时 idle 上锁 → 用户 resume 后推进被互斥挡掉，
    //   若期间无新事件就彻底停推）。现在每个早退都显式释放互斥。
    const goals = loadGoals()
    const entry = goals[sessionID]
    if (!entry) {
        // 子代理无目标 + 父代理有目标 → 推送一次完整设目标指导（兜底主 AI 未在 task prompt 写引导）
        // ⚠ 释放必须放在推送**之后**（且在 finally）：放在之前会让这次引导推送跑在锁外，可能与另一次推进并发双推
        try { await maybePushSubagentGoalGuide(sessionID) } finally { busySet.delete(sessionID) }
        return
      }
      // 预缓存子代理身份：fork 到子代理会话的目标首次推送前必须确认，避免误判迭代状态/权限
      if (!isSubagentCache.has(sessionID)) {
        try { await isSubagent(sessionID) } catch {}
      }
      // ESC 中断即时信号（事件标记）——**延迟判定**：真正是否算"用户主动停"要看其后有没有新的用户输入，
      //   详见下方 msgs 取回后的统一判据（V2 把"用户插话顶掉当前轮"也标成 reason:"user"，不能一收到就暂停）
      // 用户中断的暂停**不在这里判**（统一由 judgeUserStop 负责，见其上注释）：
      //   这里的职责只是"推进"，暂停后状态守卫会让它自然不再推进。
      // 状态守卫：非 active（paused/limited/iterating/done）不推进——修复调试日志删除时误删的 state 检查（曾导致 paused 目标被 idle/msg 驱动持续推送）
      if (entry.state !== "active") { busySet.delete(sessionID); debugLog(`autoContinue 跳过（state=${entry.state}）`); return }
      // 推进时机（权威信号驱动，全部直接推送——opencode prompt 在 busy 时排队，回合完成后自动附加，不打断生成）：
      // via=idle：session.idle 事件 = AI 回合自然完成的权威信号 → 每回合都推（不限频，goal 推进节奏）
      // via=msg：assistant 消息完成驱动 → 限频提醒（AI 连续干活 1 小时也能每 5 分钟插话，不依赖 idle status）
      // 两种驱动不再查 status/挂起——idle 事件/消息完成本身就是回合结束信号，直接推由 opencode 排队附加
      // 去重：lastPushedMsg 按最后消息 id——同一回合两种驱动都触发也只推一次
      // 限频仅用于 msg 驱动（AI 干活中提醒，避免频繁）；idle 驱动（回合结束推进）不限频，每回合都推
      try {
      const msgs = await ctx.session.context({ sessionID: sessionID })  // V2：client.session.messages → ctx.session.context（扁平消息数组）
      // 长思考/生成中保护：最后 assistant 消息未 completed（仍在生成）→ 本轮未真正结束，不推进不暂停，等消息完成后的 session.idle 再处理（避免思考几分钟被误判中断）
      // 跳过插件自身推送的 synthetic 消息（无 completed 是正常状态，不是生成中），避免 idle 驱动被推送消息卡死
      // V2：等价判据 = 消息 type 不是 assistant（插件推送是 user + metadata.goalPush，且不看 parts.synthetic）
      const lastAsst = [...msgs].reverse().find((m: any) => m?.type === "assistant") as { id?: string, error?: unknown, time?: { completed?: number } } | undefined
      if (lastAsst && lastAsst.time?.completed === undefined) {
        return
      }
      // ── 统一判据：只有"用户主动停"才暂停（暂停的唯一来源）──
      //   打断事件 reason 枚举（依运行时 schema）：user / shutdown / superseded / inactivity
      //     · user       = 用户主动停（ESC / 停止）⇒ 订阅侧只收这一种，才可能走到这里
      //     · superseded = 用户插话或**插件 steer 插入消息**顶掉当前轮 ⇒ 不设标记 ⇒ 不暂停
      //     · shutdown   = 服务重启；inactivity = 闲置 ⇒ 都不设标记 ⇒ 不暂停
      //   这里再加一道保险：若被打断的 assistant 之后仍有 user/synthetic 消息（用户已接着说 / 插件刚推过），
      //   说明会话在继续推进，不暂停（避免"插话即暂停、下条消息又恢复"的抖动）。
      // （原"其后仍有 user/synthetic 则不暂停"的保险已删除：暂停判定统一收口到 judgeUserStop，
      //   避免同一条规则在两处漂移；autoContinue 现在只负责"推进"。）
      if (lastAsst?.error) {
        // 证据（运行时 schema）：
        //   session.execution.interrupted 的 reason 枚举 = ["user","shutdown","superseded","inactivity"]
        //   —— **只有 "user" = 用户主动停**（按 ESC / 点停止）；用户插话、以及插件 steer 插入消息造成的中断
        //      都是 "superseded"（另有 "shutdown"（服务重启）、"inactivity"（闲置））。
        //   而"被中止的 assistant 消息（error.type='aborted'）"在以上所有情况下都会出现 ——
        //      插件自己插入消息也会打断当前步并留下它 ⇒ **绝不能靠它判暂停**
        //      （这正是"自动接续为什么会变成暂停"的根源：插件把自己造成的打断当成了用户 ESC）。
        //   结论：这里一律不暂停（只跳过本轮推进）；暂停判定统一在 judgeUserStop 里做。
        const err = lastAsst.error as { name?: string; type?: string; message?: string } | undefined
        const aborted = err?.name === "MessageAbortedError" || err?.type === "aborted"
        debugLog(`autoContinue 跳过（本轮 assistant 有${aborted ? "中止" : "非中止"}错误，不暂停；暂停只认 execution.interrupted{reason:"user"}）：${JSON.stringify(lastAsst.error).slice(0, 120)}`)
        return
      }
      // 每回合只推进一次：idle 与消息完成双驱动，按最后 assistant 消息 id 去重（避免重复推送）
      // H2：lastAsst undefined = 尚无任何真实 AI 完成消息（只有插件 synthetic 推送）→ 不推进（防 turns 注水/重复推送）
      const lastMsgId = lastAsst?.id
      if (lastPushedMsg.get(sessionID) === lastMsgId) { debugLog(`autoContinue 跳过（同回合已推 msgId=${String(lastMsgId).slice(-8)}）`); return }
      const turns = entry.turns + (via === "idle" ? 1 : 0)
      entry.turns = turns
      entry.updatedAt = Date.now()
      // 迭代模式不设内部推进轮次上限（仅受 iterateMaxRounds 迭代轮数限制）；正常目标模式保持 maxTurns 限制；子代理永远正常模式（不受 config iterateMode 影响）
      const isIterGoal = (configIterateMode() && isSubagentCache.get(sessionID) !== true) || !!entry.iteration
      if (!isIterGoal && entry.maxTurns > 0 && turns > entry.maxTurns) {
        entry.state = "limited"
        saveGoals(goals)
        notify("warning", `已达轮数上限 ${entry.maxTurns}，目标停止推进（终态；如需继续请用 /goal 重新设置目标）`)
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
    debugLog(`subGuide 检查 sid=${sid.slice(-8)} inFlight=${subGuideInFlight.has(sid)} guided=${loadSubGuideGuided().has(sid)}`)
    if (subGuideInFlight.has(sid)) return
    if (loadSubGuideGuided().has(sid)) return
    try {
      subGuideInFlight.add(sid)
      if (!(await isSubagent(sid))) return
      const pbody = await ctx.session.get({ sessionID: sid }) as { parentID?: string }
      const parentID = pbody?.parentID
      if (!parentID) return
      const p = loadGoals()[parentID]
      // 仅父代理有目标（active/iterating/limited/paused，排除 done/cleared）时才要求子代理设子目标
      if (!p || p.state === "done" || p.state === "cleared") return
      const guided = loadSubGuideGuided()
      guided.add(sid)
      saveSubGuideGuided(guided)
      // V2：V1 给子代理推送时不带 body.tools={question:true}（子代理不能问用户）
      //     V2 用会话级权限规则表达同一语义：question 工具在该子代理会话上 deny
      try {
        await ctx.session.update({ sessionID: sid, permissions: [{ action: "question", resource: "*", effect: "deny" }] })
      } catch (e) { console.error("[goal] deny question for subagent failed:", e) }
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

  // 卡住检测已移除（2026-10-16，用户决策）：V2 官方自带超时——provider settings.headerTimeout / chunkTimeout
  //   （HTTP 各 5 分钟、WebSocket 帧间隔 30 分钟，可设 false 关闭），超时请求报 transport 错误并最多重试 3 次；
  //   另有官方 session.execution.interrupted.reason="inactivity"。插件再"猜卡住"只会误报（长任务在无 part 事件
  //   窗口内被误判卡住）。详见 docs/V2-API-对照.md《官方超时能力与卡住检测移除》。
  // 消息完成驱动推送的限频间隔（ms）：AI 自主连续干活时每 N 分钟提醒一次（阶段/代办更新），默认 5 分钟
  // H1 修复：优先读 config.json（TUI /goal-config 写入源），回退插件 options（opencode.jsonc）
  const pushIntervalMs = () => {
    try {
      const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.pushIntervalMs)
      if (Number.isInteger(n) && n >= 30000) return n
    } catch {}
    return Math.max(30000, Number(options.pushIntervalMs ?? 300000) || 300000)
  }
  const DEFAULT_CLEANUP_DAYS = parseFloat(String(options.cleanupDays ?? "3"))
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
  const isSubagentCache = new Map<string, boolean>()
  // V2 新增（替代 V1 的 client.session.status()/list()/children() 三个接口）：
  //   sessionStatus   ← session.status 事件维护的在线状态（idle/busy/retry）
  //   sessionRegistry ← session.created/deleted/renamed 事件维护的会话表（落盘，重启后仍能清理子代理）
  const sessionStatus = new Map<string, string>()
  const sessionRegistry = new Map<string, { id: string; parentID?: string; title?: string; time?: { updated: number } }>()
  const subRegFile = join(stateDir, "subagents.json")
  try {
    const raw = JSON.parse(readFileSync(subRegFile, "utf8"))
    for (const r of (raw ?? [])) if (r?.id) sessionRegistry.set(r.id, r)
  } catch {}
  const saveSessionRegistry = () => { try { writeFileSync(subRegFile, JSON.stringify([...sessionRegistry.values()])) } catch {} }

  const isSubagent = async (sid: string): Promise<boolean> => {
    if (isSubagentCache.has(sid)) return isSubagentCache.get(sid)!
    try {
      const info = await ctx.session.get({ sessionID: sid }) as { parentID?: string }
      const v = !!info?.parentID
      isSubagentCache.set(sid, v)
      return v
    } catch {
      return false
    }
  }

  // ── 目标会话自动批准：**纯内存方案**（与旧版"内存 auto"同层；零持久化、零配置）──
  // 旧版（V1 1.18.32）本质是内存 auto：permission.mode=auto 时在事件处理内部立即 reply once。
  // V2（2.0.30 实测）：permission.mode 命令已移除、Permission 存储只有 getter（无 set/toggle）、
  //   运行时也没有 permission.ask 等插件钩子（二进制 0 处）、插件 API 无 local/state/kv/tuiConfig
  //   ⇒ 插件**没有**可写的"auto 内存点"；原生 auto 只能靠启动参数 --auto 或配置文件 session.permissions。
  // 因此这里不做任何写入，只在 TUI 侧做纯内存拦截（见 src/tui-plugin.tsx 的"内存点"）：
  //   ① 权限请求事件到达 ⇒ 立即应答 once（实测 ~100ms）
  //   ② 数据层 session.permission.list 内存过滤目标家族请求 ⇒ 弹窗读不到它 ⇒ 不渲染
  // 备份：曾实现过的"服务端会话字段放行"方案见 bak/20261017-规则方案-已验证/（同样有效，但写会话字段）。

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
      // V2：没有 client.session.list / client.session.children 接口（V1 是两者配合枚举全部会话）→ 用 session.created/deleted 事件维护的会话表
      const regRows = [...sessionRegistry.values()] as { id: string; parentID?: string; time?: { updated: number }; title?: string }[]
      // 刷新时间/标题（V1 的 list() 返回里带 time.updated，「保留上限」按它排最旧）
      await Promise.all(regRows.map(async r => {
        try {
          const info = await ctx.session.get({ sessionID: r.id })
          if (info) { r.title = info.title ?? r.title; r.time = { updated: info.time?.updated ?? r.time?.updated ?? 0 } }
        } catch { sessionRegistry.delete(r.id) }  // 会话已不存在 → 从注册表剔除
      }))
      saveSessionRegistry()
      const allSubs: { id: string; parentID?: string; time?: { updated: number }; title?: string }[] = regRows
      // 主会话保护：仅处理 parentID 非空的子代理，杜绝误删主会话
      const subOnly = allSubs.filter(s => !!s?.parentID)
      // V2：无 session.status 接口 → 事件维护的在线状态表
      const statusMap: Record<string, { type: string }> = {}
      for (const [k, v] of sessionStatus) statusMap[k] = { type: v }
      // 精确状态判断：busy/retry 跳过；idle 再查最后消息区分 已完成/已失败/未完成（中断）
      const doneStatus = new Set<string>()
      const idleSubs = subOnly.filter(s => statusMap[s.id]?.type === "idle")
      await Promise.all(idleSubs.map(async (s) => {
        try {
          // V2：ctx.session.context 返回扁平消息（type 区分角色；错误/完成时间在消息自身字段上）
          const msgs = await ctx.session.context({ sessionID: s.id })
          const lastAsst = [...msgs].reverse().find((m: any) => m?.type === "assistant") as { error?: unknown, time?: { completed?: number } } | undefined
          if (!lastAsst) return
          if (lastAsst.error) doneStatus.add(s.id)
          else if (lastAsst.time?.completed !== undefined) doneStatus.add(s.id)
        } catch {}
      }))
      let removed = 0
      let failed = 0
      const failedIds: string[] = []
      const delOne = async (s: { id: string; parentID?: string }) => {
        if (!s?.parentID) return  // 主会话不删（双保险）
        try {
          await ctx.session.remove({ sessionID: s.id })  // V2：client.session.delete → ctx.session.remove
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
        notify(failed > 0 ? "warning" : "info", `${manual ? "手动清理" : "自动清理"}子代理会话：成功 ${removed} 个${failed ? `，失败 ${failed} 个${failedIds.length ? `（如 ${failedIds.map(id => id.slice(-8)).join(",")}…）` : ""}` : ""}${!manual && maxRetain > 0 ? `（保留上限 ${maxRetain} 个）` : ""}`)
      }
      return { removed, failed }
    } catch (e) {
      console.error("[goal] cleanup subagents failed:", e)
      return { removed: 0, failed: 0 }
    }
  }

  setInterval(() => { cleanupSubagents().catch(() => {}) }, 3600000)
  setTimeout(() => { cleanupSubagents().catch(() => {}) }, 60000)

  // ── 真正的「每 N 分钟检查一次」定时器 ──
  //   此前只有"事件驱动 + 限频"（assistant 消息完成时才判断），会话静默/卡住时**永远不会有提醒**
  //   ⇒ 推送文案里"每 10 分钟检查推送一次"名不副实。这里补定时扫描：
  //   只扫 active/iterating 的目标；距上次推送 ≥ pushIntervalMs；会话必须空闲（忙则跳过，绝不打断生成）；
  //   有挂起重试的推送也跳过（避免重复）。
  // ── 10 分钟提醒（**推送**，走统一投递口 pushPrompt：只追加到会话末尾、不改前缀）──
  //   每个 active/iterating 目标每 pushIntervalMs 追加一次标准推送（文案与其它推送完全一致，不另造格式）。
  //   独立计时（不能挂在 lastPushTime 上：其它推送会刷新它 ⇒ 永远不触发）。
  const lastRemindTime = new Map<string, number>()
  const pushTimer = setInterval(() => {
    try {
      const gg = loadGoals()
      const now = Date.now()
      for (const [psid, e] of Object.entries(gg)) {
        if (!e || (e.state !== "active" && e.state !== "iterating")) continue
        const last = lastRemindTime.get(psid)
        if (last === undefined) { lastRemindTime.set(psid, now); continue }
        if (now - last < pushIntervalMs()) continue
        lastRemindTime.set(psid, now)
        pushPrompt(psid, buildPrompt(e, e.turns, psid), { noReply: true, noThrottle: true }).catch(() => {})
      }
      for (const k of [...lastRemindTime.keys()]) if (!gg[k]) lastRemindTime.delete(k)
    } catch (err) { console.error("[goal] remind timer error:", err) }
  }, 60_000)
  debugLog(`定时提醒器已启动：检查间隔 60s，阈值 ${Math.round(pushIntervalMs() / 60000)} 分钟（仅走 notify 用户通道，零模型上下文写入）`)

  // ── V2：事件订阅（V1 的 hooks.event → ctx.event.subscribe；事件对象形状在下方 onEvent 内按 V2 读取）──
  const controller = new AbortController()
  const onEvent = async (event: any) => {
      debugLog(`事件 ${String(event?.type)} sid=${String((event?.data as { sessionID?: string } | undefined)?.sessionID ?? "").slice(-8)}`)
      // V2：V1 的 session.idle（回合自然结束）在 V2 有三个来源——
      //     ① session.idle（ephemeral，实测极少发）② session.status{status.type==="idle"}（权威空闲信号）
      //     ③ session.execution.succeeded（回合正常跑完）
      //     → 三者归一到同一「回合结束」处理；去重仍按最后 assistant 消息 id + busySet 互斥，重复触发无副作用
      const idleByStatus = event.type === "session.status" && ((event.data as { status?: { type?: string } } | undefined)?.status?.type === "idle")
      if (event.type === "session.idle" || idleByStatus || event.type === "session.execution.succeeded") {
        const sid = (event.data as { sessionID?: string } | undefined)?.sessionID   // V2：事件负载在 event.data
        if (sid) {
          // 目标已被清除（/goal-stop、goal clear、audit 清理）⇒ 丢弃全部挂起推送，与 goal clear 的清理逻辑一致
          if (!loadGoals()[sid]) {
            pendingRetryPush.delete(sid)
            pendingPushQueue.delete(sid)
            pendingMsgDrive.delete(sid)
            busySet.delete(sid)
            // 二次审计 = 完成确认本身，必须照发（它只会在 audit/finish 之后存在）
            const sec = pendingSecondaryPush.get(sid)
            if (sec) {
              pendingSecondaryPush.delete(sid)
              pushPrompt(sid, sec).catch(() => {})
            }
          } else {
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
      }
      // V2 官方判据：inbox（合成注入/用户消息）送达事件 —— 紧随其后的打断属于"插入消息造成的"，不是用户 ESC
      if (event.type === "session.inbox.delivered") {
        const d = event.data as { sessionID?: string; inboxID?: string } | undefined
        if (d?.sessionID && d?.inboxID && ourInboxIds.has(String(d.inboxID))) {
          ourInboxIds.delete(String(d.inboxID))
          selfDelivered.add(d.sessionID)
          // ⚠ 竞态：打断事件可能**先于**送达事件到达（实测 16:52:17：打断 .412 → 送达 .449）。
          //   两种顺序都由统一判定收口：先送达 ⇒ selfDelivered 已置，后到的打断直接不暂停；
          //   先打断 ⇒ 当时挂起等待，这里送达后立即触发同一个判定 ⇒ 结论一致。
          if (interrupted.has(d.sessionID)) void judgeUserStop(d.sessionID)
          // 目标已被清理（audit/clear/goal-stop）⇒ 撤销该会话其余排队中的自投推送，避免“完成后还继续送达”
          if (!loadGoals()[d.sessionID]) cancelQueuedPushes(d.sessionID)
          debugLog(`inbox 送达（本插件插入）inboxID=${String(d.inboxID)} ⇒ 这次插入造成的打断不算用户 ESC`)
        }
      }
      // 回合正常结束/失败 ⇒ 清掉"自插送达"残留标记（避免它一直挂着影响下一次真实 ESC 的判定）
      if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") {
        const d = event.data as { sessionID?: string } | undefined
        if (d?.sessionID) selfDelivered.delete(d.sessionID)
      }
      // ⚠ 残留标记作废（实测 17:07:08 送达 → 17:07:18 用户 ESC 被吞）：
      //   本插件的插入若其后又开始了新步骤，说明它**没有造成打断**（打断会直接结束当前步骤），
      //   此时必须立刻作废标记，否则它会一直挂着，把下一次真正属于用户的 ESC 误判成"自己造成的"。
      if (event.type === "session.step.started" || event.type === "session.reasoning.started" || event.type === "session.text.started") {
        const d = event.data as { sessionID?: string } | undefined
        if (d?.sessionID && selfDelivered.delete(d.sessionID)) {
          debugLog(`自插送达标记已作废（其后开始了新步骤 ⇒ 这次插入没有造成打断）`)
        }
      }
      // V2：V1 的 session.error + error.name==="MessageAbortedError"（ESC 中断）→ V2 是 session.execution.interrupted{reason}
      if (event.type === "session.execution.interrupted" || event.type === "session.error") {
        const props = (event.data as { sessionID?: string; reason?: string; error?: { name?: string } } | undefined)
        const sid = props?.sessionID
        const aborted = event.type === "session.error"
          ? (props?.error as { name?: string } | undefined)?.name === "MessageAbortedError"
          : props?.reason === "user"
        if (sid && aborted) {
          // 诊断：把打断事件的完整 payload 记下来（区分"用户真按 ESC"与"插入消息造成的打断"）
          debugLog(`打断事件 payload：type=${event.type} reason=${String(props?.reason ?? "-")} errorName=${String((props?.error as { name?: string } | undefined)?.name ?? "-")} data=${JSON.stringify(event.data).slice(0, 400)}`)
          // 统一判定（唯一实现见 judgeUserStop）：挂上"待判定"标记后，若本会话**没有未送达的自插消息**就立即判；
          //   否则等那条插入的送达事件再判 —— 这样"中断先到"与"送达先到"两种顺序都不会误判。
          if (selfDelivered.delete(sid)) {
            debugLog(`打断来自本插件插入的消息 ⇒ 不暂停`)
          } else {
            interrupted.add(sid)
            if (!hasOutstandingInsert(sid)) void judgeUserStop(sid)
            else debugLog(`用户中断：本会话有未送达的自插消息 ⇒ 等其送达事件再判（避免先后竞态）`)
          }
        }
      }
      // V2：session.status 事件维护在线状态表（替代 V1 的 client.session.status() 轮询，清理流程用它判 idle）
      if (event.type === "session.status") {
        const d = event.data as { sessionID?: string; status?: { type?: string } } | undefined
        if (d?.sessionID && d?.status?.type) sessionStatus.set(d.sessionID, String(d.status.type))
      }
      // V2：session.created/deleted/renamed 维护会话表（替代 V1 的 client.session.list()/children()，清理子代理用它）
      if (event.type === "session.created") {
        const d = event.data as { sessionID?: string; parentID?: string; title?: string } | undefined
        if (d?.sessionID) {
          sessionRegistry.set(d.sessionID, { id: d.sessionID, parentID: d.parentID, title: d.title, time: { updated: Date.now() } })
          saveSessionRegistry()
        }
      }
      if (event.type === "session.deleted") {
        const d = event.data as { sessionID?: string } | undefined
        if (d?.sessionID) {
          sessionRegistry.delete(d.sessionID); saveSessionRegistry()
          sessionStatus.delete(d.sessionID); isSubagentCache.delete(d.sessionID)
        }
      }
      if (event.type === "session.renamed" || event.type === "session.moved" || event.type === "session.metadata.updated") {
        const d = event.data as { sessionID?: string; title?: string } | undefined
        if (d?.sessionID && sessionRegistry.has(d.sessionID)) {
          const cur = sessionRegistry.get(d.sessionID)!
          sessionRegistry.set(d.sessionID, { ...cur, title: d.title ?? cur.title, time: { updated: Date.now() } })
          saveSessionRegistry()
        }
      }
      if (event.type === "session.execution.succeeded") {
        const d = event.data as { sessionID?: string } | undefined
        if (d?.sessionID) {
          sessionStatus.set(d.sessionID, "idle")   // V2：回合结束 → 状态表归 idle（清理依赖它）
          // 注意：**不在这里**发团队事件——回合 idle 只是边界，会误唤醒等待者；
          //       团队等待只认“目标完成”（由 saveGoals 的目标事件携带状态，wait 侧判定完成）
          if (sessionRegistry.has(d.sessionID)) {
            const cur = sessionRegistry.get(d.sessionID)!
            sessionRegistry.set(d.sessionID, { ...cur, time: { updated: Date.now() } })
            saveSessionRegistry()
          }
        }
      }
      // V2：把 execution.* 也写进状态表——V1 的 client.session.status() 是全量状态，V2 只靠事件，
      //     若某会话从未发过 session.status，状态表会缺条目 → 清理流程会把它当成「非 idle」而跳过
      if (event.type === "session.execution.started") {
        const d = event.data as { sessionID?: string } | undefined
        if (d?.sessionID) {
          sessionStatus.set(d.sessionID, "busy")
          // ⚠ 某条插入的 delivered 永远不到时（进程重启/会话删除/投递丢失），
          //   "等送达再判"会把真实 ESC 的待判定**无限挂起**。这里在新回合开始时把挂起的待判定立刻判掉：
          //   此刻该到的送达事件都到了 ⇒ 归属判定依然准确（不靠时间窗）。
          if (interrupted.has(d.sessionID)) void judgeUserStop(d.sessionID)
        }
      }
      if (event.type === "session.execution.interrupted" || event.type === "session.execution.failed") {
        const d = event.data as { sessionID?: string } | undefined
        if (d?.sessionID) sessionStatus.set(d.sessionID, "idle")
      }
      if (event.type === "session.execution.failed") {
        const d = event.data as { sessionID?: string } | undefined
        if (d?.sessionID) sessionStatus.set(d.sessionID, "idle")   // V1 靠消息 error 字段判失败；状态表先归 idle，后续按消息判定
      }
      // V2：V1 的 message.updated 在 V2 有两个来源——
      //   ① assistant 回合完成 → session.execution.succeeded（等价 V1 的 info.role==="assistant" + time.completed）
      //   ② 用户消息入队    → session.inbox.enqueued{item.type==="user"}（等价 V1 的 info.role==="user"，负载里带原文）
      const assistantDone = event.type === "session.execution.succeeded"
      const userEnq = event.type === "session.inbox.enqueued" && (event.data?.item as { type?: string } | undefined)?.type === "user"
      if (event.type === "message.updated" || assistantDone || userEnq) {
        const d = (event.data ?? {}) as {
          sessionID?: string
          inboxID?: string
          item?: { type?: string; payload?: { text?: string; metadata?: { goalPush?: boolean } } }
        }
        const info = (
          event.type === "message.updated"
            ? (((event.properties as { info?: { sessionID?: string; id?: string; role?: string; agent?: string; error?: unknown; time?: { completed?: number } } } | undefined)?.info) ?? {})
            : assistantDone
              ? { sessionID: d.sessionID, id: `exec-${d.sessionID}-${Date.now()}`, role: "assistant", time: { completed: Date.now() } }
              : { sessionID: d.sessionID, id: d.inboxID, role: "user" }
        ) as { sessionID?: string; id?: string; role?: string; agent?: string; error?: unknown; time?: { completed?: number } }
        if (!info?.sessionID || !info.id) return
        const sid = info.sessionID
        // assistant 消息更新 → 限频驱动推进（不依赖 idle：goal 模式 AI 自主连续干活时 idle 不触发，阶段/代办长期不推送不更新）
        // 只在消息已完成（time.completed）时触发——生成结束窗口 pushPrompt 才能成功（流式中触发会被 opencode Session is busy 拒绝丢失）
        if (info.role === "assistant") {
          // V2：session.execution.succeeded 本身就是「回合完成」信号 → 等价 V1 的 time.completed 已就绪
          const completed = event.type === "message.updated" ? (info.time as { completed?: number } | undefined)?.completed : Date.now()
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
        // ⚠ 立即占位：原实现只在 300ms 回调内 markHandled，
        //   回调执行前的重复 updated（以及 inbox.enqueued 用另一个 id 空间的同一条消息）会双份处理
        //   ⇒ 重复设目标 + 两条"第 1 轮"推送。这里先占位，回调内再标记一次（Set 幂等）。
        markHandled(mid)
        let agent = info.agent
        setTimeout(async () => {
          try {
            markHandled(mid)  // H1 修复：回调开头即标记，同一消息多次 updated 只处理一次（防重复设目标/重复推送第 1 轮）
            // V2：用户消息没有 agent 字段（V1 的 info.agent 有）→ 会话的 agent 即该回合执行者，用它判 z-goal
            if (!agent) { try { agent = (await ctx.session.get({ sessionID: sid }))?.agent } catch {} }
            // V2：client.session.message({messageID}) → ctx.session.context 里按 id 取（用户消息文本直接在 m.text 上）
            const msgsAll = await ctx.session.context({ sessionID: sid })
            const one = (msgsAll as { id?: string; text?: string; type?: string; metadata?: { goalPush?: boolean } }[]).find(m => m?.id === mid)
            // V1：parts.some(p => p.synthetic) 直接返回（插件自己的推送不是用户设目标）
            // ⚠ 落库的插件推送是 `type="synthetic"`，data 里没有 metadata.goalPush
            //   （实测 synthetic 2570 行、data 仅 {time,text}；全库含 goalPush 的 48 行都是 AI 文本的假命中）
            //   ⇒ 原判据不可能命中。现在按**身份判据**认：type==="synthetic"；metadata.goalPush 仅作兼容兜底。
            if (one?.type === "synthetic" || one?.metadata?.goalPush || d.item?.payload?.metadata?.goalPush) return
            let text = String((one as { text?: string } | undefined)?.text ?? "").trim()
            // V2：inbox 事件可能先于消息落库到达 → 用事件负载里的原文兜底（V1 是直接读已落库的消息）
            if (!text) text = String(d.item?.payload?.text ?? "").trim()
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
                notify("warning", `${isGoalIterCmd ? "/goal-iter" : "/goal"} 目标不能为空`)
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
                notify("success", "已收到澄清回答，目标恢复推进")
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
            // ⚠ 缺子代理保护会出问题：config.iterateMode=true 时，
            //   经 task 消息自动建目标的子代理会拿到 maxTurns=0（无上限），与工具 set 分支（M8：子代理永远正常模式）矛盾。
            goals[sid] = { goal: goalText, state: "active", turns: 0, maxTurns: (forceIterate || (configIterateMode() && isSubagentCache.get(sid) !== true)) ? 0 : currentMaxTurns(), updatedAt: ts, startedAt: existing?.startedAt ?? ts, stages: [], planFile: existing?.planFile ?? `${resolvePlanDir()}/${sid}-${ts}.md`, flow: "explore", ...(forceIterate ? { iteration: { count: 0 } } : {}) }
            saveGoals(goals)
            // H3/M2 修复：新目标不受旧 ESC 标记误暂停；推进去重/限频状态重置（防新目标第一轮被旧记录吞掉）
            interrupted.delete(sid)
            lastPushedMsg.delete(sid)
            lastPushTime.delete(sid)
            // 新目标设置：重置 every 模式的询问提醒记录（新迭代目标规划时重新提醒）
            iterAskedForRound.delete(sid)
            notify("success", (isGoalCmd || isGoalIterCmd) ? `目标已设置/更新${forceIterate ? "（临时迭代模式）" : ""}，开始自主推进` : "目标已自动设置，开始自主推进")
            // 立即推送第一轮（z-goal agent，带强制规划指令），确保 z-goal 提示词第一时间到位
            pushFirstRound(sid)
          } catch (e) {
            console.error("[goal] auto set failed:", e)
            // ⚠ P7 配套：回调失败要回滚"已占位"标记，否则这条用户消息永远不再处理（丢"设目标"）
            handled.delete(mid)
          }
        }, 300)
      }
    }
  // ── V2：工具定义（V1 的 `tool: { goal: tool({…}) }` 映射 → V2 的 `ctx.tool.transform`；描述与参数说明**逐字保留**）──
  const goalTool: any = {
      name: "goal",
      description:
          "目标推进管理（ /goal 风格，按会话隔离）：每个会话独立目标，支持阶段与代办。设置后插件每轮自动发送「目标+阶段总览+代办」直到完成、暂停或达轮数上限。" +
          "调用时机：用户要求持续工作直到完成/修到全绿/持续推进时先 set；**流程切换用 flow（explore→plan→execute→audit，探索/规划中发现信息不足可回 explore）**；阶段流转用 stage；阶段整体修改用 update_stages；**当前阶段代办用 todos**；**全部工作完成并审计通过后，最后一步必须调用 audit 结束推进**；暂停、恢复、查看进度、取消分别对应 pause/resume/status/clear；手动清理已完成/已失败子代理会话用 cleanup（不受清理天数限制）。" +
          "迭代模式（config iterateMode 开启）：audit 后不删目标，插件在本轮结束后推送【迭代继续】指令（goal 工具 action=iterate 继续下一轮 / finish 结束收尾）。",
        input: {
          type: "object",
          properties: {
          action: { type: "string", description: "操作：set 设置目标 / flow 切换当前流程（explore/plan/execute/audit，规划中发现不足可回 explore）/ update_stages 整体替换阶段 / stage 更新阶段状态（支持 updates 批量）/ todos 更新当前阶段代办清单 / audit 审计（迭代模式下不删目标，插件推送【迭代继续】指令）/ iterate 设置下一轮迭代目标 / finish 迭代结束收尾 / status 查看进度 / agents 全队目标一览（主会话+全部子代理：谁做到哪、多久没动）/ tell 与子代理互相交流（本会话子代理或自己的父会话；走唯一投递口，运行中即时插话、空闲唤醒）/ wait 团队等待（自定义时长，收到消息、队内会话目标更新、或队内目标完成即结束；等待一律用它，不要 sleep 或 bash 轮询，sleep 期间的消息与目标更新不会即时唤醒你）/ pause 暂停 / resume 恢复 / clear 清除 / cleanup 手动清理已完成已失败子代理（不受天数限制）" },
          goal: { type: "string", description: "目标描述（action=set / iterate 必填）" },
          direction: { type: "string", description: "迭代方向（action=iterate 可选，缺省沿用上次迭代方向或 goal）" },
          stageID: { type: "string", description: "阶段 id（action=stage 单个更新时必填；action=todos 可选，缺省=当前 in_progress 阶段，指定后可更新任意阶段代办，如补充其他阶段代办）" },
          stageStatus: { type: "string", description: "阶段状态：in_progress/completed/pending（action=stage，单个更新时必填）" },
          // V1 声明为 string，但模型常直接传 JSON 数组（V1 主体两种都兼容）→ 新 API 的 schema 同步放宽，保持 V1 的有效行为
          updates: { anyOf: [{ type: "string" }, { type: "array", items: { type: "object" } }], description: "批量更新阶段状态 JSON（action=stage，与 stageID 二选一）：[{\"id\":\"s1\",\"status\":\"completed\"},{\"id\":\"s2\",\"status\":\"completed\"}]，一次标记多个阶段完成" },
          stages: { anyOf: [{ type: "string" }, { type: "array", items: { type: "object" } }], description: "阶段列表 JSON（action=update_stages 必填）" },
          flow: { type: "string", description: "当前流程（action=flow 必填）：explore 探索 / plan 规划 / execute 执行 / audit 审计；规划中发现信息不足可用 flow=explore 回探索" },
          todos: { anyOf: [{ type: "string" }, { type: "array", items: { type: "object" } }], description: "当前阶段代办清单 JSON（action=todos 必填）：[{\"content\":\"...\",\"status\":\"pending\"},…]" },
          sessionID: { type: "string", description: "action=tell 必填：目标子代理的会话 id，先用 action=agents 查看全队再选" },
          text: { type: "string", description: "action=tell 必填：要投递给子代理的消息内容，统一经唯一投递口 pushPrompt 投递" },
          waitMs: { type: "string", description: "action=wait 可选：自定义等待毫秒数，默认 60000，范围 1000-900000，最长 15 分钟；收到消息、队内会话目标更新、或队内目标完成 即提前结束。等队友请用本动作，不要 sleep：sleep 期间队友的消息与目标更新只会排队、不会即时叫醒你" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const sid = context.sessionID
          // 归属区分（用户指定）：以「主会话 + 它的子代理」为一队——子代理归属其父=主会话；
          //   主代理看自己+自己的子代理；子代理看自己的主会话+同主的兄弟子代理；不看也不动别的会话/别的项目
          const teamScope = async (): Promise<Set<string>> => {
            // ⚠ 注册表里的子代理常常缺 parentID（session.created 事件不一定带）⇒ 缺失就向宿主补问一次并回填，
            //   否则队内识别会漏掉兄弟子代理，wait 会把同伴的事件当成“队外”过滤掉（实测踩过：同伴 set 目标却等到超时）
            const parentOf = async (id: string): Promise<string | undefined> => {
              const reg = sessionRegistry.get(id)
              if (reg?.parentID) return reg.parentID
              try {
                const b = await ctx.session.get({ sessionID: id }) as { parentID?: string; title?: string; time?: { updated: number } }
                if (b) {
                  sessionRegistry.set(id, { id, parentID: b.parentID, title: b.title ?? reg?.title, time: b.time ?? reg?.time })
                  saveSessionRegistry()
                  return b.parentID
                }
              } catch {}
              return reg?.parentID
            }
            const myParent = await parentOf(sid)
            const main = myParent ?? sid
            const team = new Set<string>([main, sid])
            for (const [id] of sessionRegistry) {
              if (id === main || id === sid) continue
              const p = await parentOf(id)
              if (p === main) team.add(id)
            }
            return team
          }
          debugLog(`goalTool action=${String(args.action)} sid=${sid.slice(-8)}`)
          try {
          const goals = loadGoals()
          const action = args.action ?? ""
          // 公共收尾：audit 非迭代 与 finish 复用（删除/保留目标 + 推送二次审计）
          const finishGoal = (e: GoalEntry, kind: "audit" | "finish") => {
            debugLog(`finishGoal kind=${kind} sid=${sid.slice(-8)} deleting=${configAuditDelete()}`)
            const snap = buildSnap(e)
            const planText = e.planFile ? (() => { try { const t = readFileSync(e.planFile, "utf8").trim(); return t || "" } catch { return "" } })() : ""
            const deleting = configAuditDelete()
            if (deleting) delete goals[sid]
            else { e.state = "done"; e.updatedAt = Date.now() }
            lastPushedMsg.delete(sid)
            lastPushTime.delete(sid)
            saveGoals(goals)
            const text = `【二次审计】${kind === "finish" ? "迭代已结束" : "目标已提交审计"}，${deleting ? "并清理" : "（已保留）"}。请做最终完成度确认：① 目标验收点是否全部达成 ② 有无遗漏未完成事项 ③ 是否可确认收尾。**确认通过即完成；如发现遗漏未完成，请用 goal 工具（action=set）重新设置原目标（完完整整原话）后继续推进。**\n\n【审计快照】\n${snap.join("\n")}${planText ? `\n\n【方案文档】\n${planText}` : ""}`
            // V1 行为：子代理同样会收到【二次审计】（行为必须一致）→ 无条件入队
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
              notify("success", "目标已设置，开始自主推进")
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
                  notify("success", `目标完成：审计通过${deleting ? "并清理" : "（已保留）"}`)
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
                notify("success", `目标完成：迭代模式第 ${count + 1} 轮完成${isLast ? `（已达迭代上限 ${maxRounds} 轮，请 finish 结束）` : "，已推送继续指令"}`)
                setTimeout(() => { rePushIterating(sid).catch(() => {}) }, 2000)
                return isLast
                  ? `第 ${count + 1} 轮迭代完成（已达迭代上限 ${maxRounds} 轮，本轮为最后一轮），迭代结束。请调用 goal 工具 action=finish 结束收尾。`
                  : `第 ${count + 1} 轮迭代完成，推进进入 iterating，本轮结束后插件推送【迭代继续】指令，AI 调用 iterate 继续。`
              }
              // 非迭代流程：按 auditDelete 删除/保留；【二次审计】由 session.idle 在本轮结束后推送一次
              const deleting = finishGoal(e, "audit")
              notify("success", `目标完成：审计通过${deleting ? "并清理" : "（已保留）"}`)
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
              notify("success", `第 ${it.count + 1} 轮迭代已开始`)
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
              notify("success", `迭代结束：审计通过${deleting ? "并清理" : "（已保留）"}`)
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
            case "agents": {
              // 参考 DSH `action=agents`（谁做到哪、多久没动）＋用户要求：全部目标的详细；
              // 归属隔离（用户指定）：只列「本会话所属的主会话 + 它的子代理」，绝不串到别的会话
              const now = Date.now()
              const team = await teamScope()
              const blocks: string[] = []
              for (const [id, e] of Object.entries(goals)) {
                if (e.state === "cleared") continue
                if (!team.has(id)) continue
                const reg = sessionRegistry.get(id)
                const role = id === sid ? "▶本会话" : reg?.parentID ? `子(${reg.parentID.slice(-8)})` : "主会话"
                const live = (sessionStatus.get(id) ?? "") === "idle" ? "○空闲" : "●运行中"
                const ms = reg?.time?.updated ?? e.updatedAt ?? e.startedAt
                const ago = ms ? (now - ms < 60000 ? `${Math.round((now - ms) / 1000)}秒前` : now - ms < 3600000 ? `${Math.round((now - ms) / 60000)}分钟前` : `${((now - ms) / 3600000).toFixed(1)}小时前`) : "?"
                const lines = [`${live} ${role} ${id.slice(-8)} 状态=${e.state} 流程=${e.flow ?? "explore"} 轮=${e.turns}/${e.maxTurns > 0 ? e.maxTurns : "不限"} 最后更新=${ago}`, `  目标：${e.goal}`]
                for (const h of e.history ?? []) lines.push(`  迭代历史 第${h.count + 1}轮：${h.goal}`)
                for (const s of e.stages ?? []) {
                  lines.push(`  ${s.status === "in_progress" ? "▶" : s.status === "completed" ? "✓" : "○"} ${s.name ?? s.content ?? ""} (${s.status})`)
                  for (const t of s.todos ?? []) lines.push(`      ${t.status === "in_progress" ? "▶" : t.status === "completed" ? "✓" : "○"} [${t.status}] ${t.content}`)
                }
                if ((e.stages ?? []).length === 0) lines.push("  （未规划阶段）")
                blocks.push(lines.join("\n"))
              }
              if (blocks.length === 0) return "（没有进行中的目标）"
              return `共 ${blocks.length} 个会话目标（全部详细）：\n` + blocks.join("\n")
            }
            case "tell": {
              // 参考 DSH `dev_subagent_hub action=inject`：给指定子代理投递消息。
              // ⚠ 必须走**唯一投递口 pushPrompt**（运行中⇒steer 即时插话 / 空闲⇒queue+resume 唤醒；只追加、不改前缀）
              //    绝不另开通道直调 synthetic 或写系统上下文，否则又会破坏 prompt 缓存。
              const target = String(args.sessionID ?? "").trim()
              const text2 = String(args.text ?? "").trim()
              if (!target || !text2) return "缺少 sessionID 或 text（action=tell 必填；sessionID 可用 action=agents 查）"
              let allowed = false
              let targetInfo: { parentID?: string } | undefined   // ⚠ 必须提到 try 外：body 是块级作用域，后面判断子代理会 ReferenceError（body is not defined）
              try {
                const body = await ctx.session.get({ sessionID: target }) as { parentID?: string }
                targetInfo = body
                const me = await ctx.session.get({ sessionID: sid }) as { parentID?: string }
                if (body && body.parentID === sid) allowed = true                                      // 主代理 → 自己的子代理
                else if (me && me.parentID === target) allowed = true                                   // 子代理 → 自己的父代理
                else if (body && me && me.parentID && body.parentID === me.parentID) allowed = true     // 子代理 ↔ 兄弟子代理
              } catch { return `取会话失败，未投递：${target.slice(-8)}` }
              if (!allowed) return `只能与同一团队的会话交流（本会话的子代理 / 自己的父代理 / 兄弟子代理）；${target.slice(-8)} 不在范围内`
              await pushPrompt(target, `【交流消息】${text2}`)
              notifyTeamEvent("message", sid, text2)
              // tell 的语义是"继续干活"：目标是 paused（被暂停的子代理）⇒ 自动恢复推进，不能只唤醒一次。
              //   只恢复 paused；done/cleared 属无目标（走下面告警）；limited（轮数上限）不擅自重置。
              //   放在 pushPrompt/notify 之后：先让"收到消息"事件优先唤醒等待者，再改状态（saveGoals 会发 goal 事件）。
              const gg = loadGoals()
              const tgt = gg[target]
              // 自动恢复只针对**子代理**（有 parentID）：主代理/父会话的 paused 是用户主动暂停，
              //   子代理一条 tell 不能悄悄把用户的暂停覆盖掉 ⇒ 主代理只投递、不恢复，并在返回里说明。
              const isSubTarget = !!targetInfo?.parentID
              let resumed = false
              let keptPausedMain = false
              if (tgt && tgt.state === "paused") {
                if (isSubTarget) {
                  tgt.state = "active"
                  tgt.updatedAt = Date.now()
                  saveGoals(gg)
                  resumed = true
                } else {
                  keptPausedMain = true
                }
              }
              const hasGoal = !!loadGoals()[target]
              const note = resumed ? "；子代理 paused → 已恢复推进"
                : keptPausedMain ? "；主代理 paused → 保持暂停"
                : hasGoal ? "" : "；无目标 → 仅唤醒一次"
              return `已投递（${target.slice(-8)}${note}）`
            }
            case "wait": {
              // 参考 DSH 团队等待：自定义时长；**收到消息或任一会话目标更新即结束等待**（统一函数 notifyTeamEvent 叫醒）
              const ms = Math.max(1000, Math.min(900000, parseInt(String(args.waitMs ?? "60000"), 10) || 60000))
              const team = await teamScope()
              const ev = await new Promise<TeamEvent | null>((resolve) => {
                const w = (e: TeamEvent) => {
                  const ids = String(e.sid).split(",")
                  // 自己的事件不唤醒自己；也不接受队外会话的事件（归属隔离）→ 返回 false，waiter 保留继续等
                  if (ids.every((id) => id === sid)) return false
                  if (!ids.some((id) => team.has(id))) return false
                  resolve(e)
                  return true
                }
                teamWaiters.add(w)
                setTimeout(() => { teamWaiters.delete(w); resolve(null) }, ms)
              })
              if (!ev) return `等待 ${Math.round(ms / 1000)} 秒结束：这段时间没有目标更新，也没收到消息`
              if (ev.kind === "message") return `等待被唤醒·收到消息（来自 ${String(ev.sid).slice(-8)}）：${String(ev.detail ?? "").slice(0, 200)}`
              // 目标事件：区分“目标完成”与“目标更新”（用户要求：完成以**目标完成**为准，不以会话跑完为准）
              const gg = loadGoals()
              const ids = String(ev.sid).split(",")
              const isDone = (id: string) => {
                const e = gg[id]
                return !e || e.state === "done" || e.state === "cleared" || e.state === "limited"
              }
              const parts = ids.map((id) => {
                const e = gg[id]
                return `  ${id.slice(-8)} ${isDone(id) ? "目标完成" : "目标更新"} 状态=${e?.state ?? "已完成并清理"} 流程=${e?.flow ?? "?"} 轮=${e?.turns ?? "?"} 阶段=${(e?.stages ?? []).filter((s) => s.status === "completed").length}/${(e?.stages ?? []).length} 目标=${String(e?.goal ?? "").slice(0, 50)}`
              })
              const anyDone = ids.some(isDone)
              return `${anyDone ? "等待被唤醒·队内目标完成" : "等待被唤醒·目标有更新"}（${parts.length} 个会话）：\n` + parts.join("\n")
            }
            case "pause":
              if (!goals[sid]) return "本会话没有目标"
              goals[sid].state = "paused"
              saveGoals(goals)
              // ⚠ 这里**不能掐回合**（用户明确要求：掐回合只能由用户发起）——goal 工具是 **AI 自己**调的，
              //   硬掐＝AI 把自己这轮打断（实测：AI 调 clear/pause 会把当前回合直接 aborted）。
              //   掐回合只保留在**用户入口**：TUI「/goal-all → 暂停」那边调 client.session.interrupt。
              //   本分支只翻状态；正在跑的这轮跑完后，状态守卫（非 active 不推进）自然阻止后续推送 —— 与 V1 一致。
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
              // ⚠ 同样不掐回合（用户要求：掐回合只能由用户发起）。AI 调 clear 只清状态，当前回合照常跑完；
              //   跑完后没有目标 ⇒ 不会再有任何自动推送。用户要立刻停，请用 TUI「/goal-all → 暂停」（那边会硬掐）。
              lastPushedMsg.delete(sid)
              lastPushTime.delete(sid)
              pendingSecondaryPush.delete(sid)  // M6：清除目标时丢弃挂起的二次审计推送（防旧快照推给新目标）
              pendingPushQueue.delete(sid)
              pendingMsgDrive.delete(sid)
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
    }
  // ── V2：注册工具（V1 的 execute 返回字符串 → V2 的 Tool.Result 外面包一层；execute 主体一字未改）──
  await ctx.tool.transform((editor: any) => {
    editor.add({ ...goalTool, execute: async (args: any, context: any) => ({ content: await goalTool.execute(args, context) }) })
  })
  // ── V2：启动事件订阅 ──
  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ signal: controller.signal })) void onEvent(ev)
    } catch (e) {
      if (!controller.signal.aborted) console.error("[goal] event stream ended:", e)
    }
  })()
  return () => { clearInterval(pushTimer); controller.abort() }
}

// V1 插件模块（{ id, server }）→ V2 Plugin.define({ id, setup(ctx) })
export default Plugin.define({
  id: "opencode-goal",
  setup: (ctx: any) => GoalPlugin(ctx, ctx.options),
})
