# Change Log

All notable changes to the "zy-svga-compresser" extension will be documented in this file.

- 🐛 bugfix
- 🆕 new features
- 🤖️ optimize

## [Released]

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
