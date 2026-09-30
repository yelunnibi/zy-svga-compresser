#!/usr/bin/env node
/**
 * 拉取 sharp 的跨平台原生依赖，供打包发布使用。
 *
 * 为什么需要这个脚本：
 * 1. sharp 的原生模块（.node）在运行时还需要同级的 libvips 动态库：
 *    - macOS / Linux：走 rpath `@loader_path/../../vendor/<版本>/<平台>/lib`
 *    - Windows：需要与 .node 同目录的 4 个 DLL（libvips-cpp / libvips-42 / libglib / libgobject）
 * 2. 本机 npm 官方源不可达，统一改用 npmmirror 的二进制镜像。
 * 3. sharp 的 npm 安装脚本只拉当前平台，发布需要多平台。
 *
 * 运行：node bin/setup-native.js
 * 覆盖平台：PLATFORMS=darwin-arm64v8,darwin-x64,win32-x64 node bin/setup-native.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SHARP_DIR = path.join(ROOT, "node_modules", "sharp");
const RELEASE_DIR = path.join(SHARP_DIR, "build", "Release");
const VENDOR_DIR = path.join(SHARP_DIR, "vendor");
const NATIVE_NODE_DIR = path.join(ROOT, "assets", "native-node");
const TMP_DIR = path.join(ROOT, "node_modules", ".zy-svga-native-tmp");

const SHARP_MIRROR = "https://registry.npmmirror.com/-/binary/sharp";
const VIPS_MIRROR = "https://registry.npmmirror.com/-/binary/sharp-libvips";

/** 该版本 sharp 只发布了 napi-v7 预编译包；napi 是 ABI 稳定的，Node 18+ 通用 */
const NAPI = "napi-v7";

/** tarball 文件名里的平台后缀 → 解压出的 .node 文件名 */
const NODE_PREBUILDS = {
  "darwin-arm64": "sharp-darwin-arm64v8.node",
  "darwin-x64": "sharp-darwin-x64.node",
  "linux-arm64": "sharp-linux-arm64v8.node",
  "linux-x64": "sharp-linux-x64.node",
  "linuxmusl-arm64": "sharp-linuxmusl-arm64v8.node",
  "win32-ia32": "sharp-win32-ia32.node",
  "win32-x64": "sharp-win32-x64.node",
};

/** 需要随包分发的 libvips 平台（与本项目声明支持的平台一致） */
const VIPS_PLATFORMS = ["darwin-arm64v8", "darwin-x64", "win32-x64"];

/** Windows 上 .node 真正依赖的 DLL（已用 PE 导入表解析确认） */
const WIN_DLLS = ["libvips-42.dll", "libglib-2.0-0.dll", "libgobject-2.0-0.dll"];

function log(msg) {
  console.log(`[setup-native] ${msg}`);
}

function fetch(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    log(`缓存命中 ${path.basename(dest)}`);
    return;
  }
  log(`下载 ${url}`);
  execFileSync("curl", ["-fsSL", "--retry", "3", "--max-time", "300", "-o", dest, url], { stdio: "inherit" });
}

/** 读取 npm 安装的 sharp 期望的 libvips 版本，避免版本硬编码漂移 */
function detectVipsVersion() {
  if (process.env.VIPS_VERSION) return process.env.VIPS_VERSION;
  try {
    const dirs = fs
      .readdirSync(VENDOR_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (dirs.length) return dirs[0];
  } catch {
    /* 忽略 */
  }
  return "8.14.5";
}

function main() {
  if (!fs.existsSync(SHARP_DIR)) {
    console.error("找不到 node_modules/sharp，请先执行 npm install");
    process.exit(1);
  }
  const sharpVersion = require(path.join(SHARP_DIR, "package.json")).version;
  const vipsVersion = detectVipsVersion();
  log(`sharp ${sharpVersion} / libvips ${vipsVersion}`);

  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(NATIVE_NODE_DIR, { recursive: true });

  const platforms = (process.env.PLATFORMS || Object.keys(NODE_PREBUILDS).join(",")).split(",").map((s) => s.trim());

  // 1) 各平台预编译 .node
  for (const p of platforms) {
    const nodeName = NODE_PREBUILDS[p];
    if (!nodeName) {
      log(`跳过未知平台 ${p}`);
      continue;
    }
    if (fs.existsSync(path.join(RELEASE_DIR, nodeName))) {
      log(`已存在 ${nodeName}`);
      continue;
    }
    const tarName = `sharp-v${sharpVersion}-${NAPI}-${p}.tar.gz`;
    const tarPath = path.join(TMP_DIR, tarName);
    fetch(`${SHARP_MIRROR}/v${sharpVersion}/${tarName}`, tarPath);
    execFileSync("tar", ["xzf", tarPath, "-C", TMP_DIR], { stdio: "inherit" });
    fs.copyFileSync(path.join(TMP_DIR, "build", "Release", nodeName), path.join(RELEASE_DIR, nodeName));
    log(`就位 ${nodeName}`);
  }

  // 2) libvips 动态库（macOS / Linux 走 vendor，Windows 走 DLL）
  for (const p of VIPS_PLATFORMS) {
    // VIPS_PLATFORMS 的命名与 .node 文件名里的平台标识一致，直接据此判断是否需要
    if (!fs.existsSync(path.join(RELEASE_DIR, `sharp-${p}.node`))) {
      log(`未声明平台 ${p}，跳过其 libvips`);
      continue;
    }
    const brName = `libvips-${vipsVersion}-${p}.tar.br`;
    const brPath = path.join(TMP_DIR, brName);
    fetch(`${VIPS_MIRROR}/v${vipsVersion}/${brName}`, brPath);

    const extractDir = path.join(TMP_DIR, `ex-${p}`);
    const doneFlag = path.join(extractDir, ".done");
    if (!fs.existsSync(doneFlag)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      const tarPath = brPath.replace(/\.br$/, "");
      fs.writeFileSync(tarPath, zlib.brotliDecompressSync(fs.readFileSync(brPath)));
      execFileSync("tar", ["xf", tarPath, "-C", extractDir], { stdio: "inherit" });
      fs.writeFileSync(doneFlag, "");
    }

    if (p.startsWith("win32")) {
      for (const dll of WIN_DLLS) {
        fs.copyFileSync(path.join(extractDir, "lib", dll), path.join(NATIVE_NODE_DIR, dll));
      }
      log(`Windows DLL 已就位：${WIN_DLLS.join(", ")}`);
    } else {
      const target = path.join(VENDOR_DIR, vipsVersion, p);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(path.join(extractDir, "lib"), path.join(target, "lib"), { recursive: true });
      for (const f of ["versions.json", "platform.json", "THIRD-PARTY-NOTICES.md"]) {
        const src = path.join(extractDir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, f));
      }
      log(`vendor 已就位：${p}`);
    }
  }

  // Windows 的 libvips-cpp.dll 来自 sharp 自己的预编译包
  const cppDll = path.join(RELEASE_DIR, "libvips-cpp.dll");
  if (fs.existsSync(cppDll)) {
    fs.copyFileSync(cppDll, path.join(NATIVE_NODE_DIR, "libvips-cpp.dll"));
    log("libvips-cpp.dll 已就位");
  } else if (platforms.some((p) => p.startsWith("win32"))) {
    log("提示：未找到 libvips-cpp.dll，请确认已下载 win32 平台的 sharp 预编译包");
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  log("完成。接下来可执行构建，例如 npm run build");
}

main();
