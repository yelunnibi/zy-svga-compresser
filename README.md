# ZY SVGA Compresser

VSCode 扩展。在原 Mikas 图片压缩的基础上，把 **SVGA 动效压缩**做成了可调、可量化、可回滚的完整工具链。

支持 PNG / JPG / WebP / GIF / SVG / SVGA 六种格式，其中 **SVGA 是主功能**，完全本地处理，不依赖任何在线服务。

---

## 一、它解决什么问题

SVGA 用来看 UI 动效，比 GIF 小一个数量级。但它有两个天生的坑，素材在导出时不会帮你处理：

**坑 1：文件体积。** 动效帧数、帧率、纹理精度往往远超实际需要。一个 3 KB 的小图标动画，里面塞的纹理可能按 120×120 存着，而实际只显示 40×40。

**坑 2：解码内存。** 这是最反直觉的一条——**文件体积和内存占用是两个完全独立的量**。播放器会把每张纹理铺成 RGBA 位图常驻内存：

```
解码内存 = Σ(纹理宽 × 高) × 4 字节
```

它与体积、帧数、帧率**毫无关系**。所以「文件压到很小」不等于「内存很省」：一个几百 KB 的 SVGA，解码后占几十 MB 是常态。

本扩展针对这两点分别提供量化指标和可调参数。

---

## 二、支持的格式

| 格式 | 处理方式 | 需要网络 / API Key |
|---|---|---|
| **SVGA** | 本地处理（本扩展的核心能力） | 不需要 |
| **SVG** | 本地 SVGO 优化 | 不需要 |
| PNG / JPG / WebP / GIF | TinyPNG API | 需要 |

> **TinyPNG API Key 不配也能正常用。** 不配时只是「位图压缩」这条支路不可用，SVGA 与 SVG 完全不受影响。这属于未启用状态，不是错误。

---

## 三、核心能力

### 1. SVGA 可调压缩

压缩按固定五步执行，参数各自独立可配（`[5/5]` 写盘是必经步骤，其余四步不启用时是直通）：

| 步骤 | 做什么 | 降体积 | 降内存 |
|---|---|---|---|
| `[1/5]` 纹理重编码 | 保持原格式或转 PNG/JPEG/WebP，可调质量与调色板 | ✅ | ❌ |
| `[2/5]` 画布缩放 | 缩放 viewBox、逐帧 layout、transform、图形坐标 | ✅ | ✅ |
| `[3/5]` 抽帧 | 按整数步长抽帧，可选保持原时长 | ✅ | ❌ |
| `[4/5]` 回收无引用纹理 | 删除没有任何 sprite 引用的内嵌图片 | ✅ | ✅ |
| `[5/5]` 编码写盘 | 序列化 + zlib 压缩 | — | — |

几个必须说清的点：

- **只有「纹理分辨率」和「画布缩放」能降解码内存。** 编码质量、调色板、抽帧都不行——它们改的是「怎么存」，不是「多大」。
- **画布缩放会连带等比缩纹理**（否则白占内存），所以它同时降体积和降内存。代价是改变了播放尺寸，宿主 App 需要同步调整，因此默认关闭。
- **抽帧要配合 `keepDuration` 才有意义。** 只改 fps 数值会变成快放/慢放，时长变了但文件几乎没变小。
- **抽帧产生不了孤儿纹理**（图片引用挂在 sprite 上，抽帧只删帧不删 sprite），所以「抽帧 + 回收」并不能降内存。回收只对「素材换过、导出工具没清理」的闲置图有效。
- **带透明通道的纹理永远不会被转成 JPEG**，否则透明区域会变黑。
- **不会越压越大**：若某张纹理尺寸和格式都没变、重编码结果反而更大，则保留原图。

### 2. 解码内存估算

面板会算出并展示：

- 解码内存总量（`Σ 宽 × 高 × 4`）
- 纹理张数、最大的一张纹理
- 安全 / 警告 / 危险 风险等级（阈值可配）
- 按目标内存预算**反推**需要的纹理缩放比例

界面上的「纹理尺寸」显示的是**面积最大的那一张**，不是全部、不是总和——一个动画里通常有十几张尺寸差异很大的纹理。

### 3. 覆盖 + 自动备份 + 覆盖前校验

写盘方式三选一：

| 模式 | 行为 |
|---|---|
| `copy` | 另存为 `.min` 副本，原文件不动（默认） |
| `overwrite` | 直接覆盖原文件，无备份（不可逆） |
| `overwriteWithBackup` | 覆盖原文件并先备份（**推荐**） |

- 备份落在工作区的 `.zy-svga/backup/<时间戳>/`，带清单，支持单文件或整批还原，按 `backupKeep` 自动清理旧批次。
- **覆盖前会校验产物**（能否解码、源文件里本来能解析到位图的引用是否一张不少）。校验不通过就什么都不写。
- 一键还原上一次备份：命令面板执行「ZY SVGA：还原上一次备份」。

