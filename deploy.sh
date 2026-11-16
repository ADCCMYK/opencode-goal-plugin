#!/bin/bash
# opencode 目标推进插件 一键部署 + 配置合并脚本
# 用法：bash deploy.sh [用户名]   （任意目录执行；省略用户=当前用户）
# 固定安装：服务端插件始终固定安装到目标用户的 ~/opencode-goal-plugin（与解压目录无关，
#           解压目录仅作安装源；opencode.jsonc 的 plugins 引用固定**目录** ~/opencode-goal-plugin（V2 只收目录，入口在目录根部 server.*/tui.*））
# 功能：
#   1. 固定安装项目文件到 ~/opencode-goal-plugin + 编译 server 插件 + 校验 TUI 插件语法
#   2. 部署 TUI 插件（goal-config.tsx + tui.json）与 z-goal agent 提示词（z-goal.md）到目标用户
#   3. 合并目标用户 ~/.config/opencode/opencode.jsonc
#      （去重：缺失追加；已存在且路径不一致时自动更新为固定路径）
#      原配置备份为同目录 .bak
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- 定位安装源（支持 项目根 与 备份解压根/plugin 两种结构）----
if [ -f "$SCRIPT_DIR/package.json" ]; then
  SRC_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/plugin/package.json" ]; then
  SRC_DIR="$SCRIPT_DIR/plugin"
else
  SRC_DIR="$SCRIPT_DIR"
fi
[ -f "$SRC_DIR/package.json" ] || { echo "ERROR: 未找到插件项目 (package.json)"; exit 1; }

# ---- 部署目标用户（默认当前用户；bash deploy.sh [用户名] 选择部署）----
TARGET_USER="${1:-$DEPLOY_USER}"
if [ -n "$TARGET_USER" ]; then
  TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  [ -n "$TARGET_HOME" ] || { echo "ERROR: 用户不存在: $TARGET_USER"; exit 1; }
else
  TARGET_HOME="$HOME"
fi

# ---- 固定安装目录（服务端插件唯一安装位置，与解压目录无关）----
TARGET_PLUGIN_DIR="$TARGET_HOME/opencode-goal-plugin"

# ---- 定位 TUI 插件目录 ----
if [ -d "$SCRIPT_DIR/tui" ]; then
  TUI_DIR="$SCRIPT_DIR/tui"
else
  TUI_DIR="${TUI_DIR:-$TARGET_HOME/.config/opencode/tui-plugin}"
fi

# ---- 配置文件（默认目标用户；可用 GOAL_CONFIG 覆盖，便于测试）----
CONFIG="${GOAL_CONFIG:-$TARGET_HOME/.config/opencode/opencode.jsonc}"

echo "==> 部署目标用户: ${TARGET_USER:-$USER (当前用户)}"
echo "==> 安装源: $SRC_DIR"
echo "==> 固定安装目录: $TARGET_PLUGIN_DIR"
echo "==> 配置文件: $CONFIG"

# ---- 0. 固定安装：项目文件复制到 ~/opencode-goal-plugin（解压目录仅作安装源）
#     已在固定目录内运行（本机/重复部署）→ 跳过复制，保持幂等
if [ "$(realpath -m "$SRC_DIR")" != "$(realpath -m "$TARGET_PLUGIN_DIR")" ]; then
  echo "==> 固定安装到 $TARGET_PLUGIN_DIR（解压目录仅作安装源）"
  mkdir -p "$TARGET_PLUGIN_DIR"
  # ⚠ 必须包含 V2 根入口 server.ts / tui.tsx：V2 只解析 <目录>/server 与 <目录>/tui，
  #   漏了就会出现"复制成功但插件不加载"的残废安装（本行曾漏 server.ts/tui.tsx，已被沙箱测试抓到）
  for f in src tools server.ts tui.tsx package.json deploy.sh uninstall.sh README.md LICENSE docs agents; do
    if [ -e "$SRC_DIR/$f" ]; then
      cp -rf "$SRC_DIR/$f" "$TARGET_PLUGIN_DIR/"
    fi
  done
  echo "    + 项目文件已就位: $TARGET_PLUGIN_DIR"
else
  echo "==> 已在固定安装目录内运行，跳过复制"
fi
PLUGIN_DIR="$TARGET_PLUGIN_DIR"

# ---- 1. V2 入口自检（V2 直接加载 .ts/.tsx 源码，无需打包；dist/ 仅供 V1 使用）----
echo "==> 自检 V2 插件入口"
cd "$PLUGIN_DIR"
if [ -f "$PLUGIN_DIR/src/index.ts" ]; then
  echo "    + 服务端实现: src/index.ts（V2 直接加载）"
else
  echo "    WARN: 未找到 src/index.ts（扁平解压结构），V2 服务端将无法加载"
