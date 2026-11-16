#!/bin/bash
# opencode 目标推进插件 一键卸载脚本（保守安全版）
# 安全原则：
#   1. 只删除"本插件"部署/生成的东西；其他插件文件、用户自定义配置一律保留（无法确证是本插件的字段只提示不删除）
#   2. 删除走回收站（trash-put → gio trash）；新用户环境无任何回收命令时回退 rm（不可恢复——
#      但所有将被删除的内容：配置文件类先独立备份、部署文件在插件项目目录有同名源）
#   3. opencode.jsonc / tui.json 不是删除文件，而是「先备份当前完整配置 → 剔除本插件注入项 → 替换写回」：
#      基于当前内容逐项修剪（其余用户配置 mcp/provider 等原样保留），不依赖 deploy 的历史 .bak——没有原始备份也能安全卸载
#   4. 运行数据 ~/.local/state/goal 默认一并回收（--keep-data 保留）
#   5. 不删除插件项目目录本身（保留源码与备份，最终清理提示手动操作）
# 用法：
#   bash uninstall.sh              # 交互确认后卸载
#   bash uninstall.sh -y           # 跳过确认直接卸载
#   bash uninstall.sh --dry-run    # 仅预览将执行的动作，不做任何修改
#   bash uninstall.sh --keep-data  # 保留运行数据（goals.json 等，仅移配置与插件文件）
#   bash uninstall.sh [用户名]     # 卸载指定用户的部署（同 deploy.sh，默认当前用户）
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- 参数解析 ----
DRY_RUN=false
KEEP_DATA=false
AUTO_YES=false
TARGET_USER=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --keep-data) KEEP_DATA=true ;;
    -y|--yes) AUTO_YES=true ;;
    -*) echo "未知参数: $arg（可用 --dry-run / --keep-data / -y / [用户名]）"; exit 1 ;;
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
  node "$SCRIPT_DIR/tools/opencode-config-prune.cjs"
else
  echo "==> 跳过配置修剪：配置文件不存在 $CONFIG"
fi

# ---- 2. 处理 tui.json（V1 遗留：V1 的 TUI 注册；可能被其他 TUI 插件共用）----
#   用独立小工具 tools/jsonc-prune.cjs（不再内联解释器脚本）：摘除本插件项、别人的原样保留；
#   摘空（键被删）且文件里再无本插件字样 ⇒ 整体回收（recycle 走回收站可恢复，helper 另留 .bak）。
if [ -f "$TUI_JSON" ] && grep -q "goal-config" "$TUI_JSON" 2>/dev/null; then
  out=""
  for k in plugin plugins; do
    out="$(node "$SCRIPT_DIR/tools/jsonc-prune.cjs" "$TUI_JSON" --array-key "$k" --match "goal-config" --drop-key-if-empty --backup 2>/dev/null || true)"
    [ -n "$out" ] && break
  done
  if [ -n "$out" ]; then
    echo "    - tui.json 已摘除本插件项（$out；已备份 .bak）"
    if ! grep -q "goal-config" "$TUI_JSON" 2>/dev/null; then
      if recycle "$TUI_JSON"; then echo "    ✓ 已删除: tui.json（已无本插件项；走回收站可恢复）"; else echo "    WARN: tui.json 删除失败，保留"; fi
    fi
  else
    echo "    ! tui.json 未能自动处理（结构非预期）→ 保留不动，请手动摘除本插件项: $TUI_JSON"
  fi
fi

# ---- 2.5 修剪 cli.json（V2 CLI 半边登记；deploy.sh 写入过 plugins 项）----
#   用独立小工具 tools/jsonc-prune.cjs（JSON/JSONC 手术交给它，脚本里只调一行）：只摘本插件项，别人的原样保留。
CLI_JSON="$TARGET_HOME/.config/opencode/cli.json"
if [ -f "$CLI_JSON" ] && grep -q "opencode-goal-plugin" "$CLI_JSON"; then
  out="$(node "$SCRIPT_DIR/tools/jsonc-prune.cjs" "$CLI_JSON" --array-key plugins --match "opencode-goal-plugin" --drop-key-if-empty --backup 2>/dev/null || true)"
  if [ -n "$out" ]; then
    echo "    - cli.json 已摘除本插件登记（$out；已备份 .bak）"
  else
    echo "    ! cli.json 未能自动处理（结构非预期）→ 保留不动，请手动摘除本插件项: $CLI_JSON"
  fi
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
# V1 遗留（deploy.sh 把 V1 文件改名停用，此处一并回收）：TUI 文件备份 / tui.json 备份 / 自动加载目录残留备份
if [ -f "$TUI_FILE.v1-backup" ]; then
  do_recycle "$TUI_FILE.v1-backup" "V1 遗留 TUI 文件备份 goal-config.tsx.v1-backup"
fi
if [ -f "$TUI_JSON.v1-backup" ]; then
  do_recycle "$TUI_JSON.v1-backup" "V1 遗留 tui.json 备份 tui.json.v1-backup"
fi
for f in "$TARGET_HOME/.config/opencode/plugin/"*goal*.v1-backup; do
  [ -e "$f" ] || continue
  do_recycle "$f" "V1 遗留自动加载目录残留备份 $(basename "$f")"
done
# 固定安装目录：仅当它不是脚本自身所在目录（= 我们复制过去的副本）时才回收；用户源码目录永不自动删除
FIXED_DIR="$TARGET_HOME/opencode-goal-plugin"   # 定义提前到此处：下面的回收判断要用它（此前定义在使用之后 ⇒ 判断恒不成立）
if [ -d "$FIXED_DIR" ] && [ "$(realpath -m "$FIXED_DIR")" != "$(realpath -m "$SCRIPT_DIR")" ]; then
  do_recycle "$FIXED_DIR" "固定安装目录（插件副本）$FIXED_DIR"
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
elif [ "$KEEP_DATA" = true ]; then
  echo "    - 保留运行数据 $STATE_DIR（--keep-data）"
else
  echo "    - 运行数据不存在（无需处理）"
fi

# ---- 4. 汇总 ----
echo ""
echo "==> 卸载完成：删除 $removed 项（有回收命令环境已入回收站可恢复；无回收命令环境为 rm 直接删除）"
echo "    配置备份: $CONFIG.uninstall-backup-$STAMP"
echo "    运行数据: $([ "$KEEP_DATA" = false ] && echo '已删除（有回收命令环境可从回收站恢复）' || echo '已保留（--keep-data）')"
if [ "$SCRIPT_DIR" = "$TARGET_HOME" ]; then
  echo "    提示：包解压在 HOME 根，卸载后项目文件（src/ dist/ package.json 等）仍在 $TARGET_HOME，建议手动逐一清理（请勿删除 HOME 本身）"
elif [ -d "$FIXED_DIR" ] && [ "$(realpath -m "$FIXED_DIR")" = "$(realpath -m "$SCRIPT_DIR")" ]; then
  echo "    插件项目目录保留: $SCRIPT_DIR（含源码与备份；确认不再需要请手动回收：trash-put $SCRIPT_DIR）"
else
  echo "    插件项目目录保留: $SCRIPT_DIR（含源码与备份；确认不再需要请手动回收：trash-put $SCRIPT_DIR）"
  [ -d "$FIXED_DIR" ] && echo "    另有固定安装目录: $FIXED_DIR（如为同一安装的残留副本，可手动回收）"
fi
echo "    请重启 opencode 生效"
echo "UNINSTALL_DONE"