---

## 四、怎么用

四个入口，任选：

| 入口 | 操作 |
|---|---|
| **侧边栏** | 点 Activity Bar 上的插件图标，打开完整压缩面板（文件树 / 预览与内存报告 / 参数面板 三栏） |
| **右键菜单** | 在资源管理器或编辑器里右键任意图片 → 「用 ZY SVGA 压缩」；右键文件夹可整目录压缩 |
| **命令面板** | `用 ZY SVGA 压缩` |
| **诊断日志** | `ZY SVGA：导出诊断日志到文件` / `ZY SVGA：打开日志输出面板` |

面板里每个参数都能当场改、当场生效，不必先去设置页。

---

## 五、配置项

设置里搜 `zy-svga` 可看到全部 13 项。

### 通用

| 设置 | 默认 | 说明 |
|---|---|---|
| `zy-svga.tinypngApiKey` | 空 | 位图（PNG/JPG/WebP/GIF）压缩用。不配也能用 SVGA / SVG |
| `zy-svga.saveMode` | `copy` | 默认写盘方式，面板里可单次覆盖 |
| `zy-svga.forceOverwrite` | `false` | 遗留项：仅当 `saveMode` 未设置时生效 |
| `zy-svga.compressedFilePostfix` | `.min` | 存副本时追加的后缀 |
| `zy-svga.concurrency` | `6` | 并发任务数，调大可能增加 VSCode 内存占用 |
| `zy-svga.ignore` | 见下 | 忽略的 Glob 列表，**每项必须以分号结尾** |

`zy-svga.ignore` 默认值：

```
**/node_modules/**;
**/.zy-svga/**;
**/.git/**;
```

### SVGA

`zy-svga.svgaOptions` 是一组全局默认参数，面板里可逐次覆盖：

| 字段 | 默认 | 说明 |
|---|---|---|
| `fps.enabled` | `false` | 是否调整帧率 |
| `fps.target` | `0` | 目标 fps；`<=0` 或 `>=` 原 fps 时不生效 |
| `fps.keepDuration` | `true` | `true` 抽帧保时长（体积真降）；`false` 只改数值（时长会变） |
| `texture.mode` | `none` | `none` 不缩放 / `ratio` 等比 / `maxEdge` 限最长边 |
| `texture.ratio` | `1` | 等比缩放比例，0.05–1，**仅 `mode = ratio` 时生效** |
| `texture.maxEdge` | `0` | 最长边像素上限，**仅 `mode = maxEdge` 时生效** |
| `canvas.enabled` | `false` | 开启会改变播放尺寸，宿主 App 需同步调整 |
| `canvas.ratio` | `1` | 画布与坐标缩放比例，0.05–1 |
| `encode.keepFormat` | `true` | 保持原格式（推荐） |
| `encode.format` | `png` | `png` / `jpeg` / `webp`，仅 `keepFormat = false` 时生效 |
| `encode.quality` | `80` | 编码质量 1–100 |
| `encode.palette` | `true` | PNG 调色板量化，体积更小，颜色多时会有色带 |
| `reclaim.enabled` | `false` | 回收无 sprite 引用的闲置纹理 |

> ⚠️ **两个静默陷阱**（都跟 `texture` 有关）：
> 1. `texture.mode` 和 `texture.ratio` 是解耦的。`mode = none` 时 `ratio` 填任何值都不生效——界面会显示「纹理尺寸未缩放」，不是 bug。
> 2. 抽帧倍率会四舍五入：`step = max(1, round(原fps / 目标fps))`。降幅不足 1.5 倍时会 round 回 1，**等于完全没抽帧**。源 20 fps 要设到 13 以下才生效。

### 内存阈值

| 设置 | 默认 | 说明 |
|---|---|---|
| `zy-svga.memorySafeThreshold` | `30` | 低于此值（MB）视为安全 |
| `zy-svga.memoryDangerThreshold` | `80` | 高于此值提示低端机 OOM 风险 |
| `zy-svga.memoryBudget` | `30` | 生成纹理缩放建议时的目标内存（MB） |

### 安全与诊断

| 设置 | 默认 | 说明 |
|---|---|---|
| `zy-svga.backupKeep` | `20` | `.zy-svga/backup/` 下保留多少批备份，更旧的自动清理 |
| `zy-svga.validateBeforeOverwrite` | `true` | 覆盖前校验产物，建议保持开启 |
| `zy-svga.logLevel` | `debug` | `debug` 记录压缩管线每一步（逐张纹理、每步耗时、批次内每个文件），报问题时用这个。**改完需重载窗口生效** |

---

## 六、诊断日志

日志默认就记到 `debug` 级，压缩全过程可追溯：

