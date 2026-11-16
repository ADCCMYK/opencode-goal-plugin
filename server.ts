// V2 入口转出文件（**只做转出，不含任何逻辑**）
//
// 为什么需要它：opencode 2.x 对「配置 plugins 里直接写目录」的入口解析是
//   wg({directory}) → server: resolve(<目录>/server) 或 resolve(<目录>/index)
// —— 即只认目录根部的 `server.*` / `index.*`，**不读 package.json 的 exports**。
// 没有它 → 解析不到 server 入口 → 加载器**静默丢弃**（无日志、无报错），插件表现为"完全没生效"。
//
// 实现仍在 src/index.ts（真正的 V2 服务端插件，Plugin.define + setup(ctx)）；这里只把它转出去。
export { default } from "./src/index.ts"
