# Change Log

All notable changes to the "zy-svga-compresser" extension will be documented in this file.

- 🐛 bugfix
- 🆕 new features
- 🤖️ optimize

## [Released]

### v0.0.11(2026-09-30)

- [🐛] **帧率优化：目标帧率现在会被如实执行，且不再把时长拉长**。
      原来先定「整数抽帧步长」再倒推帧率（`step = round(原fps/目标)`、`fps = round2(原fps/step)`），
      有两个后果：① 用户设 13fps 实际只拿到 10fps；② 分数帧率被 protobuf 的
      **int32 截断**（20/3 = 6.67 → 存成 6），于是标着「保时长」却把时长拉长了
      （100 帧 @20fps 设 7fps → 34 帧 @6fps = 5.667s，原 5s）。
      现在改为**以取整后的目标帧率为锚**，帧数按「时长不变」反推
      （`帧数 = round(原帧数 × 新帧率 ÷ 原帧率)`），并用首尾对齐的最近邻取样落到每一帧。
      实测 100 帧 @20fps：设 13fps → 65 帧 @13fps（旧：50 帧 @10fps）；
      设 7fps → 35 帧 @7fps / 5.000s（旧：34 帧 @6fps / 5.667s）；设 19fps → 95 帧 @19fps（旧：等于没抽）。
      代价是帧数取整带来的**不超过半帧**的时长误差（10fps 时 ≤50ms），界面与日志都会如实回显。
- [🐛] 界面口径同步：SVGA 参数面板 / 压缩条的回显改为与主进程同一套算法（`computeFpsPlan`），
      不再各自算一套；「平均每 N 帧取 1」支持小数步长（如 1.54），与实际落盘一致。

### v0.0.10(2026-09-30)

- [🐛] **抽帧丢尾帧修复（会丢「最终动画」的严重 bug）**。`applyFrameStep` 原来用
      `frames.filter((_, i) => i % step === 0)`，只会保留下标 0、step、2·step…，当原帧数
      不是 step 的整数倍时**原片最后一帧永远不会入选**。播放器终止条件是
      `currentFrame = min(frames-1, …)`，产物只播到新末帧 —— 于是结尾那段动画（往往是
      「最终定格/结果」）被整段裁掉。实测 `slop_angle.svga`（100 帧、fps 20→10、step 2）
      丢失第 99 帧，机器人滑入到位的收尾段消失。
      现改为**首尾对齐的最近邻取样**：按 `k·(n-1)/(m-1)` 取下标，保证首帧与末帧都在，
      中间均匀落点，帧数仍为 `ceil(n/step)`（时长不变）。渲染比对：修复后产物末帧与
      原始末帧**像素完全一致（差异 0.000%）**。

### v0.0.9(2026-10-08)

- [🐛] 预览面板「眼睛跑位」修复：官方 `svgaplayerweb` 命中已解码图片缓存时执行
      `drawImage(img, 0, 0)`，只按图片原始像素绘制、完全忽略 `layout`。纹理被压缩缩小后
      位图会被画小（矢量图层不受影响），看起来像眼睛从头上跑到身体上。现于
      `setVideoItem` 后调用 `forceLayoutAwareImages()`，强制播放器走「按 layout 拉伸」分支。
      **压缩产物本身无问题（真机 Flutter/Android/iOS 均按 layout 绘制），仅为预览显示缺陷。**
- [🔒] 数据安全：「覆盖保存」原来会直接写回原文件、无任何备份，原始文件一旦覆盖即不可逆丢失。
      现在**任何覆盖模式（含旧的 `overwrite` 配置项与 `forceOverwrite`）都强制先备份**到
      `.zy-svga/backup/<批次>/`；UI 移除「直接覆盖，不备份」选项。
- [🐛] 画布缩放补齐路径类几何：`shape.shape.d`（SVG 路径字符串）、`frame.clipPath`、
      `styles.lineDashI/II/III`（虚线）原来**未随画布等比缩放**，画布 ratio≠1 时路径类矢量
      会错位。现新增 `scalePathData()` 一并缩放（无量纲的弧线旋转角与标志位不缩）。

### v0.0.3(2026-09-24)

- 修复右键菜单：原来用自定义语言 ID 判断，.svg 被内置 xml 扩展占用，导致 SVG 右键菜单不出现；现改为按后缀匹配
- 菜单标题改为「用 ZY SVGA 压缩」，去掉 category 重复前缀
- 依赖版本钉死（node-loader 2.0.0 / tinify 1.7.1 / sharp 0.32.6），保证 patch-package 补丁可重现

### v0.0.2(2026-09-24)

- [🆕] Activity-bar sidebar entry: a persistent icon that opens the same compression panel,
      plus a one-click button to restore the latest backup.
- [🆕] `Image Compression` can now be invoked without a pre-selected file — it falls back to
      the active image editor, or the workspace root.
- [🐛] Fixed an identifier mismatch: the source still read configuration from the `mikas.*`
      namespace while the manifest declared `zy-svga.*`, so all 12 settings (including the
      default save mode and memory thresholds) were silently ignored. Backup directory is
      now `.zy-svga` as intended.

### v0.0.1(2026-09-24)

First release of this fork (based on Mikas by JaylenLee, MIT).

- [🆕] Tunable SVGA compression: frame-dropping (keep duration, lower fps), texture downsampling
      (ratio / max-edge), and canvas scaling for viewBox / layout / transforms.
- [🆕] Decoded-memory estimation: shows the actual RGBA8888 footprint
      (`Σ width × height × 4`) and warns when a small file decodes into tens of MB.
- [🆕] One-click overwrite with automatic backup (`.zy-svga/backup/<timestamp>/`), plus restore.
- [🆕] All compression parameters are editable from the UI instead of being hardcoded.
- [🤖️] Three-column layout: file tree / preview + memory report / parameter panel.
- [🐛] Fixed cross-platform native packaging: `.node` files keep their original directory
      depth so the libvips rpath resolves, macOS (arm64 + x64) libvips and all four
      Windows DLLs ship with the package.

### v1.2.1(2023-08-27)

- [🐛] Fixed a display error with compressed volume percentage of total volume
- [🆕] Add file ignore function, add file path to ignore in vscode configuration page, support Glob.

### v1.1.1(2023-08-26)

- Initial release
