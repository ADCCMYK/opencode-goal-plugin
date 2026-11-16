const fs = require("fs");
const CONFIG = process.env.GOAL_UNINSTALL_CONFIG;

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
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => k in b && deepEq(a[k], b[k]));
}

let cfg;
try { cfg = parseJSONC(fs.readFileSync(CONFIG, "utf8")); }
catch (e) { console.log("    ERROR: 配置不是合法 JSON: " + e.message + "（跳过配置修改，其余卸载继续）"); process.exit(0); }
let changed = false;

// 0) mcp 段（用户 MCP 服务器配置，含密钥）一律原样保留，仅确认打印
if (cfg.mcp && typeof cfg.mcp === "object" && Object.keys(cfg.mcp).length > 0) {
  console.log("    保留 mcp 配置 ×" + Object.keys(cfg.mcp).length + "（MCP 服务器配置与密钥不受影响）");
}

// 1) 插件条目：V2 在 plugins（对象 {package,options} 或字符串），V1 在 plugin（元组）——两者都只移除本插件，其他条目一律保留
const isGoalEntryAny = (p) => {
  if (typeof p === "string") return p.includes("opencode-goal-plugin");
  if (Array.isArray(p)) {
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
if (Array.isArray(cfg.plugins)) {
  const before = cfg.plugins.length;
  cfg.plugins = cfg.plugins.filter((p) => !isGoalEntryAny(p));
  if (cfg.plugins.length !== before) {
    changed = true;
    console.log("    - 从 plugins 移除本插件条目 ×" + (before - cfg.plugins.length) + "，其余插件条目保留");
  } else {
    console.log("    跳过：plugins 未找到本插件条目");
  }
  if (cfg.plugins.length === 0) delete cfg.plugins;
}
if (Array.isArray(cfg.plugin)) {
  const before = cfg.plugin.length;
  cfg.plugin = cfg.plugin.filter((p) => !isGoalEntryAny(p));
  if (cfg.plugin.length !== before) {
    changed = true;
    console.log("    - 从 V1 plugin 移除本插件条目 ×" + (before - cfg.plugin.length) + "，其余插件条目保留");
  }
  if (cfg.plugin.length === 0) delete cfg.plugin;
}

// 2) command：仅当由本插件注册（agent=z-goal 且 template 以 /goal 开头）才移除
if (cfg.command && typeof cfg.command === "object") {
  for (const name of ["goal", "goal-iter"]) {
    const c = cfg.command[name];
    if (c && typeof c === "object" && c.agent === "z-goal" && typeof c.template === "string" && c.template.startsWith("/" + name)) {
      delete cfg.command[name];
      changed = true;
      console.log("    - 移除本插件命令 /" + name);
    }
  }
  if (Object.keys(cfg.command).length === 0) delete cfg.command;
}

// 3) agent.general/explore/scout：仅当整块与插件注入形态完全一致（用户未自定义过）才删除；
//    含任何自定义内容 → 保留不动并提示（宁保留不误删）
if (cfg.agent && typeof cfg.agent === "object") {
  const injected = {
    general: { mode: "subagent", permission: { question: "deny" } },
    explore: { mode: "subagent", permission: { question: "deny" }, tools: { goal: true } },
    scout: { mode: "subagent", permission: { question: "deny" } },
  };
  for (const name of ["general", "explore", "scout"]) {
    const a = cfg.agent[name];
    if (!a || typeof a !== "object") continue;
    if (deepEq(a, injected[name])) {
      delete cfg.agent[name];
      changed = true;
      console.log("    - 移除 agent." + name + "（与插件注入形态完全一致）");
    } else {
      console.log("    保留 agent." + name + "（含非本插件注入的内容，未改动）");
    }
  }
  if (Object.keys(cfg.agent).length === 0) delete cfg.agent;
}

// 4) 顶层 permission.question: allow —— 无法确证是否为本插件注入（用户可能自配），保留并提示
if (cfg.permission && typeof cfg.permission === "object" && cfg.permission.question === "allow") {
  console.log("    提示：顶层 permission.question=allow 已保留（可能为你的原有配置；如确认为本插件注入，请手动从备份中比对删除）");
}

if (changed) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
  console.log("    配置已修剪并写回（原文件备份于同目录 .uninstall-backup-*）");
} else {
  console.log("    配置无需变更");
}