fi
if [ -f "$PLUGIN_DIR/src/tui-plugin.tsx" ]; then
  echo "    + TUI 实现: src/tui-plugin.tsx（V2 直接加载）"
else
  echo "    WARN: 未找到 src/tui-plugin.tsx，TUI 半边将不加载"
fi
# V2：注册路径是「插件目录」本身（V1 注册的是 dist/index.js；V2 只收目录，且只认目录根部 server.* / tui.*）
DIST="$PLUGIN_DIR"
[ -f "$PLUGIN_DIR/server.ts" ] || { echo "ERROR: 缺少 V2 服务端入口 $PLUGIN_DIR/server.ts（V2 只解析 <目录>/server 或 <目录>/index）"; exit 1; }
[ -f "$PLUGIN_DIR/tui.tsx" ] || echo "    WARN: 缺少 V2 TUI 入口 $PLUGIN_DIR/tui.tsx（TUI 半边不会加载）"
echo "    插件目录（V2 注册路径）: $DIST"

# ---- 2. 校验 TUI 插件语法（V2：校验插件目录内的 src/tui-plugin.tsx）----
#   ⚠ 此前校验的是 $TUI_DIR/goal-config.tsx（V1 遗留文件）：语义错（V2 不加载它）+ 一旦该文件缺失/损坏
#     就会让整个安装中断（沙箱测试实测中断）。V2 应校验真正的 TUI 实现 src/tui-plugin.tsx。
echo "==> 校验 TUI 插件语法"
if [ -f "$PLUGIN_DIR/src/tui-plugin.tsx" ]; then
  npx -y esbuild "$PLUGIN_DIR/src/tui-plugin.tsx" \
    --loader:.tsx=tsx --jsx=automatic --jsx-import-source=@opentui/solid \
    --bundle --external:@opencode/plugin --external:@opencode/plugin/tui \
    --external:solid-js --external:@opentui/solid --external:@opentui/solid/jsx-runtime \
    --platform=node --format=esm \
    --outfile=/tmp/opencode/tui-check.mjs
  echo "    TUI OK"
else
  echo "    WARN: 未找到 $PLUGIN_DIR/src/tui-plugin.tsx，跳过校验"
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
# ---- V2 不再部署独立的 TUI 插件文件；这里改为「停用 V1 遗留」----
#   V1 时代：goal-config.tsx 复制到 ~/.config/opencode/tui-plugin/ 生效；
#   V2 时代：TUI 半边由「插件目录」根部 tui.tsx 提供（并登记在 cli.json），**V2 不读 tui-plugin/ 目录**
#   （实测：V2 二进制里 "tui-plugin" 命中 0 次）⇒ 该文件是纯 V1 遗留：留着会让人误判"还在用 V1"，
#   直接删又丢失回退能力 → 处理成「改名为 .v1-backup 保留」，可随时改回（幂等：已改名则跳过）。
V1_TUI_FILE="$TARGET_HOME/.config/opencode/tui-plugin/goal-config.tsx"
if [ -f "$V1_TUI_FILE" ] && [ ! -f "$V1_TUI_FILE.v1-backup" ]; then
  mv -f "$V1_TUI_FILE" "$V1_TUI_FILE.v1-backup"
  echo "    - V1 遗留 TUI 文件已停用（改名保留，可随时改回）: goal-config.tsx → goal-config.tsx.v1-backup"
fi
# V1 遗留二：~/.config/opencode/tui.json（V1 时代的 TUI 注册，指向刚被停用的 goal-config.tsx）
#   用独立小工具 tools/jsonc-prune.cjs 摘除本插件项（别人的项原样保留）；非常规结构时退回"仅本插件才停用"判断。
V1_TUI_JSON="$TARGET_HOME/.config/opencode/tui.json"
if [ -f "$V1_TUI_JSON" ] && grep -q "goal-config" "$V1_TUI_JSON" 2>/dev/null; then
  # V1 真机形态是 {"plugin": ["./tui-plugin/goal-config.tsx"]} ⇒ 先试 plugin，再试 plugins
  # ⚠ 本脚本是 set -e：helper 非 0 退出（结构不符/解析失败）不能让安装中断 ⇒ 一律 `|| true` 兜住
  out=""
  for k in plugin plugins; do
    out="$(node "$SCRIPT_DIR/tools/jsonc-prune.cjs" "$V1_TUI_JSON" --array-key "$k" --match "goal-config" --drop-key-if-empty --backup 2>/dev/null || true)"
    [ -n "$out" ] && break
  done
  if [ -n "$out" ]; then
    echo "    - V1 遗留 tui.json 已摘除本插件项（$out；已备份 .bak）"
  else
    refs_total="$(grep -o '\.tsx\|\.ts\|\.js' "$V1_TUI_JSON" | wc -l | tr -d ' ')"
    refs_ours="$(grep -o 'goal-config' "$V1_TUI_JSON" | wc -l | tr -d ' ')"
    if [ "$refs_total" -le "$refs_ours" ]; then
      mv -f "$V1_TUI_JSON" "$V1_TUI_JSON.v1-backup"
      echo "    - V1 遗留 tui.json 仅引用本插件 → 已停用（改名保留）: tui.json → tui.json.v1-backup"
    else
      echo "    ! V1 遗留 tui.json 还引用其他 TUI 插件 → 保留不动，请手动摘除本插件项: $V1_TUI_JSON"
    fi
  fi
