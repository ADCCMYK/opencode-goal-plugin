# opencode-goal-plugin

**目标持续推进插件**：为 [opencode](https://opencode.ai) 提供  `/goal` 风格的目标驱动自主工作流——给 AI 设一个目标，插件自动持续推进，直到完成、暂停或达到轮数上限，无需用户每轮催促。

> 面向**长时间自主任务**（如"实现 XX 功能，修到全绿，不完成不停止"）。由「z-goal 总规划师」主代理 + 事件驱动自动推送 + 阶段/代办双轨管理 + 多 Agent 并行调度构成完整闭环。

---

## 为什么需要它

普通会话中，AI 每完成一个回合就停下来等用户发话；做大型任务时用户必须反复输入"继续"。本插件把"持续推进"变成系统能力：

1. 用户设置一次目标（`/goal`）
2. 插件在每轮 AI 回合结束的**空闲窗口**自动推送「推进指令」（目标 + 当前流程 + 阶段 + 代办 + 计划文件）
3. z-goal agent 按指令自主探索 → 规划 → 执行 → 审计，直到调用 `audit` 收尾
4. 用户可随时 `/goal-pause` 暂停、`/goal-all` 查看进度、Esc 中断，或开启**迭代模式**让 AI 多轮打磨

---

## 功能特性

- **事件驱动插话，不轮询、不丢推送**
  - 每轮 `session.idle`（AI 回合自然完成）推一次推进指令，节奏即 AI 干活节奏
  - AI 连续干活时由消息完成事件按 `pushIntervalMs`（默认 10 分钟）限频提醒，保证长时间运行也能得到阶段/代办更新
  - 同一回合双驱动只推一次（按最后消息 id 去重）
  - 推送被 opencode 以 busy 拒绝 → 自动挂起，下个空闲窗口送达，不丢指令
- **探索 → 规划 → 执行 → 审计 四段流程**：AI 用 `goal` 工具自主流转；信息不足可随时回探索，不硬规划
- **阶段 + 阶段级代办**：目标拆大阶段（阶段含 `id/name/status`），每阶段内嵌代办清单；提交阶段完成时遗留代办自动补打勾
- **多 Agent 并行**：z-goal 是总规划师，按模块拆分多个子代理并行执行；子代理自动获得子目标（task prompt 一行引导）、完成后主代理批量标记阶段完成
- **迭代模式**：审计后不删目标，插件推送【迭代继续】指令，AI 迭代优化直到用户满意或达迭代上限（`/goal-iter` 单次开启或全局配置）
- **审计闭环**：`audit` 提交后推送【二次审计】做最终完成度确认；发现遗漏可自动重设目标继续
- **健壮的自动化**：子代理卡住自动中止并通知主代理（15 秒级检测）；已完成/失败子代理超期自动清理（仅删已完成/失败，进行中永不误删）；Esc 中断即时转暂停
- **多进程安全**：多个 opencode 实例/AI 共享同一目标文件（原子写入），各会话目标独立互不串扰
- **参数兼容模型习惯**：阶段/待办参数同时接受 JSON 数组或 JSON 字符串

---

## 安装与部署

前置：opencode（TUI + server 插件）、Node.js。

```bash
git clone <本仓库> && cd opencode-goal-plugin
npm install
bash deploy.sh
```

`deploy.sh` 完成（重启 opencode 后生效）：

| 部署项 | 生效位置 |
|---|---|
| server 插件（编译 `src/index.ts` → `dist/index.js`） | 注册进 `~/.config/opencode/opencode.jsonc` 插件条目（指向项目 dist） |
| TUI 插件 | `~/.config/opencode/tui-plugin/goal-config.tsx` |
| z-goal 主代理 | `~/.config/opencode/agents/z-goal.md` |
| 命令 `/goal` `/goal-iter` | 合并进 `opencode.jsonc`（agent = z-goal） |
| 权限：顶层 `permission.question: allow`；子代理预设 `general/explore/scout` 禁问用户 | 合并进 `opencode.jsonc`（已有密钥/MCP/provider 配置不覆盖） |

配置会在首次部署时初始化到 `~/.local/state/goal/config.json`（已存在则保留不动，用 `/goal-config` 或直接编辑）。

---

## 快速开始

```text
/goal 实现用户中心模块，含增删改查与权限校验，不修到全绿不停止
```

设置后即可放手。插件自动完成：

```
第 1 轮  探索：确认完成条件（读代码/搜索/验证）→ flow=plan
第 1 轮  规划：写方案文档 + update_stages 规划阶段（带各阶段代办）→ flow=execute
第 1 轮  执行：逐阶段推进，todos/stage 流转，子代理并行干活
第 1 轮  审计：audit 提交 → 二次审计确认 → 目标清理/保留
```

期间您随时可以：

| 操作 | 命令/按键 |
|---|---|
| 查看进度（侧栏面板实时显示所有目标） | 侧栏「目标推进」面板 / `/goal-all` |
| 暂停 / 恢复 | `/goal-pause` `/goal-resume`（或管理面板） |
| 修改目标文本（AI 立即收到通知） | `/goal-update` |
| 彻底停止并清除 | `/goal-stop` |
| Esc 中断当前生成 | 目标自动转暂停（迭代模式同） |
| 让 AI 迭代打磨（审计后不删目标） | `/goal-iter 目标描述` |

### TUI 命令一览

| 命令 | 别名 | 说明 |
|---|---|---|
| `/goal` | — | 设置目标并开始自主推进 |
| `/goal-iter` | — | 设置目标并临时开启迭代模式 |
| `/goal-all` | `/goal-list` `/goals` | 全部目标管理：Enter 管理、Ctrl+d 删除（两次确认） |
| `/goal-subs` | `/goal-subagents` `/goal-children` | 子代理会话列表：跳转 / 删除 |
| `/goal-fork` | `/goal-copy` | 把某目标复制到当前会话（完整或仅文本） |
| `/goal-update` | — | 修改当前会话目标文本（即时通知 AI） |
| `/goal-config` | `/goal-cfg` | 13 项运行配置可视化调整 |
| `/goal-stop` | — | 停止并清除当前目标 |
| `/goal-pause` / `/goal-resume` | — | 暂停 / 恢复推进 |
| `/goal-status` | — | 查看当前目标状态快照 |
| `/goal-cleanup` | `/goal-clean` | 清理全部已完成/失败子代理（二次确认） |
| `/goal-clearall` | — | 一键清空所有目标记录（二次确认） |

快捷键：`Ctrl+Shift+G` 折叠侧栏面板；目标/子代理列表内 `Ctrl+d` 删除（两次确认）、`Ctrl+o` 切换排序、Fork 时 `Ctrl+1`（完整）/ `Ctrl+2`（仅文本）/ `Ctrl+y`（默认完整）。

---

## 工作模型

### 数据模型（每个会话一个目标，全局共享一个文件）

```
目标目标（GoalEntry）
├─ state：active 推进中 / paused 已暂停 / limited 达轮数上限 / iterating 待迭代 / done 已完成
├─ flow：explore 探索 → plan 规划 → execute 执行 → audit 审计
├─ stages：目标拆分的阶段（含 id/name/status）
│    └─ todos：该阶段的代办（含 status：pending / in_progress / completed）
├─ planFile：方案文档路径（随推送告知 AI，执行前必写）
└─ history / iteration：迭代历史与轮次信息
```

- **流程 ≠ 阶段**：流程是"当前走到哪个环节"（探索/规划/执行/审计，AI 用 `flow` 切换）；阶段是"工作分解清单"（AI 规划、推进、批量标记完成）
- **代办随阶段**：规划阶段时一次把各阶段代办写全（`update_stages` 的 stage 对象可带 `todos`）；执行中 `todos` 默认作用于当前 `in_progress` 阶段，也可 `stageID` 指定任意阶段
- **自动补勾**：阶段提交 `completed` 时，该阶段未打勾的代办（含遗留 pending）自动全部打勾，不留空挂

### 推进推送（AI 每轮收到的系统消息）

```
（第 N 轮，上限 M 轮）

【目标】<目标文本>

【当前流程】<探索/规划/执行/审计 + 该环节做法提示>

【迭代】<迭代状态与当前迭代轮>

【系统提醒】阶段/代办完成一项更新一项……

【目标阶段】▶ 当前阶段 / ✓ 已完成 / ○ 待办阶段

计划文件：<方案文档路径>

【代办】（当前阶段：…）▶ [in_progress] … / ✓ [completed] …（规划后才出现）
```

### goal 工具（AI 侧推进入口，唯一推进工具）

| action | 用途 |
|---|---|
| `set` | 设置/更新目标 |
| `flow` | 切换流程（explore/plan/execute/audit，可回退） |
| `update_stages` | 整体规划/重规划阶段（可携带各阶段 todos） |
| `stage` | 阶段状态流转（单个或 `updates` 批量） |
| `todos` | 更新代办清单（缺省当前阶段，可 `stageID` 指定） |
| `audit` | 完成审计收尾（非迭代：清理/保留+二次审计；迭代：转 iterating，推送【迭代继续】） |
| `iterate` / `finish` | 迭代模式：开始下一轮 / 结束迭代 |
| `status` / `pause` / `resume` / `clear` / `cleanup` | 查看 / 暂停 / 恢复 / 清除 / 手动清理子代理 |

### z-goal 主代理

- 内置「总规划师」人设：多 Agent 并行拆解、文件工具并发、阶段自动流转、长任务后台化、审计强制收尾
- 规则通过推送逐轮注入（而非只在开局提一次），保证长会话不跑偏
- **子代理策略**：子代理不询问用户、永不迭代（迭代仅主代理）、自动清理不误删进行中

---

## 配置（`/goal-config` 可视化调整，存储于 `~/.local/state/goal/config.json`）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `maxTurns` | 100 | 目标自动推进最大轮数（0 = 不限，迭代模式目标不设内部上限） |
| `pushIntervalMs` | 600000 | 连续干活时消息驱动的提醒间隔（10 分钟；最小 30 秒） |
| `summaryLen` | 30 | 面板/列表目标摘要字数 |
| `planDir` | `default` | 方案文档目录：`default` = `/tmp/plan`、`workspace` = 项目 `.plan`、自定义绝对路径 |
| `cleanupDays` | 3 | 已完成/失败子代理自动清理天数 |
| `maxRetainedSubagents` | 60 | 已完成/失败子代理保留上限（0 = 不限），超出删最旧 |
| `stuckTimeoutMs` | 900000 | 卡住判定：超过该时长无活动即中止子代理（15 秒级检测） |
| `iterateMode` | false | 全局迭代模式开关（audit 后进入迭代循环） |
| `iterateMaxRounds` | 10 | 迭代轮数上限（0 = 无限） |
| `iterAskMode` | `first` | 迭代方向询问频率：`first` 首轮一次全局生效 / `every` 每轮都问 |
| `auditDelete` | true | audit/finish 后默认删除目标（关闭则保留标记 done） |
| `forkPaused` | true | Fork 目标到当前会话后默认暂停（需手动恢复） |
| `autoApprovePermissions` | true | 目标会话自动批准权限请求（不弹窗），非目标会话自动还原询问 |

> 插件 options（opencode.jsonc 插件条目）提供 `maxTurns` / `stuckTimeoutMs` / `autoAbortSubagent` / `cleanupDays` / `maxRetainedSubagents` 等默认值，运行后以 config.json 为准。

---

## 架构一览

```
┌─────────────────────────── opencode 进程 ───────────────────────────┐
│  TUI 插件（goal-config.tsx）            server 插件（dist/index.js） │
│  · 侧栏「目标推进」实时面板               · 事件引擎：session.idle /      │
│  · /goal-* 命令与快捷键                    message.updated / error       │
│  · auto-accept 自动批准联动             · 推进循环：读目标 → 构造推进     │
│                                         指令 → 插话推送（去重/限频/挂起  │
│                                         重试）                          │
│  · watch goals.json 实时刷新             · goal 工具（AI 侧）            │
│                                          · 卡住检测 / 子代理清理定时器    │
└──────────────────────┬──────────────────────────┬───────────────────┘
                       │                          │
        ~/.local/state/goal/goals.json ◄──────────┘（全局共享，原子写入）
        ~/.local/state/goal/config.json / iter-asked.json / sub-goal-guided.json
        ~/.config/opencode/opencode.jsonc（插件/命令/权限注册）

  z-goal.md（主代理人设）⇄ 推送 ⇄ 每轮自动推进指令
```

- **server 插件**负责状态机与推送；**TUI 插件**负责可视化与用户操作入口；两者经 `goals.json` 协作，`watch` 文件变化实时同步
- 多 opencode 实例（同一 HOME）可同时运行：目标文件原子写入，各自会话面板实时显示全部目标
- 权限注入：主会话顶层 `question: allow`（规划阶段 AI 可向你澄清）；子代理预设 `general/explore/scout` 禁问用户、外部目录自动批准（不阻塞多 Agent 流程）

---

## 目录结构

```
opencode-goal-plugin/
├─ src/index.ts            server 插件源码（状态机 + 推送引擎 + goal 工具）
├─ dist/index.js           构建产物（opencode.jsonc 引用）
├─ goal-config.tsx         TUI 插件源码（deploy 复制到 tui-plugin/）
├─ agents/z-goal.md        z-goal 主代理提示词
├─ config.default.json     运行配置初始模板
├─ deploy.sh / backup.sh   部署 / 备份（备份自动脱敏密钥）
└─ package.json            npm run build = esbuild 打包
```

---

## License

[MIT](LICENSE)

Copyright (c) 2026 opencode-goal-plugin contributors
