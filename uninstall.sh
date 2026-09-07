#!/bin/bash
# opencode 目标推进插件 一键卸载脚本（保守安全版）
# 安全原则：
#   1. 只删除"本插件"部署/生成的东西；其他插件文件、用户自定义配置一律保留（无法确证是本插件的字段只提示不删除）
#   2. 删除走回收站（trash-put → gio trash）；新用户环境无任何回收命令时回退 rm（不可恢复——
#      但所有将被删除的内容：配置文件类先独立备份、部署文件在插件项目目录有同名源、运行数据卸载前先跑 backup.sh）
#   3. opencode.jsonc / tui.json 不是删除文件，而是「先备份当前完整配置 → 剔除本插件注入项 → 替换写回」：
#      基于当前内容逐项修剪（其余用户配置 mcp/provider 等原样保留），不依赖 deploy 的历史 .bak——没有原始备份也能安全卸载
#   4. 运行数据 ~/.local/state/goal 默认一并回收（--keep-data 保留）
#   5. 不删除插件项目目录本身（保留源码与备份，最终清理提示手动操作）
# 用法：
#   bash uninstall.sh              # 交互确认后卸载（含运行数据回收，先备份）
#   bash uninstall.sh -y           # 跳过确认直接卸载
#   bash uninstall.sh --dry-run    # 仅预览将执行的动作，不做任何修改
#   bash uninstall.sh --keep-data  # 保留运行数据（goals.json 等，仅移配置与插件文件）
#   bash uninstall.sh --no-backup  # 卸载前不自动执行 backup.sh
#   bash uninstall.sh [用户名]     # 卸载指定用户的部署（同 deploy.sh，默认当前用户）
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- 参数解析 ----
DRY_RUN=false
KEEP_DATA=false
DO_BACKUP=true
AUTO_YES=false
TARGET_USER=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --keep-data) KEEP_DATA=true ;;
    --no-backup) DO_BACKUP=false ;;
    -y|--yes) AUTO_YES=true ;;
    -*) echo "未知参数: $arg（可用 --dry-run / --keep-data / --no-backup / -y / [用户名]）"; exit 1 ;;
    *) TARGET_USER="$arg" ;;
  esac
done

# ---- 卸载目标用户（同 deploy.sh）----
if [ -n "$TARGET_USER" ]; then
  TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  [ -n "$TARGET_HOME" ] || { echo "ERROR: 用户不存在: $TARGET_USER"; exit 1; }
else
  TARGET_HOME="$HOME"
fi
CONFIG="$TARGET_HOME/.config/opencode/opencode.jsonc"
TUI_PLUGIN_DIR="$TARGET_HOME/.config/opencode/tui-plugin"
TUI_FILE="$TUI_PLUGIN_DIR/goal-config.tsx"
TUI_JSON="$TARGET_HOME/.config/opencode/tui.json"
AGENT_FILE="$TARGET_HOME/.config/opencode/agents/z-goal.md"
META_FILE="$TARGET_HOME/.local/state/opencode/plugin-meta.json"
STATE_DIR="$TARGET_HOME/.local/state/goal"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "==> 卸载目标用户: ${TARGET_USER:-$USER (当前用户)}"
echo "==> 配置文件: $CONFIG"
[ "$DRY_RUN" = true ] && echo "==> [DRY-RUN] 仅预览，不做任何修改"

# ---- 删除工具：优先回收站（可恢复）；新用户环境无任何回收命令时回退 rm（不可恢复，调用前须确保已备份/项目内有同名源）----
recycle() {
  local target="$1"
  if command -v trash-put >/dev/null 2>&1; then
    if trash-put "$target" 2>/dev/null; then
      echo "    ~ 已移入回收站 (trash-put)"
      return 0
    fi
  fi
  if command -v gio >/dev/null 2>&1; then
    if gio trash "$target" 2>/dev/null; then
      echo "    ~ 已移入回收站 (gio trash)"
      return 0
    fi
  fi
  # 无回收命令（新用户环境）→ 只能 rm 直接删除；调用范围已限本插件文件/目录（配置文件类另有独立备份）
  echo "    WARN: 无回收站命令（trash-put/gio 均不存在），改用 rm 直接删除（不可恢复）"
  rm -rf -- "$target" 2>/dev/null && return 0
  return 1
}

# ---- 预览清单 ----
echo ""
echo "==> 卸载内容预览（只删本插件，其他插件/自定义配置保留）"
declare -a ACTIONS=()
note() { echo "    $1"; ACTIONS+=("$1"); }