fi
# V1 遗留三：~/.config/opencode/plugin/ 下本插件的残留（V1 的自动加载目录；V2 只认 plugins 注册，不解析该目录内容）
for f in "$TARGET_HOME/.config/opencode/plugin/"*goal*; do
  [ -e "$f" ] || continue
  mv -f "$f" "$f.v1-backup"
  echo "    - V1 遗留自动加载目录残留已停用（改名保留）: $(basename "$f") → $(basename "$f").v1-backup"
done
# 注：cli.json 登记与「有没有 TUI 源码」无关（此前被耦合在同一 if 里，源码缺失时会漏登记）
if [ -n "$PLUGIN_DIR" ]; then
  # V2 终端(CLI)插件登记：**默认不做**。
  #   为什么默认关：opencode.jsonc 的 plugins（目录形态）**本身就会解析出 server + tui 两半**
  #   （`<目录>/server`、`<目录>/tui`）⇒ 再往 cli.json 写一条同样的插件目录，可能让 TUI 半边被加载两次
  #   （用户实测反馈"为什么两个 tui"）。旧装的 cli.json 残留由 uninstall.sh 摘除。
  #   万一某环境下 TUI 半边确实不加载：`GOAL_REGISTER_CLI_JSON=1 bash deploy.sh` 一键恢复登记。
  if [ "${GOAL_REGISTER_CLI_JSON:-0}" = "1" ]; then
    echo "    + cli.json 登记（GOAL_REGISTER_CLI_JSON=1 显式开启）"
    CLI_JSON_TARGET="$TARGET_HOME/.config/opencode/cli.json"
    export GOAL_CLI_JSON="$CLI_JSON_TARGET"
    export GOAL_PLUGIN_DIR_FOR_CLI="$PLUGIN_DIR"
    node "$SCRIPT_DIR/tools/cli-json-register.cjs"
  else
    echo "    + 跳过 cli.json 登记（默认：opencode.jsonc 的 plugins 已足够解析 server+tui 两半）"
  fi
else
  echo "    WARN: 未取到插件目录（PLUGIN_DIR 为空），跳过 cli.json 登记（现有配置不受影响）"
fi
# agent 源查找顺序：agents/ 目录 → 扁平 → 包内 .config（同级/包内）→ 已部署位置
AGENT_SRC=""
if [ -f "$SCRIPT_DIR/agents/z-goal.md" ]; then
  AGENT_SRC="$SCRIPT_DIR/agents/z-goal.md"
elif [ -f "$SCRIPT_DIR/z-goal.md" ]; then
  AGENT_SRC="$SCRIPT_DIR/z-goal.md"
elif [ -f "$SCRIPT_DIR/.config/opencode/agents/z-goal.md" ]; then
  AGENT_SRC="$SCRIPT_DIR/.config/opencode/agents/z-goal.md"
elif [ -f "$SCRIPT_DIR/../.config/opencode/agents/z-goal.md" ]; then
  AGENT_SRC="$SCRIPT_DIR/../.config/opencode/agents/z-goal.md"
elif [ -f "$TARGET_HOME/.config/opencode/agents/z-goal.md" ]; then
  AGENT_SRC="$TARGET_HOME/.config/opencode/agents/z-goal.md"
fi
if [ -n "$AGENT_SRC" ]; then
  mkdir -p "$TARGET_HOME/.config/opencode/agents"
  AGENT_SRC_R="$(realpath -m "$AGENT_SRC")"
  AGENT_TARGET_R="$(realpath -m "$TARGET_HOME/.config/opencode/agents/z-goal.md")"
  if [ "$AGENT_SRC_R" != "$AGENT_TARGET_R" ]; then
    cp -f "$AGENT_SRC_R" "$AGENT_TARGET_R"
  else
    echo "    + z-goal agent 已在生效位置（跳过复制）"
  fi
  echo "    + z-goal agent: $TARGET_HOME/.config/opencode/agents/z-goal.md"
else
  echo "    WARN: 未找到 z-goal 提示词（agents/、扁平 z-goal.md 或包内 .config），跳过 agent 部署（现有配置不受影响）"
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
  node "$SCRIPT_DIR/tools/opencode-config-merge.cjs"

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
