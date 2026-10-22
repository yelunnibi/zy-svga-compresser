#!/usr/bin/env node
/**
 * 裁掉 dist 里的 Linux 原生库。
 *
 * 为什么：CI runner 是 Linux，sharp 安装时会自动拉一份 linux-x64 的 libvips 和 .node。
 * webpack 的 CopyPlugin 会把整个 vendor 目录搬进 dist，产物因此凭空多出 ~17MB。
 * 本项目不声明支持 Linux（README「平台支持」），留着既占体积又是个隐形雷
 * —— 有 .node 没对应 .so 的平台，用户装了只会看到 "Could not load the sharp module"。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST_SHARP = path.join(ROOT, "dist", "node_modules", "sharp");
const RELEASE = path.join(DIST_SHARP, "build", "Release");
const VENDOR = path.join(DIST_SHARP, "vendor");

let removed = 0;
let freed = 0;

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? 0 : st.size;
  } catch {
    return 0;
  }
}

function rm(p) {
  if (!fs.existsSync(p)) return;
  const s = sizeOf(p);
  fs.rmSync(p, { recursive: true, force: true });
  removed++;
  freed += s;
  console.log(`[prune] 删除 ${path.relative(ROOT, p)}（${(s / 1024 / 1024).toFixed(1)} MB）`);
}

// 1) vendor 里的 Linux libvips：vendor/<version>/linux-*
if (fs.existsSync(VENDOR)) {
  for (const ver of fs.readdirSync(VENDOR)) {
    const verDir = path.join(VENDOR, ver);
    if (!fs.statSync(verDir).isDirectory()) continue;
    for (const platform of fs.readdirSync(verDir)) {
      if (platform.startsWith("linux")) rm(path.join(verDir, platform));
    }
  }
}

// 2) Linux 的 sharp 原生模块
if (fs.existsSync(RELEASE)) {
  for (const f of fs.readdirSync(RELEASE)) {
    if (f.startsWith("sharp-linux") && f.endsWith(".node")) rm(path.join(RELEASE, f));
  }
}

console.log(`[prune] 完成：删除 ${removed} 项，节省 ${(freed / 1024 / 1024).toFixed(1)} MB`);
