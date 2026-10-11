// src/index.ts
import { tool } from "@opencode-ai/plugin";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
var home = process.env.HOME ?? "/root";
var stateDir = join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "goal");
mkdirSync(stateDir, { recursive: true });
var goalsFile = join(stateDir, "goals.json");
var configFile = join(stateDir, "config.json");
var DEFAULT_PLAN_DIR = "/tmp/plan";
mkdirSync(DEFAULT_PLAN_DIR, { recursive: true });
function read(p, fb = "") {
  try {
    return readFileSync(p, "utf8").trim() || fb;
  } catch {
    return fb;
  }
}
function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(configFile, "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch {
  }
  return {};
}
function resolvePlanDir() {
  const v = loadConfig().planDir;
  if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (t === "workspace") return join(process.cwd(), ".plan");
    if (t === "default") return DEFAULT_PLAN_DIR;
    return t;
  }
  return DEFAULT_PLAN_DIR;
}
function configIterateMode() {
  return loadConfig().iterateMode === true;
}
function configAuditDelete() {
  return loadConfig().auditDelete !== false;
}
function configIterateMaxRounds() {
  const n = parseInt(String(loadConfig().iterateMaxRounds));
  if (Number.isInteger(n) && n >= 0) return n;
  return 0;
}
function configIterAskMode() {
  const v = String(loadConfig().iterAskMode ?? "first");
  return v === "every" ? "every" : "first";
}
function loadGoals() {
  try {
    const raw = JSON.parse(readFileSync(goalsFile, "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch {
  }
  return {};
}
function saveGoals(g) {
  const tmp = `${goalsFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(g, null, 2));
    renameSync(tmp, goalsFile);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}
function normalizeTodos(arr) {
  return arr.map((t) => {
    const o = t ?? {};
    return {
      content: String(o.content ?? ""),
      status: String(o.status ?? "pending"),
      priority: o.priority !== void 0 ? String(o.priority) : void 0
    };
  }).filter((t) => t.content);
}
function autoCompleteDoneTodos(stage) {
  if (!stage.todos) return 0;
  let n = 0;
  for (const t of stage.todos) if (t.status !== "completed") {
    t.status = "completed";
    n++;
  }
  return n;
}
function loadRuntimeMaxTurns() {
  try {
    const cfg = JSON.parse(readFileSync(configFile, "utf8"));
    const n = parseInt(cfg?.maxTurns);
    if (Number.isInteger(n) && n >= 0) return n;
  } catch {
  }
  return null;
}
var GoalPlugin = async ({ client }, options = {}) => {
  const cfgMax = parseInt(String(options.maxTurns ?? ""));
  const defaultMaxTurns = Number.isInteger(cfgMax) && cfgMax >= 0 ? cfgMax : 100;
  const currentMaxTurns = () => {
    const rt = loadRuntimeMaxTurns();
    return rt === null ? defaultMaxTurns : rt;
  };
  const busySet = /* @__PURE__ */ new Set();
  const interrupted = /* @__PURE__ */ new Set();
  const lastPushedMsg = /* @__PURE__ */ new Map();
  const lastPushTime = /* @__PURE__ */ new Map();
  const rePushIterCount = /* @__PURE__ */ new Map();
  const pendingMsgDrive = /* @__PURE__ */ new Set();
  const pendingPushQueue = /* @__PURE__ */ new Map();
  const pendingRetryPush = /* @__PURE__ */ new Map();
  const iterAskedFile = join(stateDir, "iter-asked.json");
  let iterAsked = /* @__PURE__ */ new Set();
  try {
    iterAsked = new Set(JSON.parse(readFileSync(iterAskedFile, "utf8")));
  } catch {
  }
  const persistIterAsked = () => {
    try {
      writeFileSync(iterAskedFile, JSON.stringify([...iterAsked]));
    } catch {
    }
  };
  const iterAskedForRound = /* @__PURE__ */ new Map();
  const pendingSecondaryPush = /* @__PURE__ */ new Map();
  const pushPrompt = async (sid, text, opts) => {
    let tools;
    const cached = isSubagentCache.get(sid);
    if (cached === true) {
    } else if (cached === false) {
      tools = { question: true };
    } else {
      try {
        await isSubagent(sid);
      } catch {
      }
      if (isSubagentCache.get(sid) !== true) tools = { question: true };
    }
    const body = { agent: "z-goal", parts: [{ type: "text", text, synthetic: true }] };
    if (tools) body.tools = tools;
    if (opts?.noReply) body.noReply = true;
    try {
      await client.session.prompt({ path: { id: sid }, body });
    } catch (e) {
      const arr = pendingRetryPush.get(sid) ?? [];
      arr.push(text);
      pendingRetryPush.set(sid, arr);
      console.error(`[goal] pushPrompt busy \u62D2\u7EDD\uFF0C\u5DF2\u6302\u8D77\u7B49\u5F85\u91CD\u8BD5 (${sid})`);
    }
  };
  const pushFirstRound = (sid) => {
    setTimeout(async () => {
      try {
        const cur = loadGoals();
        const entry = cur[sid];
        if (!entry) return;
        entry.turns = 1;
        saveGoals(cur);
        await pushPrompt(sid, `\uFF08\u7B2C 1 \u8F6E\uFF0C\u4E0A\u9650 ${entry.maxTurns > 0 ? `${entry.maxTurns} \u8F6E` : "\u4E0D\u9650"}\uFF09

\u3010\u76EE\u6807\u3011${entry.goal}

\u3010\u5F53\u524D\u6D41\u7A0B\u3011\u63A2\u7D22\uFF1A\u5148\u786E\u8BA4\u5B8C\u6210\u6761\u4EF6\uFF08\u8BFB\u6587\u4EF6/\u641C\u7D22/\u4EA4\u53C9\u9A8C\u8BC1\uFF09\uFF0C\u63A2\u7D22\u5145\u5206\u540E\u7528 goal \u5DE5\u5177 action=flow\uFF08flow=plan\uFF09\u8FDB\u5165\u89C4\u5212

${configIterateMode() && isSubagentCache.get(sid) !== true || entry.iteration ? `\u3010\u8FED\u4EE3\u3011${entry.iteration && entry.iteration.count > 0 ? `\u7B2C ${entry.iteration.count + 1} \u8F6E${entry.iteration.direction ? ` \xB7 \u65B9\u5411\uFF1A${entry.iteration.direction}` : ""}\uFF08\u8FED\u4EE3\u6A21\u5F0F\u5DF2\u542F\u7528\uFF09` : `\u8FED\u4EE3\u6A21\u5F0F\u5DF2\u542F\u7528\uFF08\u4E0A\u9650 ${configIterateMaxRounds() > 0 ? `${configIterateMaxRounds()} \u8F6E` : "\u4E0D\u9650"}\uFF09\uFF1A\u5BA1\u8BA1\u540E\u4E0D\u5220\u76EE\u6807\uFF0C\u63D2\u4EF6\u5C06\u63A8\u9001\u3010\u8FED\u4EE3\u7EE7\u7EED\u3011\u6307\u4EE4`}

` : `\u3010\u8FED\u4EE3\u3011\u8FED\u4EE3\u6A21\u5F0F\u672A\u542F\u7528\uFF1A\u5BA1\u8BA1\u540E\u6B63\u5E38\u6536\u5C3E\uFF08\u65E0\u8FED\u4EE3\u5FAA\u73AF\uFF09

`}\u3010\u76EE\u6807\u9636\u6BB5\u3011\uFF08\u672A\u89C4\u5212\uFF09

\u8BA1\u5212\u6587\u4EF6\uFF1A${entry.planFile}

\u672C\u8F6E\u4E3A\u7B2C 1 \u8F6E\uFF1A\u8BF7\u6309 z-goal \u89C4\u8303\u5148\u63A2\u7D22\u786E\u8BA4\u5B8C\u6210\u6761\u4EF6\uFF0C\u518D\u521B\u5EFA\u8BA1\u5212\u6587\u6863\uFF08write\uFF0C\u8DEF\u5F84=\u4E0A\u65B9\u300C\u8BA1\u5212\u6587\u4EF6\uFF1A\u300D\u884C\uFF09\u3001\u89C4\u5212\u76EE\u6807\u9636\u6BB5\u4E0E\u5F53\u524D\u9636\u6BB5\u4EE3\u529E\uFF08update_stages\uFF0C\u89C4\u5212\u540E goal \u5DE5\u5177 action=flow flow=execute\uFF09\uFF0C\u7136\u540E\u6267\u884C\u3002`);
        lastPushTime.set(sid, Date.now());
      } catch (e) {
        console.error("[goal] first round push failed:", e);
      }
    }, 300);
  };
  const buildPrompt = (entry, turns, sid) => {
    const stages = entry.stages ?? [];
    let stageBlock;
    if (stages.length > 0) {
      stageBlock = "\n\n\u3010\u76EE\u6807\u9636\u6BB5\u3011\n" + stages.map((s) => {
        const mark = s.status === "in_progress" ? "\u25B6" : s.status === "completed" ? "\u2713" : "\u25CB";
        return `${mark} ${s.name ?? s.content ?? ""}${s.status === "in_progress" ? "\uFF08\u5F53\u524D\u9636\u6BB5\uFF09" : ""}`;
      }).join("\n");
    } else {
      stageBlock = "\n\n\u3010\u76EE\u6807\u9636\u6BB5\u3011\uFF08\u672A\u89C4\u5212\uFF09";
    }
    const planLine = entry.planFile ? `

\u8BA1\u5212\u6587\u4EF6\uFF1A${entry.planFile}` : "";
    const isSub = isSubagentCache.get(sid) === true;
    const iterOn = configIterateMode() && !isSub || !!entry.iteration;
    const maxRounds = configIterateMaxRounds();
    const iterCount = entry.iteration?.count ?? 0;
    const isLast = maxRounds > 0 && iterCount + 1 >= maxRounds;
    const askEvery = configIterAskMode() === "every";
    const showAsk = iterOn && entry.flow === "plan" && (askEvery ? iterAskedForRound.get(sid) !== iterCount : !iterAsked.has(sid));
    if (showAsk) {
      if (askEvery) iterAskedForRound.set(sid, iterCount);
      else {
        iterAsked.add(sid);
        persistIterAsked();
      }
    }
    const askNote = entry.flow === "plan" ? iterOn ? showAsk ? `\uFF1B\u3010\u8FED\u4EE3\u8BE2\u95EE\u3011\u672C\u8F6E\u89C4\u5212\u9700\u7528 question \u8BE2\u95EE\u7528\u6237\u65B9\u5411/\u9650\u5236\uFF08\u6A21\u5F0F\uFF1A${askEvery ? "\u6BCF\u8F6E\u8BE2\u95EE" : "\u4EC5\u9996\u8F6E"}\uFF09\uFF0C\u6F84\u6E05\u540E\u505A\u786E\u8BA4\u63D0\u95EE\uFF0C\u786E\u8BA4\u5185\u5BB9\u8BB0\u5F55\u5230 direction` : askEvery ? `\uFF1B\u3010\u8FED\u4EE3\u8BE2\u95EE\u3011\u6BCF\u8F6E\u8BE2\u95EE\u6A21\u5F0F\uFF0C\u672C\u8F6E\u5DF2\u63D0\u9192\u8FC7\uFF0C\u65E0\u9700\u91CD\u590D` : `\uFF1B\u3010\u8FED\u4EE3\u8BE2\u95EE\u3011\u4EC5\u9996\u8F6E\u6A21\u5F0F\uFF0C\u5DF2\u786E\u8BA4\u5168\u5C40\u751F\u6548\uFF0C\u672C\u8F6E\u65E0\u9700\u8BE2\u95EE` : !isSub ? `\uFF1B\u89C4\u5212\u9636\u6BB5\u63D0\u95EE\uFF1A\u76EE\u6807/\u65B9\u5411/\u7406\u89E3\u4E0D\u786E\u5B9A \u2192 \u7528 question \u5DE5\u5177\u8BE2\u95EE\u6F84\u6E05\uFF08\u4E0D\u9650\u6B21\u6570\u76F4\u5230\u5B8C\u5168\u7406\u89E3\uFF09\uFF0C\u5B8C\u5168\u7406\u89E3\u540E\u505A\u4E00\u6B21\u786E\u8BA4\u63D0\u95EE\uFF08\u590D\u8FF0\u7406\u89E3\uFF09\uFF0C\u786E\u8BA4\u540E\u8BB0\u5F55\uFF08\u5199\u5165\u65B9\u6848\u6587\u6863\uFF09` : "" : "";
    const flowLine = {
      explore: `

\u3010\u5F53\u524D\u6D41\u7A0B\u3011\u63A2\u7D22\uFF1A\u5148\u786E\u8BA4\u5B8C\u6210\u6761\u4EF6\uFF08\u8BFB\u6587\u4EF6/\u641C\u7D22/\u4EA4\u53C9\u9A8C\u8BC1\uFF09\uFF0C\u5145\u5206\u540E action=flow\uFF08flow=plan\uFF09\u8FDB\u5165\u89C4\u5212`,
      plan: `

\u3010\u5F53\u524D\u6D41\u7A0B\u3011\u89C4\u5212\uFF1A\u9AD8\u8D28\u91CF\u89C4\u5212\u2014\u2014\u5148 write \u65B9\u6848\u6587\u6863\uFF08\u975E\u5E38\u8BE6\u7EC6\uFF09\uFF0C\u518D update_stages \u89C4\u5212\u9636\u6BB5\uFF08\u5E26 todos\uFF0C\u8986\u76D6\u5168\u90E8\u5B8C\u6210\u6761\u4EF6\uFF09\uFF1B\u4E0D\u8DB3 action=flow\uFF08flow=explore\uFF09\u56DE\u63A2\u7D22\uFF1B\u5B8C\u6210\u524D\u6838\u5BF9\uFF08\u65B9\u6848\u6587\u6863\u5DF2\u5199\u4E14\u8BE6\u7EC6\u3001\u9636\u6BB5\u8986\u76D6\u5B8C\u6210\u6761\u4EF6\u3001\u5F53\u524D\u9636\u6BB5\u4EE3\u529E\u660E\u786E\uFF09\u2192 action=flow\uFF08flow=execute\uFF09${askNote}`,
      execute: `

\u3010\u5F53\u524D\u6D41\u7A0B\u3011\u6267\u884C\uFF1A\u63A8\u8FDB\u5F53\u524D\u9636\u6BB5\u4EE3\u529E\uFF08stage / todos \u6D41\u8F6C\uFF09\uFF1B\u9636\u6BB5/\u4EE3\u529E\u8FC7\u65F6\u4E3B\u52A8\u4FEE\u6539\uFF08update_stages / todos\uFF09\uFF1B\u6BCF\u6B65\u9A8C\u8BC1\u771F\u5B9E\u6709\u6548\uFF08\u7F16\u8BD1/\u6D4B\u8BD5\uFF09\uFF1B\u5168\u90E8\u9636\u6BB5 completed \u2192 action=flow\uFF08flow=audit\uFF09`,
      audit: `

\u3010\u5F53\u524D\u6D41\u7A0B\u3011\u5BA1\u8BA1\uFF1A\u5148\u505A\u4E00\u6B21\u5BA1\u8BA1\uFF08\u5E26\u63A2\u7D22\u8F85\u52A9\u7406\u89E3\uFF1A\u91CD\u8BFB\u5173\u952E\u6539\u52A8/\u8FD0\u884C\u9A8C\u8BC1/\u4EA4\u53C9\u6838\u5BF9\uFF1B\u91CD\u8BFB\u6539\u52A8/\u7F16\u8BD1/\u5BF9\u7167\u65B9\u6848\u6587\u6863\uFF09\uFF0C\u901A\u8FC7\u540E action=audit`
    }[entry.flow ?? "explore"];
    const iterLine = !iterOn ? `

\u3010\u8FED\u4EE3\u3011\u8FED\u4EE3\u6A21\u5F0F\u672A\u542F\u7528\uFF1A\u5BA1\u8BA1\u540E\u6B63\u5E38\u6536\u5C3E\uFF08\u65E0\u8FED\u4EE3\u5FAA\u73AF\uFF09` : entry.iteration && entry.iteration.count > 0 ? `

\u3010\u8FED\u4EE3\u3011\u7B2C ${iterCount + 1} \u8F6E${entry.iteration.direction ? ` \xB7 \u65B9\u5411\uFF1A${entry.iteration.direction}` : ""}\uFF08\u4E0A\u9650 ${maxRounds > 0 ? `${maxRounds} \u8F6E` : "\u4E0D\u9650"}${isLast ? `\uFF1B**\u672C\u8F6E\u4E3A\u6700\u540E\u4E00\u8F6E\uFF1A\u5BA1\u8BA1\u540E\u8FED\u4EE3\u7ED3\u675F\uFF0C\u8BF7 finish \u6536\u5C3E**` : ""}\uFF1B\u5BA1\u8BA1\u540E\u6309\u63D2\u4EF6\u63A8\u9001\u6307\u4EE4\u7EE7\u7EED\u8FED\u4EE3\uFF09` : `

\u3010\u8FED\u4EE3\u3011\u8FED\u4EE3\u6A21\u5F0F\u5DF2\u542F\u7528\uFF08\u4E0A\u9650 ${maxRounds > 0 ? `${maxRounds} \u8F6E` : "\u4E0D\u9650"}\uFF09\uFF1A\u5BA1\u8BA1\u540E\u4E0D\u5220\u76EE\u6807\uFF0C\u63D2\u4EF6\u5C06\u63A8\u9001\u3010\u8FED\u4EE3\u7EE7\u7EED\u3011\u6307\u4EE4\uFF08goal \u5DE5\u5177 action=iterate \u7EE7\u7EED / finish \u7ED3\u675F\uFF09`;
    const historyBlock = (entry.history ?? []).length > 0 ? "\n\n\u3010\u8FED\u4EE3\u5386\u53F2\u3011\n" + entry.history.map(
      (h) => `\u7B2C${h.count + 1}\u8F6E\uFF1A${h.goal}\uFF08${h.state === "done" ? "\u5DF2\u5B8C\u6210" : h.state ?? "\u5DF2\u5B8C\u6210"}\uFF09` + (h.planFile ? `
  \u65B9\u6848\u6587\u6863\uFF1A${h.planFile}` : "") + ((h.stages ?? []).length ? "\n" + h.stages.map((s) => `  ${s.status === "in_progress" ? "\u25B6" : s.status === "completed" ? "\u2713" : "\u25CB"} ${s.name ?? s.content ?? ""}${(s.todos ?? []).length ? `\uFF08${s.todos.length} \u9879\u4EE3\u529E\uFF09` : ""}`).join("\n") : "")
    ).join("\n") : "";
    return `\uFF08\u7B2C ${turns} \u8F6E\uFF0C\u4E0A\u9650 ${entry.maxTurns > 0 ? `${entry.maxTurns} \u8F6E` : "\u4E0D\u9650"}\uFF09

\u3010\u76EE\u6807\u3011${entry.goal}

\u3010\u7CFB\u7EDF\u63D0\u9192\u3011\u672C\u63A8\u9001\u4E3A\u7CFB\u7EDF\u81EA\u52A8\u63A8\u9001\uFF08\u6BCF ${Math.round(pushIntervalMs() / 6e4)} \u5206\u949F\u68C0\u67E5\u63A8\u9001\u4E00\u6B21\uFF09\uFF1A\u9636\u6BB5/\u4EE3\u529E**\u5B8C\u6210\u4E00\u9879\u66F4\u65B0\u4E00\u9879**\uFF08stage/todos \u6D41\u8F6C\uFF09\uFF0C\u65E0\u9700\u9010\u6761\u66F4\u65B0${flowLine}${iterLine}${historyBlock}${stageBlock}${planLine}

\u5B8C\u6210\u5168\u90E8\u5DE5\u4F5C\u540E\uFF0C\u6700\u540E\u4E00\u6B65\u8C03\u7528 goal \u5DE5\u5177 action=audit \u7ED3\u675F\u63A8\u8FDB\u3002
`;
  };
  const buildSnap = (e) => {
    const snap = [`\u76EE\u6807\uFF1A${e.goal}`];
    if (e.iteration) snap.push(`\u8FED\u4EE3\uFF1A\u7B2C ${e.iteration.count + 1} \u8F6E${e.iteration.direction ? ` \xB7 \u65B9\u5411\uFF1A${e.iteration.direction}` : ""}`);
    if (e.planFile) snap.push(`\u8BA1\u5212\u6587\u4EF6\uFF1A${e.planFile}`);
    for (const s of e.stages ?? []) {
      snap.push(`  ${s.status === "in_progress" ? "\u25B6" : s.status === "completed" ? "\u2713" : "\u25CB"} ${s.name ?? s.content ?? ""}`);
      for (const t of s.todos ?? []) snap.push(`      ${t.status === "in_progress" ? "\u25B6" : t.status === "completed" ? "\u2713" : "\u25CB"} ${t.content}`);
    }
    return snap;
  };
  const rePushIterating = async (sessionID) => {
    const goals = loadGoals();
    const e = goals[sessionID];
    if (!e || e.state !== "iterating") return;
    if (interrupted.has(sessionID)) {
      interrupted.delete(sessionID);
      e.state = "paused";
      e.updatedAt = Date.now();
      saveGoals(goals);
      await client.tui.showToast({ body: { message: "\u8FED\u4EE3\u5DF2\u88AB ESC \u4E2D\u65AD\uFF0C\u76EE\u6807\u6682\u505C\uFF0C/goal-resume \u6216 goal \u5DE5\u5177 resume \u6062\u590D", variant: "warning" } });
      return;
    }
    const count = e.iteration?.count ?? 0;
    if (rePushIterCount.get(sessionID) === count) return;
    rePushIterCount.set(sessionID, count);
    const maxRounds = configIterateMaxRounds();
    const isLast = maxRounds > 0 && count + 1 >= maxRounds;
    const text = isLast ? `\u3010\u8FED\u4EE3\u7ED3\u675F\u3011\u5DF2\u8FBE\u8FED\u4EE3\u4E0A\u9650 ${maxRounds} \u8F6E\uFF0C\u672C\u8F6E\u8FED\u4EE3\u5DF2\u5B8C\u6210\u3002\u8BF7\u7ACB\u5373\u8C03\u7528 goal \u5DE5\u5177 action=finish \u7ED3\u675F\u8FED\u4EE3\u6536\u5C3E\u3002

\u3010\u672C\u8F6E\u5FEB\u7167\u3011
${buildSnap(e).join("\n")}` : `\u3010\u8FED\u4EE3\u7EE7\u7EED\u3011\u7B2C ${count + 1} \u8F6E\u8FED\u4EE3\u5DF2\u5B8C\u6210\uFF08\u8FED\u4EE3\u6A21\u5F0F\uFF09\u3002\u8BF7\u7ACB\u5373\u8C03\u7528 goal \u5DE5\u5177 action=iterate \u8BBE\u7F6E\u4E0B\u4E00\u8F6E\u8FED\u4EE3\u76EE\u6807\uFF1Agoal = \u57FA\u4E8E\u4E0A\u8F6E\u76EE\u6807\u3001\u672C\u8F6E\u7ED3\u679C\u4E0E\u7528\u6237\u53CD\u9988\u6539\u8FDB\u540E\u7684\u65B0\u76EE\u6807\uFF08\u65E0\u53CD\u9988\u5219\u6CBF\u5F53\u524D\u65B9\u5411\u6301\u7EED\u4F18\u5316\uFF09\u3002\u82E5\u5BF9\u76EE\u6807/\u65B9\u5411\u7406\u89E3\u4E0D\u6E05\u6216\u8FED\u4EE3\u53EF\u80FD\u504F\u79BB \u2192 \u5148\u7528 question \u5DE5\u5177\u8BE2\u95EE\u7528\u6237\u6F84\u6E05\uFF0C\u4E0D\u9650\u6B21\u6570\uFF1B**\u5B8C\u5168\u7406\u89E3\u540E\u505A\u4E00\u6B21\u786E\u8BA4\u63D0\u95EE\uFF08\u590D\u8FF0\u4F60\u7684\u7406\u89E3\uFF1A\u65B9\u5411/\u9650\u5236\uFF09\uFF0C\u7528\u6237\u786E\u8BA4\u540E\u628A\u786E\u8BA4\u5185\u5BB9\u5199\u5165 iterate \u7684 direction \u53C2\u6570\uFF08\u786E\u8BA4\u8BB0\u5F55\uFF09\u518D iterate**\u3002

\u7528\u6237\u4F8B\u5916\uFF1A\u82E5\u7528\u6237\u5DF2\u66F4\u65B0\u76EE\u6807\u6216\u660E\u786E\u8981\u6C42\u7ED3\u675F\uFF0C\u4EE5\u7528\u6237\u8981\u6C42\u4E3A\u51C6\uFF08\u7ED3\u675F \u2192 action=finish \u6536\u5C3E\uFF09\u3002

\u3010\u672C\u8F6E\u5FEB\u7167\u3011
${buildSnap(e).join("\n")}`;
    await pushPrompt(sessionID, text).catch(() => {
    });
  };
  const autoContinue = async (sessionID, via = "idle") => {
    busySet.add(sessionID);
    setTimeout(() => busySet.delete(sessionID), 12e4);
    const goals = loadGoals();
    const entry = goals[sessionID];
    if (!entry) {
      await maybePushSubagentGoalGuide(sessionID);
      return;
    }
    if (!isSubagentCache.has(sessionID)) {
      try {
        await isSubagent(sessionID);
      } catch {
      }
    }
    if (interrupted.has(sessionID)) {
      interrupted.delete(sessionID);
      entry.state = "paused";
      entry.updatedAt = Date.now();
      saveGoals(goals);
      await client.tui.showToast({ body: { message: "\u751F\u6210\u88AB\u4E2D\u65AD\uFF08ESC\uFF09\uFF0C\u76EE\u6807\u5DF2\u6682\u505C\uFF0C/goal-resume \u6216 goal \u5DE5\u5177 resume \u6062\u590D", variant: "warning" } });
      return;
    }
    if (entry.state !== "active") return;
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      const msgs = Array.isArray(res) ? res : res.data ?? [];
      const lastAsst = [...msgs].reverse().find((m) => {
        if (m.info.role !== "assistant") return false;
        const parts = m.parts ?? [];
        return !parts.some((p) => p.type === "text" && p.synthetic === true);
      });
      if (lastAsst && lastAsst.info.time?.completed === void 0) {
        return;
      }
      if (lastAsst?.info?.error) {
        entry.state = "paused";
        entry.updatedAt = Date.now();
        saveGoals(goals);
        await client.tui.showToast({ body: { message: "\u751F\u6210\u88AB\u4E2D\u65AD\uFF08ESC\uFF09\uFF0C\u76EE\u6807\u5DF2\u6682\u505C\uFF0C/goal-resume \u6216 goal \u5DE5\u5177 resume \u6062\u590D", variant: "warning" } });
        return;
      }
      const lastMsgId = lastAsst?.id ?? lastAsst?.info?.id;
      if (lastPushedMsg.get(sessionID) === lastMsgId) return;
      const turns = entry.turns + (via === "idle" ? 1 : 0);
      entry.turns = turns;
      entry.updatedAt = Date.now();
      const isIterGoal = configIterateMode() && isSubagentCache.get(sessionID) !== true || !!entry.iteration;
      if (!isIterGoal && entry.maxTurns > 0 && turns > entry.maxTurns) {
        entry.state = "limited";
        saveGoals(goals);
        await client.tui.showToast({ body: { message: `\u5DF2\u8FBE\u8F6E\u6570\u4E0A\u9650 ${entry.maxTurns}\uFF0C\u76EE\u6807\u505C\u6B62\u63A8\u8FDB\uFF08\u7EC8\u6001\uFF1B\u5982\u9700\u7EE7\u7EED\u8BF7\u7528 /goal \u91CD\u65B0\u8BBE\u7F6E\u76EE\u6807\uFF09`, variant: "warning" } });
        return;
      }
      saveGoals(goals);
      const curStage = (entry.stages ?? []).find((s) => s.status === "in_progress");
      const todos = curStage?.todos ?? [];
      let todoBlock = "";
      if (todos.length > 0) {
        todoBlock = `
\u3010\u4EE3\u529E\u3011\uFF08\u5F53\u524D\u9636\u6BB5\uFF1A${curStage?.name ?? ""}\uFF09
` + todos.map((t) => {
          const mark = t.status === "in_progress" ? "\u25B6" : t.status === "completed" ? "\u2713" : "\u25CB";
          return `${mark} [${t.status}] ${t.content}`;
        }).join("\n");
      }
      const prompt = buildPrompt(entry, turns, sessionID) + todoBlock;
      await pushPrompt(sessionID, prompt);
      lastPushTime.set(sessionID, Date.now());
      lastPushedMsg.set(sessionID, lastMsgId);
    } catch (e) {
      console.error("[goal] auto continue failed:", e);
    } finally {
      busySet.delete(sessionID);
    }
  };
  const subGoalGuideText = `\u8BF7\u5148\u8C03\u7528 goal \u5DE5\u5177\uFF08action=set\uFF09\u8BBE\u7F6E\u4F60\u7684\u76EE\u6807\uFF1Agoal \u53C2\u6570\u7528**\u4E3B\u4EE3\u7406\u4E0B\u53D1\u7684\u4EFB\u52A1\u63CF\u8FF0\u539F\u8BDD**\uFF08\u4E0D\u8981\u7528\u672C\u6D88\u606F\u6587\u672C\uFF09\uFF0C\u4E4B\u540E\u6309\u63A8\u9001\u63A8\u8FDB\u76F4\u81F3 goal \u5DE5\u5177\uFF08action=audit\uFF09\u7ED3\u675F\u3002\u6CE8\u610F\uFF1A\u5B50\u4EE3\u7406\u4E0D\u5141\u8BB8\u8BE2\u95EE\u7528\u6237\uFF0C\u5982\u6709\u7591\u95EE\u6309\u4F60\u7684\u7406\u89E3\u63A8\u8FDB\u6216\u56DE\u62A5\u4E3B\u4EE3\u7406\u3002`;
  const subGuideInFlight = /* @__PURE__ */ new Set();
  const subGuideGuidedFile = join(stateDir, "sub-goal-guided.json");
  const loadSubGuideGuided = () => {
    try {
      return new Set(JSON.parse(readFileSync(subGuideGuidedFile, "utf8")));
    } catch {
      return /* @__PURE__ */ new Set();
    }
  };
  const saveSubGuideGuided = (s) => writeFileSync(subGuideGuidedFile, JSON.stringify([...s]));
  const maybePushSubagentGoalGuide = async (sid) => {
    if (subGuideInFlight.has(sid)) return;
    if (loadSubGuideGuided().has(sid)) return;
    try {
      subGuideInFlight.add(sid);
      if (!await isSubagent(sid)) return;
      const pinfo = await client.session.get({ path: { id: sid } });
      const pbody = Array.isArray(pinfo) ? pinfo[0] : pinfo.data ?? pinfo;
      const parentID = pbody?.parentID;
      if (!parentID) return;
      const p = loadGoals()[parentID];
      if (!p || p.state === "done" || p.state === "cleared") return;
      const guided = loadSubGuideGuided();
      guided.add(sid);
      saveSubGuideGuided(guided);
      await pushPrompt(sid, subGoalGuideText);
    } catch (e) {
      console.error("[goal] push subagent goal guide failed:", e);
    } finally {
      subGuideInFlight.delete(sid);
    }
  };
  const handled = /* @__PURE__ */ new Set();
  const HANDLED_MAX = 5e3;
  const markHandled = (id) => {
    handled.add(id);
    if (handled.size > HANDLED_MAX) handled.clear();
  };
  const DEFAULT_STUCK_MS = parseInt(String(options.stuckTimeoutMs ?? "600000"));
  const AUTO_ABORT_SUBAGENT = String(options.autoAbortSubagent ?? "true") !== "false";
  const pushIntervalMs = () => {
    try {
      const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.pushIntervalMs);
      if (Number.isInteger(n) && n >= 3e4) return n;
    } catch {
    }
    return Math.max(3e4, Number(options.pushIntervalMs ?? 3e5) || 3e5);
  };
  const DEFAULT_CLEANUP_DAYS = parseFloat(String(options.cleanupDays ?? "3"));
  const stuckTimeoutMs = () => {
    try {
      const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.stuckTimeoutMs);
      if (Number.isInteger(n) && n >= 6e4) return n;
    } catch {
    }
    return DEFAULT_STUCK_MS;
  };
  const cleanupDays = () => {
    try {
      const n = parseFloat(JSON.parse(readFileSync(configFile, "utf8"))?.cleanupDays);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
    }
    return DEFAULT_CLEANUP_DAYS;
  };
  const maxRetainedSubagents = () => {
    try {
      const n = parseInt(JSON.parse(readFileSync(configFile, "utf8"))?.maxRetainedSubagents);
      if (Number.isInteger(n) && n >= 0) return n;
    } catch {
    }
    return 60;
  };
  const cleanupMs = () => cleanupDays() * 24 * 3600 * 1e3;
  const lastActivity = /* @__PURE__ */ new Map();
  const isSubagentCache = /* @__PURE__ */ new Map();
  const isSubagent = async (sid) => {
    if (isSubagentCache.has(sid)) return isSubagentCache.get(sid);
    try {
      const res = await client.session.get({ path: { id: sid } });
      const info = Array.isArray(res) ? res[0] : res.data ?? res;
      const v = !!info?.parentID;
      isSubagentCache.set(sid, v);
      return v;
    } catch {
      return false;
    }
  };
  const cleanupStuck = async () => {
    const now = Date.now();
    if (lastActivity.size === 0) return;
    let statusMap = {};
    try {
      const res = await client.session.status({});
      const body = Array.isArray(res) ? res[0] : res.data ?? res;
      if (body && typeof body === "object") statusMap = body;
    } catch {
    }
    for (const [sid, last] of lastActivity) {
      if (now - last < stuckTimeoutMs()) continue;
      try {
        const st = statusMap[sid];
        if (st?.type === "idle") {
          lastActivity.delete(sid);
          continue;
        }
        const sub = await isSubagent(sid);
        if (sub && AUTO_ABORT_SUBAGENT) {
          try {
            const pinfo = await client.session.get({ path: { id: sid } });
            const pbody = Array.isArray(pinfo) ? pinfo[0] : pinfo.data ?? pinfo;
            const parentID = pbody?.parentID;
            if (parentID) {
              await pushPrompt(parentID, `\u3010\u7CFB\u7EDF\u901A\u77E5\u3011\u5B50\u4EE3\u7406\u4F1A\u8BDD ${sid.slice(-8)} \u56E0\u8D85\u8FC7 ${stuckTimeoutMs() / 6e4} \u5206\u949F\u65E0\u6D3B\u52A8\uFF0C\u88AB\u5361\u4F4F\u68C0\u6D4B\u81EA\u52A8\u4E2D\u6B62\uFF08\u5E76\u975E\u4F60\u6216\u7528\u6237\u4E3B\u52A8\u53D6\u6D88\uFF09\u3002\u5982\u9700\u7EE7\u7EED\u8BE5\u5DE5\u4F5C\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u5B50\u4EE3\u7406\u4EFB\u52A1\u3002`, { noReply: true }).catch(() => {
              });
            }
          } catch {
          }
          await client.session.abort({ path: { id: sid } }).catch(() => {
          });
          await client.tui.showToast({ body: { message: `\u5B50\u4EE3\u7406\u4F1A\u8BDD ${sid.slice(-8)} \u7591\u4F3C\u5361\u4F4F\uFF08>${stuckTimeoutMs() / 6e4} \u5206\u949F\u65E0\u6D3B\u52A8\uFF09\uFF0C\u5DF2\u81EA\u52A8\u4E2D\u6B62`, variant: "warning" } });
        } else if (!sub) {
          let waiting = false;
          try {
            const mres = await client.session.messages({ path: { id: sid } });
            const msgs = Array.isArray(mres) ? mres : mres.data ?? [];
            const lastAsst = [...msgs].reverse().find((m) => m?.info?.role === "assistant");
            waiting = (lastAsst?.parts ?? []).some((p) => p?.type === "tool" && p?.tool === "task" && p?.state?.status === "running");
          } catch {
          }
          if (waiting) {
            lastActivity.set(sid, Date.now());
            continue;
          }
          await client.tui.showToast({ body: { message: `\u4F1A\u8BDD ${sid.slice(-8)} \u7591\u4F3C\u5361\u4F4F\uFF08>${stuckTimeoutMs() / 6e4} \u5206\u949F\u65E0\u6D3B\u52A8\uFF09\uFF0C\u53EF Esc \u4E2D\u65AD`, variant: "warning" } });
        }
        lastActivity.delete(sid);
      } catch {
        lastActivity.delete(sid);
      }
    }
  };
  const cleanupLockFile = "/tmp/opencode/goal-cleanup.lock";
  const tryAcquireCleanupLock = () => {
    try {
      const now = Date.now();
      const old = read(cleanupLockFile, "0");
      const oldTs = parseInt(old, 10);
      if (Number.isFinite(oldTs) && now - oldTs < 12e4) return false;
      writeFileSync(cleanupLockFile, String(now));
      return true;
    } catch {
      return true;
    }
  };
  const cleanupSubagents = async (manual = false) => {
    if (!tryAcquireCleanupLock()) return { removed: 0, failed: 0, skipped: true };
    const deadline = Date.now() - cleanupMs();
    const maxRetain = maxRetainedSubagents();
    try {
      const res = await client.session.list({});
      const roots = Array.isArray(res) ? res : res.data ?? [];
      const allSubs = [];
      for (const r of roots) {
        if (!r?.id) continue;
        try {
          const cres = await client.session.children({ path: { id: r.id } });
          const kids = Array.isArray(cres) ? cres : cres.data ?? [];
          for (const k of kids) if (k?.id) allSubs.push(k);
        } catch {
        }
      }
      const subOnly = allSubs.filter((s) => !!s?.parentID);
      let statusMap = {};
      try {
        const sres = await client.session.status({});
        const body = Array.isArray(sres) ? sres[0] : sres.data ?? sres;
        if (body && typeof body === "object") statusMap = body;
      } catch {
      }
      const doneStatus = /* @__PURE__ */ new Set();
      const idleSubs = subOnly.filter((s) => statusMap[s.id]?.type === "idle");
      await Promise.all(idleSubs.map(async (s) => {
        try {
          const mres = await client.session.messages({ path: { id: s.id } });
          const msgs = Array.isArray(mres) ? mres : mres.data ?? [];
          const lastAsst = [...msgs].reverse().find((m) => m?.info?.role === "assistant");
          if (!lastAsst?.info) return;
          if (lastAsst.info.error) doneStatus.add(s.id);
          else if (lastAsst.info.time?.completed !== void 0) doneStatus.add(s.id);
        } catch {
        }
      }));
      let removed = 0;
      let failed = 0;
      const failedIds = [];
      const delOne = async (s) => {
        if (!s?.parentID) return;
        try {
          await client.session.delete({ path: { id: s.id } });
          const g = loadGoals();
          if (g[s.id]) {
            delete g[s.id];
            saveGoals(g);
          }
          removed++;
        } catch (e) {
          failed++;
          if (failedIds.length < 5) failedIds.push(s.id);
          console.error(`[goal] \u5220\u9664\u5B50\u4EE3\u7406\u4F1A\u8BDD\u5931\u8D25 ${s.id}:`, e?.message ?? e);
        }
      };
      if (maxRetain > 0 && !manual) {
        const done = subOnly.filter((s) => doneStatus.has(s.id)).sort((a, b) => (a.time?.updated ?? 0) - (b.time?.updated ?? 0));
        const excess = done.length - maxRetain;
        if (excess > 0) {
          for (let i = 0; i < excess; i++) await delOne(done[i]);
        }
      }
      for (const s of subOnly) {
        if (!doneStatus.has(s.id)) continue;
        if (!manual && (s.time?.updated ?? 0) > deadline) continue;
        await delOne(s);
      }
      if (removed > 0 || failed > 0) {
        await client.tui.showToast({ body: { message: `${manual ? "\u624B\u52A8\u6E05\u7406" : "\u81EA\u52A8\u6E05\u7406"}\u5B50\u4EE3\u7406\u4F1A\u8BDD\uFF1A\u6210\u529F ${removed} \u4E2A${failed ? `\uFF0C\u5931\u8D25 ${failed} \u4E2A${failedIds.length ? `\uFF08\u5982 ${failedIds.map((id) => id.slice(-8)).join(",")}\u2026\uFF09` : ""}` : ""}${!manual && maxRetain > 0 ? `\uFF08\u4FDD\u7559\u4E0A\u9650 ${maxRetain} \u4E2A\uFF09` : ""}`, variant: failed > 0 ? "warning" : "info" } }).catch(() => {
        });
      }
      return { removed, failed };
    } catch (e) {
      console.error("[goal] cleanup subagents failed:", e);
      return { removed: 0, failed: 0 };
    }
  };
  const scheduleStuckCheck = async () => {
    const interval = Math.min(6e4, Math.max(5e3, Math.floor(stuckTimeoutMs() / 4)));
    setTimeout(() => {
      scheduleStuckCheck().catch(() => {
      });
    }, interval);
    await cleanupStuck().catch(() => {
    });
  };
  scheduleStuckCheck().catch(() => {
  });
  setInterval(() => {
    cleanupSubagents().catch(() => {
    });
  }, 36e5);
  setTimeout(() => {
    cleanupSubagents().catch(() => {
    });
  }, 6e4);
  return {
    event: async ({ event }) => {
      if (event.type === "message.part.updated") {
        const props = event.properties;
        const sid = props?.sessionID;
        if (sid) lastActivity.set(sid, Date.now());
      }
      if (event.type === "session.idle") {
        const sid = event.properties?.sessionID;
        if (sid) {
          lastActivity.delete(sid);
          const retry = pendingRetryPush.get(sid);
          if (retry && retry.length > 0) {
            pendingRetryPush.delete(sid);
            for (const t of retry) pushPrompt(sid, t).catch(() => {
            });
            lastPushTime.set(sid, Date.now());
          }
          const pend = pendingPushQueue.get(sid);
          if (pend && pend.length > 0) {
            pendingPushQueue.delete(sid);
            for (const t of pend) pushPrompt(sid, t).catch(() => {
            });
            lastPushTime.set(sid, Date.now());
          }
          if (pendingMsgDrive.delete(sid)) {
            setTimeout(() => {
              autoContinue(sid, "msg").catch(() => {
              });
            }, 1200);
          }
          setTimeout(() => autoContinue(sid, "idle"), 1200);
          setTimeout(() => rePushIterating(sid), 1500);
          const sec = pendingSecondaryPush.get(sid);
          if (sec) {
            pendingSecondaryPush.delete(sid);
            pushPrompt(sid, sec).catch(() => {
            });
          }
        }
      }
      if (event.type === "session.error") {
        const props = event.properties;
        const sid = props?.sessionID;
        const name = props?.error?.name;
        if (sid && name === "MessageAbortedError") {
          interrupted.add(sid);
        }
      }
      if (event.type === "message.updated") {
        const info = event.properties?.info;
        if (!info?.sessionID || !info.id) return;
        const sid = info.sessionID;
        if (info.role === "assistant") {
          const completed = info.time?.completed;
          const retry = pendingRetryPush.get(sid);
          if (completed && retry && retry.length > 0) {
            pendingRetryPush.delete(sid);
            for (const t of retry) pushPrompt(sid, t).catch(() => {
            });
            lastPushTime.set(sid, Date.now());
          }
          if (completed && loadGoals()[sid] && Date.now() - (lastPushTime.get(sid) ?? 0) >= pushIntervalMs()) {
            setTimeout(() => {
              autoContinue(sid, "msg").catch(() => {
              });
            }, 1200);
          }
          return;
        }
        if (handled.has(info.id)) return;
        if (info.role !== "user") return;
        const mid = info.id;
        const agent = info.agent;
        setTimeout(async () => {
          try {
            markHandled(mid);
            const res = await client.session.message({ path: { id: sid, messageID: mid } });
            const body = Array.isArray(res) ? res[0] : res.data ?? res;
            const parts = body?.parts ?? body?.info?.parts ?? [];
            if (parts.some((p) => p.synthetic === true)) return;
            const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim();
            if (!text) return;
            try {
              if (await isSubagent(sid)) {
                if (!loadGoals()[sid]) await maybePushSubagentGoalGuide(sid);
              }
            } catch {
            }
            if (text.startsWith("---GOAL-END---")) return;
            if (/^（第 \d+ 轮，上限 /.test(text)) return;
            let goalText = "";
            let forceIterate = false;
            const isGoalIterCmd = /^\/goal-iter(?:\s|$)/.test(text);
            const isGoalCmd = !isGoalIterCmd && /^\/goal(?:\s|$)/.test(text);
            if (isGoalIterCmd || isGoalCmd) {
              const marker = "---GOAL-END---";
              const idx = text.indexOf(marker);
              const goalPart = idx >= 0 ? text.slice(0, idx) : text;
              goalText = goalPart.replace(/^\/goal-iter\s*/, "").replace(/^\/goal\s*/, "").trim();
              forceIterate = isGoalIterCmd;
              if (!goalText) {
                await client.tui.showToast({ body: { message: `${isGoalIterCmd ? "/goal-iter" : "/goal"} \u76EE\u6807\u4E0D\u80FD\u4E3A\u7A7A`, variant: "warning" } });
                return;
              }
            }
            const existing = loadGoals()[sid];
            if (existing && !isGoalCmd && !isGoalIterCmd) {
              if (existing.state === "paused" && agent === "z-goal") {
                const g2 = loadGoals();
                g2[sid].state = "active";
                g2[sid].updatedAt = Date.now();
                saveGoals(g2);
                await client.tui.showToast({ body: { message: "\u5DF2\u6536\u5230\u6F84\u6E05\u56DE\u7B54\uFF0C\u76EE\u6807\u6062\u590D\u63A8\u8FDB", variant: "success" } });
              }
              return;
            }
            if (!isGoalCmd && !isGoalIterCmd) {
              if (agent !== "z-goal") return;
              goalText = text;
            }
            const goals = loadGoals();
            const ts = Date.now();
            await isSubagent(sid);
            goals[sid] = { goal: goalText, state: "active", turns: 0, maxTurns: forceIterate || configIterateMode() ? 0 : currentMaxTurns(), updatedAt: ts, startedAt: existing?.startedAt ?? ts, stages: [], planFile: existing?.planFile ?? `${resolvePlanDir()}/${sid}-${ts}.md`, flow: "explore", ...forceIterate ? { iteration: { count: 0 } } : {} };
            saveGoals(goals);
            interrupted.delete(sid);
            lastPushedMsg.delete(sid);
            lastPushTime.delete(sid);
            iterAskedForRound.delete(sid);
            await client.tui.showToast({ body: { message: isGoalCmd || isGoalIterCmd ? `\u76EE\u6807\u5DF2\u8BBE\u7F6E/\u66F4\u65B0${forceIterate ? "\uFF08\u4E34\u65F6\u8FED\u4EE3\u6A21\u5F0F\uFF09" : ""}\uFF0C\u5F00\u59CB\u81EA\u4E3B\u63A8\u8FDB` : "\u76EE\u6807\u5DF2\u81EA\u52A8\u8BBE\u7F6E\uFF0C\u5F00\u59CB\u81EA\u4E3B\u63A8\u8FDB", variant: "success" } });
            pushFirstRound(sid);
          } catch (e) {
            console.error("[goal] auto set failed:", e);
          }
        }, 300);
      }
    },
    tool: {
      goal: tool({
        description: "\u76EE\u6807\u63A8\u8FDB\u7BA1\u7406\uFF08 /goal \u98CE\u683C\uFF0C\u6309\u4F1A\u8BDD\u9694\u79BB\uFF09\uFF1A\u6BCF\u4E2A\u4F1A\u8BDD\u72EC\u7ACB\u76EE\u6807\uFF0C\u652F\u6301\u9636\u6BB5\u4E0E\u4EE3\u529E\u3002\u8BBE\u7F6E\u540E\u63D2\u4EF6\u6BCF\u8F6E\u81EA\u52A8\u53D1\u9001\u300C\u76EE\u6807+\u9636\u6BB5\u603B\u89C8+\u4EE3\u529E\u300D\u76F4\u5230\u5B8C\u6210\u3001\u6682\u505C\u6216\u8FBE\u8F6E\u6570\u4E0A\u9650\u3002\u8C03\u7528\u65F6\u673A\uFF1A\u7528\u6237\u8981\u6C42\u6301\u7EED\u5DE5\u4F5C\u76F4\u5230\u5B8C\u6210/\u4FEE\u5230\u5168\u7EFF/\u6301\u7EED\u63A8\u8FDB\u65F6\u5148 set\uFF1B**\u6D41\u7A0B\u5207\u6362\u7528 flow\uFF08explore\u2192plan\u2192execute\u2192audit\uFF0C\u63A2\u7D22/\u89C4\u5212\u4E2D\u53D1\u73B0\u4FE1\u606F\u4E0D\u8DB3\u53EF\u56DE explore\uFF09**\uFF1B\u9636\u6BB5\u6D41\u8F6C\u7528 stage\uFF1B\u9636\u6BB5\u6574\u4F53\u4FEE\u6539\u7528 update_stages\uFF1B**\u5F53\u524D\u9636\u6BB5\u4EE3\u529E\u7528 todos**\uFF1B**\u5168\u90E8\u5DE5\u4F5C\u5B8C\u6210\u5E76\u5BA1\u8BA1\u901A\u8FC7\u540E\uFF0C\u6700\u540E\u4E00\u6B65\u5FC5\u987B\u8C03\u7528 audit \u7ED3\u675F\u63A8\u8FDB**\uFF1B\u6682\u505C\u3001\u6062\u590D\u3001\u67E5\u770B\u8FDB\u5EA6\u3001\u53D6\u6D88\u5206\u522B\u5BF9\u5E94 pause/resume/status/clear\uFF1B\u624B\u52A8\u6E05\u7406\u5DF2\u5B8C\u6210/\u5DF2\u5931\u8D25\u5B50\u4EE3\u7406\u4F1A\u8BDD\u7528 cleanup\uFF08\u4E0D\u53D7\u6E05\u7406\u5929\u6570\u9650\u5236\uFF09\u3002\u8FED\u4EE3\u6A21\u5F0F\uFF08config iterateMode \u5F00\u542F\uFF09\uFF1Aaudit \u540E\u4E0D\u5220\u76EE\u6807\uFF0C\u63D2\u4EF6\u5728\u672C\u8F6E\u7ED3\u675F\u540E\u63A8\u9001\u3010\u8FED\u4EE3\u7EE7\u7EED\u3011\u6307\u4EE4\uFF08goal \u5DE5\u5177 action=iterate \u7EE7\u7EED\u4E0B\u4E00\u8F6E / finish \u7ED3\u675F\u6536\u5C3E\uFF09\u3002",
        args: {
          action: tool.schema.string().describe("\u64CD\u4F5C\uFF1Aset \u8BBE\u7F6E\u76EE\u6807 / flow \u5207\u6362\u5F53\u524D\u6D41\u7A0B\uFF08explore/plan/execute/audit\uFF0C\u89C4\u5212\u4E2D\u53D1\u73B0\u4E0D\u8DB3\u53EF\u56DE explore\uFF09/ update_stages \u6574\u4F53\u66FF\u6362\u9636\u6BB5 / stage \u66F4\u65B0\u9636\u6BB5\u72B6\u6001\uFF08\u652F\u6301 updates \u6279\u91CF\uFF09/ todos \u66F4\u65B0\u5F53\u524D\u9636\u6BB5\u4EE3\u529E\u6E05\u5355 / audit \u5BA1\u8BA1\uFF08\u8FED\u4EE3\u6A21\u5F0F\u4E0B\u4E0D\u5220\u76EE\u6807\uFF0C\u63D2\u4EF6\u63A8\u9001\u3010\u8FED\u4EE3\u7EE7\u7EED\u3011\u6307\u4EE4\uFF09/ iterate \u8BBE\u7F6E\u4E0B\u4E00\u8F6E\u8FED\u4EE3\u76EE\u6807 / finish \u8FED\u4EE3\u7ED3\u675F\u6536\u5C3E / status \u67E5\u770B\u8FDB\u5EA6 / pause \u6682\u505C / resume \u6062\u590D / clear \u6E05\u9664 / cleanup \u624B\u52A8\u6E05\u7406\u5DF2\u5B8C\u6210\u5DF2\u5931\u8D25\u5B50\u4EE3\u7406\uFF08\u4E0D\u53D7\u5929\u6570\u9650\u5236\uFF09"),
          goal: tool.schema.string().optional().describe("\u76EE\u6807\u63CF\u8FF0\uFF08action=set / iterate \u5FC5\u586B\uFF09"),
          direction: tool.schema.string().optional().describe("\u8FED\u4EE3\u65B9\u5411\uFF08action=iterate \u53EF\u9009\uFF0C\u7F3A\u7701\u6CBF\u7528\u4E0A\u6B21\u8FED\u4EE3\u65B9\u5411\u6216 goal\uFF09"),
          stageID: tool.schema.string().optional().describe("\u9636\u6BB5 id\uFF08action=stage \u5355\u4E2A\u66F4\u65B0\u65F6\u5FC5\u586B\uFF1Baction=todos \u53EF\u9009\uFF0C\u7F3A\u7701=\u5F53\u524D in_progress \u9636\u6BB5\uFF0C\u6307\u5B9A\u540E\u53EF\u66F4\u65B0\u4EFB\u610F\u9636\u6BB5\u4EE3\u529E\uFF0C\u5982\u8865\u5145\u5176\u4ED6\u9636\u6BB5\u4EE3\u529E\uFF09"),
          stageStatus: tool.schema.string().optional().describe("\u9636\u6BB5\u72B6\u6001\uFF1Ain_progress/completed/pending\uFF08action=stage\uFF0C\u5355\u4E2A\u66F4\u65B0\u65F6\u5FC5\u586B\uFF09"),
          updates: tool.schema.string().optional().describe('\u6279\u91CF\u66F4\u65B0\u9636\u6BB5\u72B6\u6001 JSON\uFF08action=stage\uFF0C\u4E0E stageID \u4E8C\u9009\u4E00\uFF09\uFF1A[{"id":"s1","status":"completed"},{"id":"s2","status":"completed"}]\uFF0C\u4E00\u6B21\u6807\u8BB0\u591A\u4E2A\u9636\u6BB5\u5B8C\u6210'),
          stages: tool.schema.string().optional().describe("\u9636\u6BB5\u5217\u8868 JSON\uFF08action=update_stages \u5FC5\u586B\uFF09"),
          flow: tool.schema.string().optional().describe("\u5F53\u524D\u6D41\u7A0B\uFF08action=flow \u5FC5\u586B\uFF09\uFF1Aexplore \u63A2\u7D22 / plan \u89C4\u5212 / execute \u6267\u884C / audit \u5BA1\u8BA1\uFF1B\u89C4\u5212\u4E2D\u53D1\u73B0\u4FE1\u606F\u4E0D\u8DB3\u53EF\u7528 flow=explore \u56DE\u63A2\u7D22"),
          todos: tool.schema.string().optional().describe('\u5F53\u524D\u9636\u6BB5\u4EE3\u529E\u6E05\u5355 JSON\uFF08action=todos \u5FC5\u586B\uFF09\uFF1A[{"content":"...","status":"pending"},\u2026]')
        },
        async execute(args, context) {
          const sid = context.sessionID;
          try {
            const goals = loadGoals();
            const action = args.action ?? "";
            const finishGoal = (e, kind) => {
              const snap = buildSnap(e);
              const planText = e.planFile ? (() => {
                try {
                  const t = readFileSync(e.planFile, "utf8").trim();
                  return t || "";
                } catch {
                  return "";
                }
              })() : "";
              const deleting = configAuditDelete();
              if (deleting) delete goals[sid];
              else {
                e.state = "done";
                e.updatedAt = Date.now();
              }
              lastPushedMsg.delete(sid);
              lastPushTime.delete(sid);
              saveGoals(goals);
              const text = `\u3010\u4E8C\u6B21\u5BA1\u8BA1\u3011${kind === "finish" ? "\u8FED\u4EE3\u5DF2\u7ED3\u675F" : "\u76EE\u6807\u5DF2\u63D0\u4EA4\u5BA1\u8BA1"}\uFF0C${deleting ? "\u5E76\u6E05\u7406" : "\uFF08\u5DF2\u4FDD\u7559\uFF09"}\u3002\u8BF7\u505A\u6700\u7EC8\u5B8C\u6210\u5EA6\u786E\u8BA4\uFF1A\u2460 \u76EE\u6807\u9A8C\u6536\u70B9\u662F\u5426\u5168\u90E8\u8FBE\u6210 \u2461 \u6709\u65E0\u9057\u6F0F\u672A\u5B8C\u6210\u4E8B\u9879 \u2462 \u662F\u5426\u53EF\u786E\u8BA4\u6536\u5C3E\u3002**\u786E\u8BA4\u901A\u8FC7\u5373\u5B8C\u6210\uFF1B\u5982\u53D1\u73B0\u9057\u6F0F\u672A\u5B8C\u6210\uFF0C\u8BF7\u7528 goal \u5DE5\u5177\uFF08action=set\uFF09\u91CD\u65B0\u8BBE\u7F6E\u539F\u76EE\u6807\uFF08\u5B8C\u5B8C\u6574\u6574\u539F\u8BDD\uFF09\u540E\u7EE7\u7EED\u63A8\u8FDB\u3002**

\u3010\u5BA1\u8BA1\u5FEB\u7167\u3011
${snap.join("\n")}${planText ? `

\u3010\u65B9\u6848\u6587\u6863\u3011
${planText}` : ""}`;
              pendingSecondaryPush.set(sid, text);
              return deleting;
            };
            switch (action) {
              case "set": {
                const g = (args.goal ?? "").trim();
                if (!g) return "\u7F3A\u5C11\u76EE\u6807\u63CF\u8FF0\uFF0C\u8BF7\u63D0\u4F9B goal \u53C2\u6570";
                const max = currentMaxTurns();
                const prev = goals[sid];
                await isSubagent(sid);
                goals[sid] = { goal: g, state: "active", turns: 0, maxTurns: configIterateMode() && isSubagentCache.get(sid) !== true ? 0 : max, updatedAt: Date.now(), startedAt: prev?.startedAt ?? Date.now(), stages: [], planFile: prev?.planFile ?? `${resolvePlanDir()}/${sid}-${Date.now()}.md`, flow: "explore" };
                saveGoals(goals);
                interrupted.delete(sid);
                lastPushedMsg.delete(sid);
                lastPushTime.delete(sid);
                pendingSecondaryPush.delete(sid);
                pendingPushQueue.delete(sid);
                pendingMsgDrive.delete(sid);
                pendingRetryPush.delete(sid);
                iterAskedForRound.delete(sid);
                await client.tui.showToast({ body: { message: "\u76EE\u6807\u5DF2\u8BBE\u7F6E\uFF0C\u5F00\u59CB\u81EA\u4E3B\u63A8\u8FDB", variant: "success" } });
                pushFirstRound(sid);
                return `\u76EE\u6807\u5DF2\u8BBE\u7F6E\uFF1A${g}\uFF08\u4E0A\u9650 ${max > 0 ? `${max} \u8F6E` : "\u4E0D\u9650"}\uFF0C\u4EC5\u672C\u4F1A\u8BDD\u81EA\u52A8\u63A8\u8FDB\uFF09\u3002\u8BF7\u89C4\u5212\u76EE\u6807\u9636\u6BB5\uFF08goal \u5DE5\u5177 action=update_stages\uFF09\u3002\u5168\u90E8\u5B8C\u6210\u540E\u6700\u540E\u4E00\u6B65\u8C03\u7528 goal \u5DE5\u5177 action=audit \u7ED3\u675F\u63A8\u8FDB\u3002`;
              }
              case "stage": {
                const e = goals[sid];
                if (!e) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807";
                if (args.updates) {
                  let arr;
                  try {
                    const raw = args.updates;
                    const parsed = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : (() => {
                      throw new Error("not string or array");
                    })();
                    if (!Array.isArray(parsed)) throw new Error("not array");
                    arr = parsed;
                  } catch {
                    return 'updates \u53C2\u6570\u5FC5\u987B\u662F\u6570\u7EC4\uFF1A[{"id":"s1","status":"completed"},\u2026]';
                  }
                  const done = [];
                  const VALID = ["pending", "in_progress", "completed"];
                  for (const u of arr) {
                    if (!u?.id || !u?.status) return "updates \u6BCF\u9879\u9700\u542B id \u4E0E status";
                    if (!VALID.includes(u.status)) return `\u975E\u6CD5\u9636\u6BB5\u72B6\u6001\uFF1A${u.status}\uFF08\u53EF\u7528 pending/in_progress/completed\uFF09`;
                    const stage2 = (e.stages ?? []).find((s) => s.id === u.id);
                    if (!stage2) return `\u627E\u4E0D\u5230\u9636\u6BB5 ${u.id}`;
                    stage2.status = u.status;
                    const auto2 = u.status === "completed" ? autoCompleteDoneTodos(stage2) : 0;
                    done.push(`${stage2.name}\u2192${u.status}${auto2 ? `\uFF08\u81EA\u52A8\u6253\u52FE ${auto2} \u6761\u672A\u5B8C\u6210\u4EE3\u529E\uFF09` : ""}`);
                  }
                  saveGoals(goals);
                  return `\u9636\u6BB5\u6279\u91CF\u66F4\u65B0\u5B8C\u6210\uFF1A${done.join("\uFF1B")}`;
                }
                const id = args.stageID ?? "";
                const st = args.stageStatus ?? "";
                if (!id || !st) return "\u7F3A\u5C11 stageID+stageStatus\uFF0C\u6216\u7528 updates \u6279\u91CF\u66F4\u65B0";
                if (!["pending", "in_progress", "completed"].includes(st)) return `\u975E\u6CD5\u9636\u6BB5\u72B6\u6001\uFF1A${st}\uFF08\u53EF\u7528 pending/in_progress/completed\uFF09`;
                const stage = (e.stages ?? []).find((s) => s.id === id);
                if (!stage) return `\u627E\u4E0D\u5230\u9636\u6BB5 ${id}\uFF08\u5F53\u524D\u9636\u6BB5\uFF1A${(e.stages ?? []).map((s) => s.id).join(",") || "\u65E0"}\uFF09`;
                stage.status = st;
                const auto = st === "completed" ? autoCompleteDoneTodos(stage) : 0;
                saveGoals(goals);
                return `\u9636\u6BB5\u300C${stage.name}\u300D\u72B6\u6001\u5DF2\u66F4\u65B0\u4E3A ${st}${auto ? `\uFF08\u81EA\u52A8\u6253\u52FE ${auto} \u6761\u672A\u5B8C\u6210\u4EE3\u529E\uFF09` : ""}`;
              }
              case "update_stages": {
                const e = goals[sid];
                if (!e) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807";
                let arr = [];
                try {
                  const raw = args.stages ?? "[]";
                  const parsed = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : (() => {
                    throw new Error("not string or array");
                  })();
                  if (!Array.isArray(parsed)) throw new Error("not array");
                  arr = parsed.map((s) => {
                    if (!s.name && s.content) s.name = s.content;
                    return { id: String(s.id ?? ""), name: String(s.name ?? ""), status: String(s.status ?? "pending"), ...Array.isArray(s.todos) ? { todos: normalizeTodos(s.todos) } : {} };
                  }).filter((s) => s.id && s.name);
                } catch {
                  return 'stages \u53C2\u6570\u5FC5\u987B\u662F\u9636\u6BB5 JSON \u6570\u7EC4\uFF1A[{"id":"s1","name":"\u9636\u6BB5\u540D","status":"pending"},\u2026]';
                }
                e.stages = arr;
                saveGoals(goals);
                const emptyStages = arr.filter((s) => (s.todos ?? []).length === 0).map((s) => s.name);
                return `\u9636\u6BB5\u5217\u8868\u5DF2\u66F4\u65B0\uFF08\u5171 ${arr.length} \u4E2A\u9636\u6BB5\uFF09${emptyStages.length ? `
\u63D0\u793A\uFF1A\u9636\u6BB5 ${emptyStages.join("\u3001")} \u65E0\u4EE3\u529E\uFF08\u4E00\u6B21\u5168\u5199\u89C4\u5219\u4E0B\u5EFA\u8BAE\u6BCF\u9636\u6BB5 \u22651 \u6761\uFF09` : ""}`;
              }
              case "todos": {
                const e = goals[sid];
                if (!e) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807";
                const stages = e.stages ?? [];
                const target = args.stageID ? stages.find((s) => s.id === args.stageID) : stages.find((s) => s.status === "in_progress");
                if (!target) return args.stageID ? `\u627E\u4E0D\u5230\u9636\u6BB5 ${args.stageID}\uFF08\u73B0\u6709\u9636\u6BB5\uFF1A${stages.map((s) => s.id).join(",") || "\u65E0"}\uFF09` : "\u6CA1\u6709\u5F53\u524D\u9636\u6BB5\uFF08\u65E0 in_progress \u9636\u6BB5\uFF09\uFF0C\u8BF7\u5148\u7528 update_stages \u89C4\u5212\u9636\u6BB5\uFF0C\u6216\u4F20 stageID \u6307\u5B9A\u9636\u6BB5";
                let arr = [];
                try {
                  const raw = args.todos ?? "[]";
                  if (typeof raw === "string") {
                    arr = JSON.parse(raw);
                  } else if (Array.isArray(raw)) {
                    arr = raw;
                  } else {
                    throw new Error("not string or array");
                  }
                  if (!Array.isArray(arr)) throw new Error("not array");
                } catch {
                  return `todos \u53C2\u6570\u89E3\u6790\u5931\u8D25\uFF08\u6536\u5230\uFF1A${String(args.todos ?? "").slice(0, 120)}\uFF09\u3002\u8BF7\u7528 JSON \u6570\u7EC4\uFF1A[{"content":"xxx","status":"pending"}]\uFF0C\u6216 [{"content":"xxx","status":"completed"}]`;
                }
                target.todos = arr.map((t) => {
                  const o = t ?? {};
                  return {
                    content: String(o.content ?? ""),
                    status: ["pending", "in_progress", "completed"].includes(String(o.status)) ? String(o.status) : "pending",
                    // M5：非法状态兜底为 pending
                    priority: o.priority !== void 0 ? String(o.priority) : void 0
                  };
                }).filter((t) => t.content);
                saveGoals(goals);
                return `\u9636\u6BB5\u300C${target.name}\u300D\u4EE3\u529E\u5DF2\u66F4\u65B0\uFF08\u5171 ${target.todos.length} \u6761${args.stageID ? `\uFF0C\u6307\u5B9A\u9636\u6BB5 ${args.stageID}` : ""}\uFF09`;
              }
              case "audit": {
                const e = goals[sid];
                if (!e) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807";
                if (e.state === "iterating") return "\u672C\u8F6E\u8FED\u4EE3\u5DF2\u5B8C\u6210\uFF0C\u7B49\u5F85 iterate \u7EE7\u7EED\u6216 finish \u7ED3\u675F\uFF08\u65E0\u9700\u91CD\u590D\u5BA1\u8BA1\uFF09";
                if (e.state === "done") return "\u76EE\u6807\u5DF2\u5B8C\u6210\uFF08done\uFF09\uFF0C\u65E0\u9700\u91CD\u590D\u5BA1\u8BA1";
                if (configIterateMode() || e.iteration) {
                  if (configIterateMode() && !e.iteration && await isSubagent(sid)) {
                    const deleting2 = finishGoal(e, "audit");
                    await client.tui.showToast({ body: { message: `\u76EE\u6807\u5B8C\u6210\uFF1A\u5BA1\u8BA1\u901A\u8FC7${deleting2 ? "\u5E76\u6E05\u7406" : "\uFF08\u5DF2\u4FDD\u7559\uFF09"}`, variant: "success" } });
                    return `\u5BA1\u8BA1\u901A\u8FC7\uFF0C\u76EE\u6807\u5DF2${deleting2 ? "\u6E05\u7406" : "\u6807\u8BB0\u5B8C\u6210\u4FDD\u7559"}\uFF0C\u63A8\u8FDB\u5DF2\u505C\u6B62\u3002`;
                  }
                  const count = e.iteration?.count ?? 0;
                  const maxRounds = configIterateMaxRounds();
                  const isLast = maxRounds > 0 && count + 1 >= maxRounds;
                  e.state = "iterating";
                  e.updatedAt = Date.now();
                  saveGoals(goals);
                  await client.tui.showToast({ body: { message: `\u76EE\u6807\u5B8C\u6210\uFF1A\u8FED\u4EE3\u6A21\u5F0F\u7B2C ${count + 1} \u8F6E\u5B8C\u6210${isLast ? `\uFF08\u5DF2\u8FBE\u8FED\u4EE3\u4E0A\u9650 ${maxRounds} \u8F6E\uFF0C\u8BF7 finish \u7ED3\u675F\uFF09` : "\uFF0C\u5DF2\u63A8\u9001\u7EE7\u7EED\u6307\u4EE4"}`, variant: "success" } });
                  setTimeout(() => {
                    rePushIterating(sid).catch(() => {
                    });
                  }, 2e3);
                  return isLast ? `\u7B2C ${count + 1} \u8F6E\u8FED\u4EE3\u5B8C\u6210\uFF08\u5DF2\u8FBE\u8FED\u4EE3\u4E0A\u9650 ${maxRounds} \u8F6E\uFF0C\u672C\u8F6E\u4E3A\u6700\u540E\u4E00\u8F6E\uFF09\uFF0C\u8FED\u4EE3\u7ED3\u675F\u3002\u8BF7\u8C03\u7528 goal \u5DE5\u5177 action=finish \u7ED3\u675F\u6536\u5C3E\u3002` : `\u7B2C ${count + 1} \u8F6E\u8FED\u4EE3\u5B8C\u6210\uFF0C\u63A8\u8FDB\u8FDB\u5165 iterating\uFF0C\u672C\u8F6E\u7ED3\u675F\u540E\u63D2\u4EF6\u63A8\u9001\u3010\u8FED\u4EE3\u7EE7\u7EED\u3011\u6307\u4EE4\uFF0CAI \u8C03\u7528 iterate \u7EE7\u7EED\u3002`;
                }
                const deleting = finishGoal(e, "audit");
                await client.tui.showToast({ body: { message: `\u76EE\u6807\u5B8C\u6210\uFF1A\u5BA1\u8BA1\u901A\u8FC7${deleting ? "\u5E76\u6E05\u7406" : "\uFF08\u5DF2\u4FDD\u7559\uFF09"}`, variant: "success" } });
                return `\u5BA1\u8BA1\u901A\u8FC7\uFF0C\u76EE\u6807\u5DF2${deleting ? "\u6E05\u7406" : "\u6807\u8BB0\u5B8C\u6210\u4FDD\u7559"}\uFF0C\u63A8\u8FDB\u5DF2\u505C\u6B62\u3002`;
              }
              case "iterate": {
                const g = (args.goal ?? "").trim();
                if (!g) return "\u7F3A\u5C11\u8FED\u4EE3\u76EE\u6807\uFF0C\u8BF7\u63D0\u4F9B goal \u53C2\u6570\uFF08\u8FED\u4EE3\u65B9\u5411\u539F\u8BDD\uFF09";
                const prev = goals[sid];
                if (!prev) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807\uFF0C\u65E0\u6CD5\u8FED\u4EE3\uFF08\u8FED\u4EE3\u6A21\u5F0F\u9700\u7528\u6237\u901A\u8FC7 /goal-iter \u547D\u4EE4\u6216 config iterateMode \u5F00\u542F\uFF0CAI \u4E0D\u80FD\u4E3B\u52A8\u5F00\u542F\uFF09";
                if (prev.state !== "iterating" && prev.state !== "paused" && prev.state !== "limited") {
                  return `\u5F53\u524D\u72B6\u6001 ${prev.state} \u4E0D\u662F\u8FED\u4EE3\u7B49\u5F85\uFF0C\u65E0\u9700 iterate\uFF08\u4EC5 iterating/paused/limited \u53EF\u8FED\u4EE3\uFF09`;
                }
                if (!configIterateMode() && !prev.iteration) {
                  return "\u5F53\u524D\u76EE\u6807\u4E0D\u662F\u8FED\u4EE3\u6A21\u5F0F\uFF08\u9700\u7528\u6237\u901A\u8FC7 /goal-iter \u547D\u4EE4\u6216 config iterateMode \u5F00\u542F\uFF09\uFF0CAI \u4E0D\u80FD\u4E3B\u52A8\u5F00\u542F\u8FED\u4EE3";
                }
                if (await isSubagent(sid)) {
                  return "\u5B50\u4EE3\u7406\u76EE\u6807\u6309\u6B63\u5E38\u76EE\u6807\u6A21\u5F0F\u63A8\u8FDB\uFF0C\u4E0D\u652F\u6301\u8FED\u4EE3\uFF08\u8FED\u4EE3\u4EC5\u4E3B\u4EE3\u7406\u53EF\u7528\uFF0C\u7531\u7528\u6237 /goal-iter \u6216 config iterateMode \u5F00\u542F\uFF09";
                }
                const maxRounds = configIterateMaxRounds();
                const nextCount = (prev?.iteration?.count ?? 0) + 1;
                if (maxRounds > 0 && nextCount > maxRounds) {
                  return `\u5DF2\u8FBE\u8FED\u4EE3\u8F6E\u6570\u4E0A\u9650 ${maxRounds} \u8F6E\uFF0C\u8BF7\u8C03\u7528 goal \u5DE5\u5177 action=finish \u7ED3\u675F\u8FED\u4EE3`;
                }
                const it = { count: nextCount, direction: String(args.direction ?? prev?.iteration?.direction ?? g) };
                const pdir = resolvePlanDir();
                mkdirSync(pdir, { recursive: true });
                const history = [
                  ...prev?.history ?? [],
                  ...prev ? [{
                    goal: prev.goal,
                    count: prev.iteration?.count ?? 0,
                    direction: prev.iteration?.direction,
                    time: prev.updatedAt,
                    stages: prev.stages,
                    planFile: prev.planFile,
                    state: "done",
                    flow: prev.flow,
                    turns: prev.turns,
                    maxTurns: prev.maxTurns
                  }] : []
                ];
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
                  history
                };
                saveGoals(goals);
                interrupted.delete(sid);
                lastPushedMsg.delete(sid);
                lastPushTime.delete(sid);
                iterAskedForRound.delete(sid);
                await client.tui.showToast({ body: { message: `\u7B2C ${it.count + 1} \u8F6E\u8FED\u4EE3\u5DF2\u5F00\u59CB`, variant: "success" } });
                pushFirstRound(sid);
                return `\u7B2C ${it.count + 1} \u8F6E\u8FED\u4EE3\u76EE\u6807\u5DF2\u8BBE\u7F6E\uFF1A${g}\uFF08\u65B9\u5411\uFF1A${it.direction}\uFF09\u3002\u8BF7\u89C4\u5212\u9636\u6BB5\uFF08update_stages\uFF09\u5E76\u63A8\u8FDB\uFF1B\u5B8C\u6210\u540E\u518D audit\u3002`;
              }
              case "finish": {
                const e = goals[sid];
                if (!e) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807";
                if (!configIterateMode() && !e.iteration) {
                  return "\u672C\u76EE\u6807\u4E0D\u662F\u8FED\u4EE3\u6A21\u5F0F\uFF0C\u8BF7\u7528 goal \u5DE5\u5177 action=audit \u6536\u5C3E\uFF08finish \u4EC5\u7528\u4E8E\u8FED\u4EE3\u7ED3\u675F\uFF09";
                }
                if (e.state !== "iterating") {
                  return `\u5F53\u524D\u72B6\u6001 ${e.state} \u4E0D\u662F\u8FED\u4EE3\u7B49\u5F85\uFF08iterating\uFF09\uFF0C\u65E0\u6CD5 finish\u2014\u2014\u9700\u5148 audit \u5B8C\u6210\u672C\u8F6E\u8FED\u4EE3\u540E\u8FDB\u5165 iterating \u624D\u80FD\u7ED3\u675F`;
                }
                const deleting = finishGoal(e, "finish");
                await client.tui.showToast({ body: { message: `\u8FED\u4EE3\u7ED3\u675F\uFF1A\u5BA1\u8BA1\u901A\u8FC7${deleting ? "\u5E76\u6E05\u7406" : "\uFF08\u5DF2\u4FDD\u7559\uFF09"}`, variant: "success" } });
                return `\u8FED\u4EE3\u7ED3\u675F\uFF0C\u76EE\u6807\u5DF2${deleting ? "\u6E05\u7406" : "\u6807\u8BB0\u5B8C\u6210\u4FDD\u7559"}\uFF0C\u63A8\u8FDB\u5DF2\u505C\u6B62\u3002`;
              }
              case "status": {
                const e = goals[sid];
                if (!e) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807";
                const lines = [`\u72B6\u6001=${e.state} \u6D41\u7A0B=${e.flow ?? "explore"} \u8F6E\u6570=${e.turns}/${e.maxTurns > 0 ? e.maxTurns : "\u4E0D\u9650"}${e.iteration || configIterateMode() ? ` \u8FED\u4EE3=${(e.iteration?.count ?? 0) + 1}/${configIterateMaxRounds() > 0 ? configIterateMaxRounds() : "\u4E0D\u9650"}${e.iteration?.direction ? ` \u65B9\u5411=${e.iteration.direction}` : ""}` : ""} \u76EE\u6807=${e.goal}`];
                for (const h of e.history ?? []) lines.push(`  \u8FED\u4EE3\u5386\u53F2 \u7B2C${h.count + 1}\u8F6E\uFF1A${h.goal.slice(0, 60)}${h.direction ? `\uFF08\u65B9\u5411\uFF1A${h.direction.slice(0, 40)}\uFF09` : ""}`);
                for (const s of e.stages ?? []) {
                  lines.push(`  ${s.status === "in_progress" ? "\u25B6" : s.status === "completed" ? "\u2713" : "\u25CB"} ${s.name ?? s.content ?? ""} (${s.status})`);
                  for (const t of s.todos ?? []) lines.push(`      ${t.status === "in_progress" ? "\u25B6" : t.status === "completed" ? "\u2713" : "\u25CB"} [${t.status}] ${t.content}`);
                }
                return lines.join("\n");
              }
              case "pause":
                if (!goals[sid]) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807";
                goals[sid].state = "paused";
                saveGoals(goals);
                return "\u76EE\u6807\u5DF2\u6682\u505C\uFF0C\u4E0D\u518D\u81EA\u52A8\u7EE7\u7EED\uFF08\u53EF\u8C03\u7528 goal resume \u6062\u590D\uFF09";
              case "resume":
                if (!goals[sid]) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807";
                if (goals[sid].state === "paused") {
                  goals[sid].state = "active";
                  goals[sid].updatedAt = Date.now();
                  saveGoals(goals);
                  interrupted.delete(sid);
                  return `\u76EE\u6807\u5DF2\u6062\u590D\uFF0C\u7EE7\u7EED\u63A8\u8FDB\uFF08\u5F53\u524D\u7B2C ${goals[sid].turns} \u8F6E\uFF09`;
                }
                if (goals[sid].state === "limited") {
                  return `\u5DF2\u8FBE\u8F6E\u6570\u4E0A\u9650\uFF08${goals[sid].maxTurns} \u8F6E\uFF09\uFF0C\u76EE\u6807\u505C\u6B62\u63A8\u8FDB\u65E0\u6CD5\u6062\u590D\uFF1B\u5982\u9700\u7EE7\u7EED\u8BF7\u7528 /goal \u91CD\u65B0\u8BBE\u7F6E\u76EE\u6807`;
                }
                if (goals[sid].state === "iterating") {
                  goals[sid].state = "active";
                  goals[sid].updatedAt = Date.now();
                  saveGoals(goals);
                  interrupted.delete(sid);
                  return "\u8FED\u4EE3\u7B49\u5F85\u5DF2\u6062\u590D\u63A8\u8FDB\uFF08iterating\u2192active\uFF09\uFF0C\u7EE7\u7EED\u6309\u5F53\u524D\u76EE\u6807\u63A8\u8FDB\uFF0C\u5B8C\u6210\u540E\u53EF\u518D audit\u3002";
                }
                return `\u5F53\u524D\u72B6\u6001 ${goals[sid].state}\uFF0C\u65E0\u9700\u6062\u590D`;
              case "clear": {
                if (!goals[sid]) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807";
                delete goals[sid];
                lastPushedMsg.delete(sid);
                lastPushTime.delete(sid);
                pendingSecondaryPush.delete(sid);
                pendingPushQueue.delete(sid);
                pendingMsgDrive.delete(sid);
                pendingRetryPush.delete(sid);
                pendingRetryPush.delete(sid);
                saveGoals(goals);
                return "\u672C\u4F1A\u8BDD\u76EE\u6807\u5DF2\u6E05\u9664";
              }
              case "cleanup": {
                const r = await cleanupSubagents(true);
                if (r.skipped) return "2 \u5206\u949F\u5185\u5DF2\u6709\u5B50\u4EE3\u7406\u6E05\u7406\u5728\u6267\u884C\uFF0C\u672C\u6B21\u8DF3\u8FC7\uFF08\u7A0D\u540E\u91CD\u8BD5\uFF09";
                return `\u624B\u52A8\u6E05\u7406\u5B8C\u6210\uFF1A\u5220\u9664\u5DF2\u5B8C\u6210/\u5DF2\u5931\u8D25\u5B50\u4EE3\u7406 ${r.removed} \u4E2A\uFF08\u4E0D\u53D7\u6E05\u7406\u5929\u6570\u9650\u5236\uFF09${r.failed ? `\uFF0C\u5931\u8D25 ${r.failed} \u4E2A` : ""}\u3002\u8FDB\u884C\u4E2D/\u91CD\u8BD5/\u672A\u5B8C\u6210\u4F1A\u8BDD\u4E00\u5F8B\u4FDD\u7559\u3002`;
              }
              case "flow": {
                if (!goals[sid]) return "\u672C\u4F1A\u8BDD\u6CA1\u6709\u76EE\u6807";
                if (goals[sid].state !== "active") return `\u76EE\u6807\u672A\u8FDB\u884C\u4E2D\uFF08\u5F53\u524D ${goals[sid].state}\uFF09\uFF0C\u65E0\u6CD5\u5207\u6362\u6D41\u7A0B`;
                const f = String(args.flow ?? "");
                if (f !== "explore" && f !== "plan" && f !== "execute" && f !== "audit") {
                  return `flow \u53C2\u6570\u65E0\u6548\uFF1A${f}\uFF08\u53EF\u7528 explore/plan/execute/audit\uFF09`;
                }
                goals[sid].flow = f;
                goals[sid].updatedAt = Date.now();
                saveGoals(goals);
                const fe = goals[sid];
                pushPrompt(sid, buildPrompt(fe, fe.turns, sid)).catch(() => {
                });
                lastPushTime.set(sid, Date.now());
                return `\u5F53\u524D\u6D41\u7A0B\u5DF2\u5207\u6362\u4E3A\uFF1A${f}\uFF08\u5C06\u7B49\u5F85\u5F53\u524D\u56DE\u5408\u5B8C\u6210\u540E\u63A8\u9001\u65B0\u6D41\u7A0B\u63D0\u9192\uFF09`;
              }
              default:
                return `\u672A\u77E5 action\uFF1A${action}\uFF08\u53EF\u7528 set/stage/update_stages/todos/audit/iterate/finish/status/pause/resume/clear/cleanup/flow\uFF09`;
            }
          } catch (e) {
            console.error("[goal] execute error:", e);
            return `goal \u5DE5\u5177\u6267\u884C\u5F02\u5E38\uFF1A${e instanceof Error ? e.message : String(e)}\u3002\u76EE\u6807\u72B6\u6001\u672A\u53D8\u66F4\uFF08goals.json \u5E76\u53D1\u5199\u51B2\u7A81\uFF1F\u8BF7\u91CD\u8BD5\u4E00\u6B21\uFF09`;
          }
        }
      })
    }
  };
};
var plugin = {
  id: "opencode-goal",
  server: GoalPlugin
};
var index_default = plugin;
export {
  index_default as default
};
