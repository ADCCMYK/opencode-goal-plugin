#!/bin/bash
# opencode 目标推进插件 一键部署 + 配置合并脚本
# 用法：bash deploy.sh [用户名]   （任意目录执行；省略用户=当前用户）
# 功能：
#   1. 编译 server 插件 + 校验 TUI 插件语法
#   2. 部署 TUI 插件（goal-config.tsx + tui.json）与 z-goal agent 提示词（z-goal.md）到目标用户
#   3. 合并目标用户 ~/.config/opencode/opencode.jsonc
#      （去重：缺失追加；已存在且路径不一致时自动更新为新产物路径）
#      原配置备份为同目录 .bak
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- 定位插件目录（支持 项目根 与 备份解压根/plugin 两种结构）----
if [ -f "$SCRIPT_DIR/package.json" ]; then
  PLUGIN_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/plugin/package.json" ]; then
  PLUGIN_DIR="$SCRIPT_DIR/plugin"
else
  PLUGIN_DIR="${PLUGIN_DIR:-/root/opencode-goal-plugin}"
fi
[ -f "$PLUGIN_DIR/package.json" ] || { echo "ERROR: 未找到插件目录 (package.json)"; exit 1; }

# ---- 部署目标用户（默认当前用户；bash deploy.sh [用户名] 选择部署）----
TARGET_USER="${1:-$DEPLOY_USER}"
if [ -n "$TARGET_USER" ]; then
  TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  [ -n "$TARGET_HOME" ] || { echo "ERROR: 用户不存在: $TARGET_USER"; exit 1; }
else
  TARGET_HOME="$HOME"
fi

# ---- 定位 TUI 插件目录 ----
if [ -d "$SCRIPT_DIR/tui" ]; then
  TUI_DIR="$SCRIPT_DIR/tui"
else
  TUI_DIR="${TUI_DIR:-$TARGET_HOME/.config/opencode/tui-plugin}"
fi

# ---- 配置文件（默认目标用户；可用 GOAL_CONFIG 覆盖，便于测试）----
CONFIG="${GOAL_CONFIG:-$TARGET_HOME/.config/opencode/opencode.jsonc}"

echo "==> 部署目标用户: ${TARGET_USER:-$USER (当前用户)}"
echo "==> 插件目录: $PLUGIN_DIR"
echo "==> 配置文件: $CONFIG"

# ---- 1. 编译 server 插件 ----
echo "==> 编译 server 插件"
cd "$PLUGIN_DIR"
# 容错：src/index.ts 缺失（旧版扁平备份解压结构）→ 跳过编译，使用已有 dist/index.js
if [ -f "$PLUGIN_DIR/src/index.ts" ]; then
  npm install --no-audit --no-fund --loglevel=error
  npm run build
else
  echo "    WARN: 未找到 src/index.ts（扁平解压结构），跳过编译，使用已有 dist/index.js"
fi
DIST="$PLUGIN_DIR/dist/index.js"
[ -f "$DIST" ] || { echo "ERROR: 编译失败，无 dist/index.js"; exit 1; }
echo "    构建产物: $DIST"

# ---- 2. 校验 TUI 插件语法 ----
echo "==> 校验 TUI 插件语法"
if [ -f "$TUI_DIR/goal-config.tsx" ]; then
  npx -y esbuild "$TUI_DIR/goal-config.tsx" \
    --jsx=automatic --jsx-import-source=@opentui/solid \
    --bundle --external:@opencode-ai/plugin/tui \
    --external:solid-js --external:@opentui/solid --external:@opentui/solid/jsx-runtime \
    --platform=node --format=esm \
    --outfile=/tmp/opencode/tui-check.mjs
  echo "    TUI OK"
else
  echo "    WARN: 未找到 TUI 插件，跳过校验"
fi

# ---- 2.5 回收站工具：优先 del/trash-put/gio trash，都没有则 mv 到临时回收目录（可恢复，不直接删除）----
recycle() {
  local target="$1"
  if command -v del >/dev/null 2>&1; then
    del "$target" 2>/dev/null && echo "    ~ 已移入回收站 (del)"
  elif command -v trash-put >/dev/null 2>&1; then
    trash-put "$target" 2>/dev/null && echo "    ~ 已移入回收站 (trash-put)"
  elif command -v gio >/dev/null 2>&1; then
    gio trash "$target" 2>/dev/null && echo "    ~ 已移入回收站 (gio trash)"
  else
    mkdir -p /tmp/opencode/recycle-bin
    mv "$target" /tmp/opencode/recycle-bin/ 2>/dev/null && echo "    ~ 已移入临时回收目录: /tmp/opencode/recycle-bin/（可手动恢复）"
  fi
}

# 清理 opencode TUI 插件指纹缓存（防止旧版本被指纹缓存命中）
echo "==> 清理 opencode TUI 插件指纹缓存"
META="$TARGET_HOME/.local/state/opencode/plugin-meta.json"
if [ -f "$META" ]; then
  recycle "$META" || { mv "$META" "$META.bak" && echo "    ~ 已备份: $META.bak"; }
