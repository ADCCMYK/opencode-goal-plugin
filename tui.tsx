// V2 TUI(CLI) 入口转出文件（**只做转出，不含任何逻辑**）
//
// 同 server.ts 的原因：opencode 2.x 对「配置 plugins 里直接写目录」的入口解析是
//   wg({directory}) → tui: resolve(<目录>/tui)
// —— 只认目录根部的 `tui.*`（不读 package.json 的 exports）；解析不到就静默跳过 TUI 半边。
//
// 实现仍在 src/tui-plugin.tsx（真正的 V2 CLI 插件：Plugin.define({ id, setup(context) }) + @opencode/plugin/tui）。
//   ⚠ 实现文件**故意不叫 tui.tsx**：根部这个入口必须叫 tui.tsx（V2 只解析 <目录>/tui，不读 package.json exports），
//     两者同名会让人以为"装了两个 TUI 插件"。改名为 tui-plugin.tsx 后一眼可分（server.ts ↔ src/index.ts 同理，名字本就不同）。
export { default } from "./src/tui-plugin.tsx"
