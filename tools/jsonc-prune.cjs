// JSON / JSONC 小工具：从配置文件的某个数组键里摘除“含指定子串”的项（供 deploy.sh / uninstall.sh 调用）。
//
// 为什么单独成文件：JSON/JSONC 编辑用 sed/awk 极脆弱（内联数组、尾逗号、注释都能坑死人），
// 内联在 shell 里又会把脚本撑得难读。独立文件 = 脚本里只调一行 + 可单独测试。
//
// 支持：JSON 与 JSONC（// 与 /* */ 注释、尾逗号）；顶层对象的指定数组键；按子串匹配；数组摘空可选连键删除；
//       改写前备份 .bak；解析失败则原文件不动。
//
// 退出码：0 = 已处理（或无需处理）；2 = 用法错误；3 = 文件不存在 / 无该键 / 键不是数组；4 = 解析失败（原文件未改动）
// 用法：node jsonc-prune.js <文件> --array-key plugins --match <子串> [--drop-key-if-empty] [--backup]
const fs = require("fs");

function stripJsonc(text) {
  const out = [];
  let inStr = false, esc = false, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inStr) {
      out.push(c);
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out.push(c); i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out.push(c);
    i++;
  }
  // 去掉尾逗号（, 后面只跟空白再跟 } 或 ]）
  return out.join("").replace(/,(\s*[}\]])/g, "$1");
}

function parseArgs(argv) {
  const args = argv.slice(1);
  const opts = { file: null, arrayKey: null, match: null, dropEmpty: false, backup: false };
  if (!args.length || args[0] === "-h" || args[0] === "--help") return { help: true };
  opts.file = args[0];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--array-key" && i + 1 < args.length) { opts.arrayKey = args[++i]; continue; }
    if (a === "--match" && i + 1 < args.length) { opts.match = args[++i]; continue; }
    if (a === "--drop-key-if-empty") { opts.dropEmpty = true; continue; }
    if (a === "--backup") { opts.backup = true; continue; }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(1)); // slice(1) 去掉 node 自身；parseArgs 再 slice(1) 去掉脚本名 ⇒ 首个参数才是文件
  if (opts.help) { console.log("用法：node jsonc-prune.js <文件> --array-key <键> --match <子串> [--drop-key-if-empty] [--backup]"); return 2; }
  if (!opts.file || !opts.arrayKey || !opts.match) { console.log("用法：node jsonc-prune.js <文件> --array-key <键> --match <子串> [--drop-key-if-empty] [--backup]"); return 2; }

  let raw;
  try { raw = fs.readFileSync(opts.file, "utf8"); } catch { return 3; }
  let cfg;
  try { cfg = JSON.parse(stripJsonc(raw)); } catch { return 4; }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || !Array.isArray(cfg[opts.arrayKey])) return 3;

  const arr = cfg[opts.arrayKey];
  const keep = arr.filter((p) => !JSON.stringify(p ?? "").includes(opts.match));
  if (keep.length === arr.length) return 0; // 没有本插件的项，无需改动
  if (opts.backup) fs.copyFileSync(opts.file, opts.file + ".bak");
  const dropped = keep.length === 0 && opts.dropEmpty;
  if (dropped) delete cfg[opts.arrayKey];
  else cfg[opts.arrayKey] = keep;
  fs.writeFileSync(opts.file, JSON.stringify(cfg, null, 2) + "\n");
  console.log("removed=" + (arr.length - keep.length) + " remaining=" + keep.length + " key_dropped=" + dropped);
  return 0;
}

process.exit(main());