if [ -f "$CONFIG" ]; then
  note "替换 $CONFIG（先备份当前完整配置 .uninstall-backup-$STAMP，再剔除本插件项写回；不依赖历史 .bak，无原始备份也可安全卸载）"
else
  note "跳过：配置文件不存在 $CONFIG"
fi
if [ -f "$TUI_FILE" ]; then
  note "删除本插件 TUI 文件：$TUI_FILE（其他 TUI 插件文件不受影响）"
fi
if [ -f "$TUI_JSON" ]; then
  note "处理 tui.json：仅引用本插件 → 整体删除；还引用其他插件 → 只移除本插件项并写回（先备份）"
fi
if [ -f "$AGENT_FILE" ]; then
  note "删除本插件 z-goal agent：$AGENT_FILE（agents/ 下其他 agent 文件不受影响）"
fi
if [ -f "$META_FILE" ]; then
  note "删除插件指纹缓存（防旧指纹残留加载）：$META_FILE"
fi
if [ "$KEEP_DATA" = false ] && [ -d "$STATE_DIR" ]; then
  note "删除运行数据（goals.json / config.json 等）：$STATE_DIR"
fi
note "保留：插件项目目录 $SCRIPT_DIR / --keep-data 时保留运行数据 / 无法确证为本插件的配置字段"

echo ""
echo "    共 ${#ACTIONS[@]} 项动作"

# ---- 备份与确认 ----
if [ "$DRY_RUN" = true ]; then
  echo "==> [DRY-RUN] 预览结束，未做任何修改。执行：bash uninstall.sh"
  exit 0
fi
if [ "$DO_BACKUP" = true ] && [ -f "$SCRIPT_DIR/backup.sh" ]; then
  echo "==> 卸载前自动备份（backup.sh，回收站可恢复回收内容）"
  bash "$SCRIPT_DIR/backup.sh" || echo "    WARN: 自动备份失败，继续卸载（可稍后手动备份）"
fi
if [ "$AUTO_YES" != true ]; then
  echo ""
  if [ "$KEEP_DATA" = false ] && [ -d "$STATE_DIR" ]; then
    read -r -p "确认卸载？含运行数据 $STATE_DIR 将一并删除（有回收命令则入回收站可恢复；无则 rm 不可恢复）[y/N] " ans
  else
    read -r -p "确认卸载以上内容？[y/N] " ans
  fi
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "==> 已取消，未做任何修改"; exit 0 ;;
  esac
fi

# ---- 1. 修剪 opencode.jsonc ----
if [ -f "$CONFIG" ]; then
  cp "$CONFIG" "$CONFIG.uninstall-backup-$STAMP"
  echo "==> 已备份配置: $CONFIG.uninstall-backup-$STAMP"
  export GOAL_UNINSTALL_CONFIG="$CONFIG"
  node <<'NODE'
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