else
  echo "    无插件指纹缓存（跳过）"
fi

# ---- 3. 部署 TUI 插件与 z-goal agent 提示词 ----
echo "==> 部署 TUI 插件与 agent 提示词"
# 源文件：优先 tui/ 目录结构，回退插件目录扁平结构，再回退已部署的 TUI 插件目录（实际源码所在地）
TUI_SRC=""
if [ -f "$SCRIPT_DIR/tui/goal-config.tsx" ]; then
  TUI_SRC="$SCRIPT_DIR/tui/goal-config.tsx"
elif [ -f "$SCRIPT_DIR/goal-config.tsx" ]; then
  TUI_SRC="$SCRIPT_DIR/goal-config.tsx"
elif [ -f "$TARGET_HOME/.config/opencode/tui-plugin/goal-config.tsx" ]; then
  TUI_SRC="$TARGET_HOME/.config/opencode/tui-plugin/goal-config.tsx"
fi
if [ -n "$TUI_SRC" ]; then
  mkdir -p "$TARGET_HOME/.config/opencode/tui-plugin"
  if [ "$TUI_SRC" != "$TARGET_HOME/.config/opencode/tui-plugin/goal-config.tsx" ]; then
    cp -f "$TUI_SRC" "$TARGET_HOME/.config/opencode/tui-plugin/goal-config.tsx"
  else
    echo "    + TUI 插件已在生效位置（.config/opencode/tui-plugin/，跳过复制）"
  fi
  echo "    + TUI 插件: $TARGET_HOME/.config/opencode/tui-plugin/goal-config.tsx"
  # tui.json 仅在源码来自插件目录时部署；回退 .config 时为生效位置，tui.json 由 TUI 面板维护，不覆盖
  if [ "$TUI_SRC" != "$TARGET_HOME/.config/opencode/tui-plugin/goal-config.tsx" ]; then
    if [ -f "$SCRIPT_DIR/tui/tui.json" ]; then
      cp -f "$SCRIPT_DIR/tui/tui.json" "$TARGET_HOME/.config/opencode/tui.json"
      echo "    + tui.json: $TARGET_HOME/.config/opencode/tui.json"
    elif [ -f "$SCRIPT_DIR/tui.json" ]; then
      cp -f "$SCRIPT_DIR/tui.json" "$TARGET_HOME/.config/opencode/tui.json"
      echo "    + tui.json: $TARGET_HOME/.config/opencode/tui.json"
    fi
  fi
else
  echo "    WARN: 未找到 TUI 插件源码（tui/ 或扁平 goal-config.tsx），跳过 TUI 部署（现有配置不受影响）"
fi
AGENT_SRC=""
if [ -f "$SCRIPT_DIR/agents/z-goal.md" ]; then
  AGENT_SRC="$SCRIPT_DIR/agents/z-goal.md"
elif [ -f "$SCRIPT_DIR/z-goal.md" ]; then
  AGENT_SRC="$SCRIPT_DIR/z-goal.md"
elif [ -f "$TARGET_HOME/.config/opencode/agents/z-goal.md" ]; then
  AGENT_SRC="$TARGET_HOME/.config/opencode/agents/z-goal.md"
fi
if [ -n "$AGENT_SRC" ]; then
  mkdir -p "$TARGET_HOME/.config/opencode/agents"
  if [ "$AGENT_SRC" != "$TARGET_HOME/.config/opencode/agents/z-goal.md" ]; then
    cp -f "$AGENT_SRC" "$TARGET_HOME/.config/opencode/agents/z-goal.md"
  else
    echo "    + z-goal agent 已在生效位置（跳过复制）"
  fi
  echo "    + z-goal agent: $TARGET_HOME/.config/opencode/agents/z-goal.md"
else
  echo "    WARN: 未找到 z-goal 提示词（agents/ 或扁平 z-goal.md），跳过 agent 部署（现有配置不受影响）"
fi

# ---- 4. 合并配置（去重）----
echo "==> 合并配置 $CONFIG"
# 配置文件不存在（全新安装）→ 创建默认模板，避免报错退出；后续合并脚本会填充插件/命令条目
if [ ! -f "$CONFIG" ]; then
  mkdir -p "$(dirname "$CONFIG")"
  cat > "$CONFIG" <<'JSONC'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [],
  "command": {}
}
JSONC
  echo "    + 已创建默认配置文件: $CONFIG"
fi
[ -f "$CONFIG" ] || { echo "ERROR: 无法创建配置文件: $CONFIG"; exit 1; }
cp "$CONFIG" "$CONFIG.bak"
export GOAL_CONFIG="$CONFIG"
export GOAL_PLUGIN_DIST="$DIST"
export GOAL_OLD_DIR_FILE="/tmp/opencode/deploy_old_plugin_dir.txt"
if [ -f "$GOAL_OLD_DIR_FILE" ]; then
  if command -v trash-put >/dev/null 2>&1; then
    trash-put "$GOAL_OLD_DIR_FILE" >/dev/null 2>&1 || true
  else
    mv "$GOAL_OLD_DIR_FILE" "$GOAL_OLD_DIR_FILE.bak" 2>/dev/null || true
  fi