```
svgaCompress#1 解析完成 24ms：源文件 504 KB，viewBox 800x460，fps 30，frames 210，版本 2.1.0
svgaCompress#1 生效参数 {"fps":{...},"texture":{...},"canvas":{...},"encode":{...}}
svgaCompress#1 资源盘点：内嵌图 12 张，sprite 28 个，被引用 key 14 个，闲置图 0 张(0 B)
svgaCompress#1 内存基准 46.7 MB（12 张纹理 × 宽 × 高 × 4 字节，与文件体积无关）
svgaCompress#1        图 img_13: 2400x1380 png 152 KB → 2400x1380 png 152 KB [重编码反而更大，保留原图]
svgaCompress#1 [1/5] 纹理重编码 1011ms：处理 12 张，平均缩放 1.000
svgaCompress#1 [2/5] 画布缩放 0ms：未启用
svgaCompress#1 [3/5] 抽帧 0ms：fps 30 → 10，帧 210 → 70，每 3 帧取 1，时长 7s
svgaCompress#1 [4/5] 回收无引用纹理 0ms：未开启；检测到闲置 0 张，保留 12 张
svgaCompress#1 [5/5] 编码写盘 38ms：产物 335 KB → /path/to/out.svga
svgaCompress#1 完成 out.svga：体积 504 KB → 335 KB（-33.6%），内存 46.7 MB → 46.7 MB，总耗时 1080ms
```

- 每张纹理一行，带前后尺寸与保留原因
- 每步带耗时；**未启用的步骤也会打**（否则分不清「没这步」和「日志漏了」）
- 任务号 `#N` 用于并发：`grep "#7"` 可拉出单个文件的完整时间线
- 单文件失败也进日志，带文件名、真实原因和调用栈

**日志会落盘**，路径在 VSCode 的 `globalStorage/logs/zy-svga-YYYYMMDD.log`，按天分文件、8 MB 轮转。所以**重载窗口不会丢日志**。

导出的日志文件分三段：本次会话 / 界面侧 / **磁盘历史（含重载之前的会话）**。

> 说明：扩展宿主的 `console.*` 只有 error 级会进 `exthost.log`，info/warn 全部丢弃。所以本扩展自带日志通道，不能靠 VSCode 自带的日志排查。

---

## 七、开发与打包

```bash
npm install
npm run setup:native          # 拉取 sharp 预编译原生模块 + libvips
npm run build                 # webpack（主进程）+ vite（webview），产物 rsync 到 dist/
npm run package               # 打包成 release/svgazip-<version>.vsix
```

本机若没装全局 `vsce`，用 npx 代替（并走国内镜像）：

```bash
npm_config_registry=https://registry.npmmirror.com \
  npx --yes @vscode/vsce@3.2.1 package --out release
```

- 主进程 TypeScript → `dist/extension.js`；webview 是 React 18 + Vite → `dist/image-compressor-dist/`。
- `release/svgazip-<version>.vsix` 的命名来自 `package.json` 的 `name` + `version`。
- 原生依赖必须保持目录层级（libvips 的 rpath 依赖相对位置），改动 `webpack.config.js` 的输出路径前请先读 `bin/setup-native.js`。

### 平台支持

| 平台 | 状态 |
|---|---|
| macOS arm64 / x64 | 支持（随包分发 libvips） |
| Windows x64 | 支持（随包分发四个 DLL） |
| Linux | **不在支持范围**（未随包分发 Linux 版 libvips） |

---

## 八、已知限制

1. **画布缩放会改变播放尺寸**，开启后宿主 App 必须同步调整，否则画面比例不对。
2. **纹理不能无限缩**。SVGA 播放时可能整体放大显示，缩过头会糊，建议留一点余量。
3. **抽帧对解码内存零影响**（帧不是图片，只是「把图摆在哪」的指令）。这是格式决定的，不是本扩展的缺陷。
4. **位图压缩支路依赖 TinyPNG**，需要配 API Key 且有网络。

---

## 九、来源与许可

本项目是 [AkiraBit/Mikas](https://github.com/AkiraBit/Mikas)（原作者 JaylenLee）的 fork，基于 MIT 许可分发，原始版权声明保留在 `LICENSE.txt`。

相对上游的主要改造：

- **可调的 SVGA 压缩参数**——上游把质量硬编码为 70 并固定重编码为 PNG，现在全部可配。
- **解码内存估算**——上游没有这个概念。
- **覆盖 + 自动备份 + 覆盖前校验**——上游只能另存副本。
- **跨平台原生依赖打包修复**——上游把 sharp 的原生模块打进 `dist/`，但打包后加载不了：sharp 通过相对路径解析 libvips（`@loader_path/../../vendor/<version>/<platform>/lib`），而 node-loader 把模块输出到 `dist/` 根，于是被解析到扩展目录之外。本 fork 把原生依赖按加载器期望的目录层级一并打包。

完整变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

**Enjoy!**