// 1) plugin：仅移除本插件条目（识别同 deploy：路径含 opencode-goal-plugin 或配置含 maxTurns 键）——其他插件条目一律保留
if (Array.isArray(cfg.plugin)) {
  const isGoalEntry = (p) => {
    if (!Array.isArray(p)) return false;
    if (String(p[0]).includes("opencode-goal-plugin")) return true;
    const o = p[1];
    return !!o && typeof o === "object" && !Array.isArray(o) && ("maxTurns" in o);
  };
  const before = cfg.plugin.length;
  cfg.plugin = cfg.plugin.filter(p => !isGoalEntry(p));
  if (cfg.plugin.length !== before) {
    changed = true;
    console.log("    - 移除本插件条目 ×" + (before - cfg.plugin.length) + "，其余插件条目保留");
  } else {
    console.log("    跳过：未找到本插件条目");
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
NODE
else
  echo "==> 跳过配置修剪：配置文件不存在 $CONFIG"
fi

# ---- 2. 处理 tui.json（可能被其他 TUI 插件共用：仅引用本插件才整体回收，否则只移除本插件项）----
if [ -f "$TUI_JSON" ]; then
  export GOAL_UNINSTALL_TUI_JSON="$TUI_JSON"
  export GOAL_UNINSTALL_STAMP="$STAMP"
  export GOAL_UNINSTALL_TUI_FLAG="/tmp/opencode/goal-uninstall-tui-$STAMP.flag"
  : > "$GOAL_UNINSTALL_TUI_FLAG"   # 清空为无标记状态（不用 rm 删除临时文件）
  node <<'NODE'
const fs = require("fs");
const f = process.env.GOAL_UNINSTALL_TUI_JSON;
let text;
try { text = fs.readFileSync(f, "utf8"); } catch { process.exit(0); }
try {
  const j = JSON.parse(text);
  if (j && Array.isArray(j.plugin)) {
    const goalIdx = j.plugin.map((p, i) => typeof p === "string" && p.includes("goal") ? i : -1).filter(i => i >= 0);
    if (goalIdx.length === 0) { console.log("    跳过：tui.json 未引用本插件"); process.exit(0); }
    if (goalIdx.length === j.plugin.length) {
      fs.writeFileSync(process.env.GOAL_UNINSTALL_TUI_FLAG, "RECYCLE_ALL");
      console.log("    - tui.json 仅引用本插件 → 整体回收");
      process.exit(0);
    }
    fs.copyFileSync(f, f + ".uninstall-backup-" + process.env.GOAL_UNINSTALL_STAMP);
    j.plugin = j.plugin.filter(p => typeof p !== "string" || !p.includes("goal"));
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    console.log("    - tui.json 还引用其他插件：仅移除本插件项并写回（已备份）");
  } else if (text.includes("goal")) {
    console.log("    保留 tui.json：非标准结构且含 goal 字样，无法安全自动处理，请手动检查");
  }
} catch (e) {
  console.log("    保留 tui.json：解析失败（" + e.message + "），请手动检查");
}
NODE
  if [ -f "$GOAL_UNINSTALL_TUI_FLAG" ]; then
    if recycle "$TUI_JSON"; then echo "    ✓ 已删除: tui.json（删除方式见上方行）"; else echo "    WARN: tui.json 删除失败，保留"; fi
  fi
  # 临时标记文件保留在 /tmp/opencode（下次运行自动清空覆盖，无害）
fi

# ---- 3. 回收本插件部署文件（全部走回收站；只删本插件文件，不碰同目录其他插件）----
removed=0
do_recycle() {
  local path="$1" label="$2"
  if [ -e "$path" ]; then
    if recycle "$path"; then
      echo "    ✓ 已删除: $label（删除方式见上方行）"
      removed=$((removed + 1))
    else
      echo "    WARN: 删除失败，保留: $label"
    fi
  fi
}

if [ -f "$TUI_FILE" ]; then
  do_recycle "$TUI_FILE" "本插件 TUI 文件 goal-config.tsx"
fi
# tui-plugin 目录：仅当删除本插件文件后为空才整体回收（目录内若有其他 TUI 插件文件则保留目录）
if [ -d "$TUI_PLUGIN_DIR" ] && [ -z "$(find "$TUI_PLUGIN_DIR" -mindepth 1 2>/dev/null | head -1)" ]; then
  do_recycle "$TUI_PLUGIN_DIR" "空目录 tui-plugin/"
fi
if [ -f "$AGENT_FILE" ]; then
  do_recycle "$AGENT_FILE" "本插件 z-goal agent"
fi
# agents 目录：仅当删除 z-goal.md 后为空才整体回收（有其他 agent 文件则保留目录）
AGENT_DIR="$(dirname "$AGENT_FILE")"
if [ -d "$AGENT_DIR" ] && [ -z "$(find "$AGENT_DIR" -mindepth 1 2>/dev/null | head -1)" ]; then
  do_recycle "$AGENT_DIR" "空目录 agents/"
fi
if [ -f "$META_FILE" ]; then
  do_recycle "$META_FILE" "插件指纹缓存 plugin-meta.json"
fi
if [ "$KEEP_DATA" = false ] && [ -d "$STATE_DIR" ]; then
  do_recycle "$STATE_DIR" "运行数据 ~/.local/state/goal"
else
  echo "    - 保留运行数据 $STATE_DIR（--keep-data）"
fi

# ---- 4. 汇总 ----
echo ""
echo "==> 卸载完成：删除 $removed 项（有回收命令环境已入回收站可恢复；无回收命令环境为 rm 直接删除）"
echo "    配置备份: $CONFIG.uninstall-backup-$STAMP"
echo "    运行数据: $([ "$KEEP_DATA" = false ] && echo '已删除（卸载前已尝试 backup.sh 快照；有回收命令环境可从回收站恢复）' || echo '已保留（--keep-data）')"
echo "    配置备份: $CONFIG.uninstall-backup-$STAMP"
echo "    插件项目目录保留: $SCRIPT_DIR（含源码与备份；确认不再需要请手动回收：trash-put $SCRIPT_DIR）"
echo "    请重启 opencode 生效"
echo "UNINSTALL_DONE"