fi
node <<'NODE'
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

// plugin 去重：识别 goal 插件条目（路径含插件名 或 配置含 maxTurns 键），
// 已存在 → 路径不一致时更新为新产物路径；缺失才添加
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
const isGoalEntry = (p) => {
  if (!Array.isArray(p)) return false;
  if (String(p[0]).includes("opencode-goal-plugin")) return true;
  const o = p[1];
  return !!o && typeof o === "object" && !Array.isArray(o) && ("maxTurns" in o);
};
let goalIdx = [];
cfg.plugin.forEach((p, i) => { if (isGoalEntry(p)) goalIdx.push(i); });

if (goalIdx.length > 0) {
  const keep = goalIdx[0];
  const oldPath = cfg.plugin[keep][0];
  const opts = cfg.plugin[keep][1] && typeof cfg.plugin[keep][1] === "object" && !Array.isArray(cfg.plugin[keep][1])
    ? cfg.plugin[keep][1] : {};
  if (!("maxTurns" in opts)) opts.maxTurns = 100;
  // 新配置项：缺失才补齐默认值（不覆盖用户已设置的值）；默认与当前运行一致（cleanupDays 3 / maxRetained 60）
  if (!("stuckTimeoutMs" in opts)) opts.stuckTimeoutMs = 600000;
  if (!("autoAbortSubagent" in opts)) opts.autoAbortSubagent = true;
  if (!("cleanupDays" in opts)) opts.cleanupDays = 3;
  if (!("maxRetainedSubagents" in opts)) opts.maxRetainedSubagents = 60;
  if (oldPath !== DIST) {
    cfg.plugin[keep] = [DIST, opts];
    changed = true;
    console.log("    ~ 更新插件路径: " + oldPath + " → " + DIST);
    recordOldDir(oldPath);
  } else {
    console.log("    已存在插件条目且路径一致，跳过");
  }
  for (let k = goalIdx.length - 1; k >= 1; k--) {
    cfg.plugin.splice(goalIdx[k], 1);
    changed = true;
    console.log("    - 移除重复 goal 插件条目");
  }
} else {
  cfg.plugin.push([DIST, { maxTurns: 100, stuckTimeoutMs: 600000, autoAbortSubagent: true, cleanupDays: 3, maxRetainedSubagents: 60 }]);
  changed = true;
  console.log("    + 添加插件条目: " + DIST);
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

// 子代理覆盖：禁用提问 + 保持 subagent 模式（缺失才添加）
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
}

if (changed) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
  console.log("    配置已更新（原文件备份为 .bak）");
} else {
  console.log("    配置无需变更");
}
NODE

# ---- 4.5 删除旧插件目录（防止缓存/混淆，用 del 移入回收站）----
if [ -s "$GOAL_OLD_DIR_FILE" ]; then
  OLD_DIR="$(cat "$GOAL_OLD_DIR_FILE")"
  if [ -n "$OLD_DIR" ] && [ -d "$OLD_DIR" ] && [ "$OLD_DIR" != "$PLUGIN_DIR" ] && [ "$OLD_DIR" != "/" ]; then
    echo "==> 删除旧插件目录（可恢复）: $OLD_DIR"
    # 防护：仅当目录含 package.json（确认是插件目录）且非当前部署目录时才删除，避免误删运行中源码/系统目录
    if [ -f "$OLD_DIR/package.json" ] && [ "$OLD_DIR" != "$PLUGIN_DIR" ] && [ "$OLD_DIR" != "$TARGET_HOME" ] && [ "$OLD_DIR" != "/" ]; then
      recycle "$OLD_DIR" || echo "    WARN: 回收失败，旧插件目录保留"
    else
      echo "    WARN: 旧插件目录校验未通过（无 package.json 或为当前/系统目录），保留不动"
    fi
  fi
fi

# ---- 5. 初始化运行配置（state config.json）：不存在则创建默认（自动批准默认关闭，避免新部署环境权限自动放行）----
STATE_CFG="$TARGET_HOME/.local/state/goal/config.json"
if [ ! -f "$STATE_CFG" ]; then
  mkdir -p "$(dirname "$STATE_CFG")"
  cat > "$STATE_CFG" <<'JSON'
{
  "maxTurns": 100,
  "cleanupDays": 3,
  "autoApprovePermissions": false,
  "maxRetainedSubagents": 60,
  "stuckTimeoutMs": 600000,
  "forkPaused": true,
  "iterateMaxRounds": 10,
  "iterAskMode": "first",
  "iterateMode": false,
  "auditDelete": true,
  "pushIntervalMs": 300000
}
JSON
  echo "    + 已初始化运行配置（自动批准默认关闭）: $STATE_CFG"
else
  echo "    运行配置已存在，保留不动"
fi

echo "==> 部署完成，重启 opencode 生效"
echo "DEPLOY_OK"
