#!/usr/bin/env node
/**
 * 打包前的硬校验：确认 dist 里带了完整的多平台原生依赖。
 *
 * 为什么需要：sharp 的原生方如果缺失，vsix 依然能打出来、也能装上，
 * 但用户在对应平台启动扩展时会直接抛 "Could not load the sharp module"。
 * 这类问题只有装到那台机器上才会暴露，必须在 CI 就拦掉。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const RELEASE = path.join(DIST, "node_modules", "sharp", "build", "Release");
const VENDOR = path.join(DIST, "node_modules", "sharp", "vendor");

const REQUIRED_NODE = [
  "sharp-darwin-arm64v8.node",
  "sharp-darwin-x64.node",
  "sharp-win32-x64.node",
  "sharp-win32-ia32.node",
];
const REQUIRED_WIN_DLL = [
  "libvips-42.dll",
  "libvips-cpp.dll",
  "libglib-2.0-0.dll",
  "libgobject-2.0-0.dll",
];
const REQUIRED_VIPS = ["darwin-arm64v8", "darwin-x64"];

const problems = [];

function checkFile(p, label) {
  if (!fs.existsSync(p)) problems.push(`缺少 ${label}: ${path.relative(ROOT, p)}`);
  else if (fs.statSync(p).size === 0) problems.push(`空文件 ${label}: ${path.relative(ROOT, p)}`);
}

// 1) 扩展主入口与 webview 产物
checkFile(path.join(DIST, "extension.js"), "扩展主入口 dist/extension.js");
checkFile(path.join(DIST, "image-compressor-dist", "index.html"), "webview 入口");

// 2) sharp 的 .node（按平台各一份）
for (const f of REQUIRED_NODE) checkFile(path.join(RELEASE, f), `sharp 原生模块 ${f}`);

// 3) Windows 所需的 DLL
for (const f of REQUIRED_WIN_DLL) checkFile(path.join(RELEASE, f), `Windows DLL ${f}`);

// 4) macOS 的 libvips 动态库（rpath 依赖 vendor/<ver>/<platform>/lib 的目录结构）
for (const p of REQUIRED_VIPS) {
  const lib = path.join(VENDOR, "8.14.5", p, "lib", "libvips-cpp.42.dylib");
  checkFile(lib, `libvips (${p})`);
}

// 5) 反例：不应该有 linux 的 libvips 混进来（本项目不声明支持 Linux）
const vendorDirs = fs.existsSync(VENDOR) ? fs.readdirSync(path.join(VENDOR, "8.14.5")) : [];
const linuxVips = vendorDirs.filter((d) => d.startsWith("linux"));
if (linuxVips.length) {
  console.log(`[warn] vendor 里混入了 Linux 平台库（不影响使用，只会增大体积）: ${linuxVips.join(", ")}`);
}

if (problems.length) {
  console.error("\n[verify-dist-native] ❌ 构建产物不完整：");
  for (const p of problems) console.error("  - " + p);
  console.error("\n多半是 `npm run setup:native` 没跑或下载失败。");
  process.exit(1);
}

const nodeFiles = fs.readdirSync(RELEASE).filter((f) => f.endsWith(".node"));
console.log(`[verify-dist-native] ✅ 通过：${nodeFiles.length} 个 sharp 平台模块，${REQUIRED_WIN_DLL.length} 个 Windows DLL，${REQUIRED_VIPS.length} 套 macOS libvips`);
