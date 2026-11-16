const fs = require("fs");
const CONFIG = process.env.GOAL_CONFIG;
const DIST = process.env.GOAL_PLUGIN_DIST;
const OLD_DIR_FILE = process.env.GOAL_OLD_DIR_FILE;
const nodePath = require("path");
const recordOldDir = (oldPath) => {
  if (!OLD_DIR_FILE) return;
  const dir = nodePath.dirname(nodePath.dirname(oldPath));
  try { fs.writeFileSync(OLD_DIR_FILE, dir); } catch {}
};

function parseJSONC(text) {
  let out = "", inStr = false, esc = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i++;
    } else if (ch === '"') {
      inStr = true; out += ch; i++;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += ch; i++;
    }
  }
  out = out.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(out);
}

let cfg;
try { cfg = parseJSONC(fs.readFileSync(CONFIG, "utf8")); }
catch (e) { console.error("ERROR: 配置不是合法 JSON: " + e.message); process.exit(1); }

let changed = false;

// plugins 去重（V2 形态：对象 {package, options}；并清理 V1 遗留的 plugin 元组 [path, opts]）
// 识别本插件：字符串/对象 package 里含插件名，或 options 里含 maxTurns 键
const isGoalEntryV2 = (p) => {
  if (typeof p === "string") return p.includes("opencode-goal-plugin");
  if (Array.isArray(p)) {                       // V1 元组形态（迁移用）
    if (String(p[0]).includes("opencode-goal-plugin")) return true;
    const o = p[1];
    return !!o && typeof o === "object" && !Array.isArray(o) && ("maxTurns" in o);
  }
  if (p && typeof p === "object") {
    if (String(p.package ?? "").includes("opencode-goal-plugin")) return true;
    const o = p.options;
    return !!o && typeof o === "object" && !Array.isArray(o) && ("maxTurns" in o);
  }
  return false;
};

// 1) 清掉 V1 的 plugin 键里的本插件条目（V2 改用 plugins，旧键留着会让 V2 报 must be a directory）
if (Array.isArray(cfg.plugin)) {
  const before = cfg.plugin.length;
  cfg.plugin = cfg.plugin.filter((p) => !isGoalEntryV2(p));
  if (cfg.plugin.length !== before) {
    changed = true;
    console.log("    - 从 V1 plugin 键移除本插件条目 ×" + (before - cfg.plugin.length) + "（V2 改用 plugins）");
  }
  if (cfg.plugin.length === 0) { delete cfg.plugin; changed = true; }
}

// 2) plugins 里保证只有一条本插件、package 指向目录、options 补齐默认（不覆盖用户已设的值）
if (!Array.isArray(cfg.plugins)) cfg.plugins = [];
let goalIdx = [];
cfg.plugins.forEach((p, i) => { if (isGoalEntryV2(p)) goalIdx.push(i); });

if (goalIdx.length > 0) {
  const keep = goalIdx[0];
  const cur = cfg.plugins[keep];
  const opts = (cur && typeof cur === "object" && !Array.isArray(cur) && cur.options && typeof cur.options === "object")
    ? cur.options
    : (Array.isArray(cur) && cur[1] && typeof cur[1] === "object" ? cur[1] : {});
  if (!("maxTurns" in opts)) opts.maxTurns = 100;
  if (!("cleanupDays" in opts)) opts.cleanupDays = 3;
  if (!("maxRetainedSubagents" in opts)) opts.maxRetainedSubagents = 60;
  const curPath = typeof cur === "string" ? cur : Array.isArray(cur) ? cur[0] : cur.package;
  if (curPath !== DIST || typeof cur !== "object" || Array.isArray(cur) || cfg.plugins[keep].package !== DIST) {
    cfg.plugins[keep] = { package: DIST, options: opts };
    changed = true;
    console.log("    ~ 规范化插件条目（V2 对象形态）: " + curPath + " → " + DIST);
    if (curPath && curPath !== DIST) recordOldDir(curPath);
  } else {
    console.log("    已存在插件条目且路径一致，跳过");
  }
  for (let k = goalIdx.length - 1; k >= 1; k--) {
    cfg.plugins.splice(goalIdx[k], 1);
    changed = true;
    console.log("    - 移除重复 goal 插件条目");
  }
} else {
  cfg.plugins.push({ package: DIST, options: { maxTurns: 100, cleanupDays: 3, maxRetainedSubagents: 60 } });
  changed = true;
  console.log("    + 添加插件条目（V2 plugins，目录形态）: " + DIST);
}

// command.goal 去重：已存在则不替换
if (!cfg.command) cfg.command = {};
if (!cfg.command.goal) {
  cfg.command.goal = {
    template: "/goal $ARGUMENTS",
    description: "设置目标并持续自主推进直到完成",
    agent: "z-goal",
    subtask: false
  };
  changed = true;
  console.log("    + 添加命令 /goal");
} else {
  console.log("    已存在命令 /goal，跳过");
}

// permission.question: allow（缺失才添加）
if (!cfg.permission) cfg.permission = {};
if (cfg.permission.question === undefined) {
  cfg.permission.question = "allow";
  changed = true;
  console.log("    + 添加 permission.question: allow");
}

// 子代理覆盖：禁用提问 + 保持 subagent 模式（缺失才添加）；explore 开放 goal 工具（子代理可设子目标，与主环境形态一致）
if (!cfg.agent) cfg.agent = {};
for (const name of ["general", "explore", "scout"]) {
  const a = cfg.agent[name] = cfg.agent[name] || {};
  if (a.mode === undefined) {
    a.mode = "subagent";
    changed = true;
    console.log(`    + 添加 agent.${name}.mode: subagent`);
  }
  const perm = a.permission = a.permission || {};
  if (perm.question === undefined) {
    perm.question = "deny";
    changed = true;
    console.log(`    + 添加 agent.${name}.permission.question: deny`);
  }
  if (name === "explore") {
    a.tools = a.tools || {};
    if (a.tools.goal === undefined) {
      a.tools.goal = true;
      changed = true;
      console.log("    + 添加 agent.explore.tools.goal: true");
    }
  }
}

if (changed) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
  console.log("    配置已更新（原文件备份为 .bak）");
} else {
  console.log("    配置无需变更");
}
