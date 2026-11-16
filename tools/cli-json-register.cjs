const fs = require("fs");
const path = require("path");
const f = process.env.GOAL_CLI_JSON;
const dir = process.env.GOAL_PLUGIN_DIR_FOR_CLI;
try {
  let j = {};
  if (fs.existsSync(f)) { j = JSON.parse(fs.readFileSync(f, "utf8")); fs.copyFileSync(f, f + ".bak"); }
  if (!Array.isArray(j.plugins)) j.plugins = [];
  const isGoal = (p) => typeof p === "string" ? p.includes("opencode-goal-plugin") : String((p && p.package) || "").includes("opencode-goal-plugin");
  // 清理 V1 时代遗留的旧登记（V1 的 tui-plugin/goal-config.tsx 在 V2 加载不了，只会刷错）
  const beforeV1 = j.plugins.length;
  j.plugins = j.plugins.filter((p) => !(typeof p === "string" && p.includes("goal-config")));
  if (j.plugins.length !== beforeV1) { fs.copyFileSync(f, f + ".bak"); console.log("    - cli.json 清理 V1 遗留登记 ×" + (beforeV1 - j.plugins.length) + "（tui-plugin/goal-config.tsx）"); }
  if (!j.plugins.some(isGoal)) {
    j.plugins.push(dir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    console.log("    + cli.json 已登记本插件（V2 CLI 半边）: " + dir);
  } else {
    console.log("    + cli.json 已登记本插件（跳过）");
  }
} catch (e) {
  console.log("    WARN: cli.json 处理失败，保留不动，请手动检查: " + e.message);
}
