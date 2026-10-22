# 发布到 VS Code 扩展市场

- 扩展 ID：`zynigo.svgazip`
- 仓库：https://github.com/yelunnibi/zy-svga-compresser
- 产物：`release/svgazip-<version>.vsix`

## 一、首次上架（不需要任何令牌，最快路径）

1. **注册发布者**
   - 打开 https://marketplace.visualstudio.com/manage ，用微软账号登录
   - 点 **Create publisher**
   - **ID 必须填 `zynigo`**（要与 `package.json` 的 `publisher` 完全一致，创建后不可更改）
   - Name 填对外展示名（全球唯一）
2. **上传安装包**
   - 进入该 publisher → **New extension → Visual Studio Code**
   - 把 `release/svgazip-0.0.8.vsix` 拖进去
3. **验证**
   - 网页：`https://marketplace.visualstudio.com/items?itemName=zynigo.svgazip`
   - VS Code：`Ctrl+Shift+X` 搜 `svga`
   - 命令行安装：`code --install-extension zynigo.svgazip`

索引需要几分钟到几小时，属正常。

## 二、后续发版（命令行，需要令牌）

前置：Azure DevOps 建组织 → 建 PAT

- https://dev.azure.com 登录 → 创建组织（**没有组织时创建 PAT 会失败**）
- 头像 → Personal access tokens → New Token
- Organization 选 **All accessible organizations**（选具体组织会导致 401/403）
- Scopes 选 **Custom defined → Marketplace → Manage**

```bash
vsce login zynigo        # 粘贴 PAT，凭据缓存在 ~/.vsce
npm run build
vsce publish patch       # 自动把 0.0.8 改成 0.0.9 并发布
```

> ⚠️ **2026-12-01 起 Azure DevOps 全局 PAT 全面停用**。之后的替代方案是 Entra ID
> （`vsce publish --azure-credential`），或继续走上面的网页手动上传。

## 三、让扩展真的被搜到

市场搜索只读 `package.json` 里这几个字段，README 里的关键词不算：

| 字段 | 当前值 | 作用 |
| --- | --- | --- |
| `name` | `svgazip` | 扩展 ID 后半段，唯一，不可改 |
| `displayName` | `ZY SVGA Compresser` | 搜索权重最高的展示字段 |
| `description` | 以 `SVGA compression for VS Code` 开头 | 搜索结果里的那句简介，前置关键词 |
| `keywords` | 28 个（含中文） | 标签，**参与搜索匹配** |
| `contributes.languages` | `.svga` | 市场自动生成 `__ext_svga` 标签 |

实测依据（2026-09-30 用市场 API 查得）：

- 搜 `svga`：全市场仅 6 个结果，**没有一个是压缩工具** —— 这个定位是空的。
- `JaylenLee.mikas` 的显示名（"Mikas - Image Compressor"）和描述都不含 svga，却能出现在搜 `svga` 的结果里，
  唯一原因是它的 keywords 含 `__ext_svga` —— **这证明 keywords 确实被索引**。
- 搜「图片压缩」返回 4 个中文扩展，装机量更高的 mikas 完全不在其中（keywords 没有中文）
  —— **中文关键词是没人占的入口**。

排序规律：精确词优先于泛词，其次看装机量。搜 `svg compress`（61 个结果）会被装机量百万级的扩展占满，
新插件挤不进去；搜 `svga`（6 个结果）才有机会。

## 四、三个必须知道的坑

1. **详情页是发布时的快照**。改完 README、图标、关键词后，必须重新发布才在市场生效，没有「刷新」按钮。
2. **版本号只能递增**，已发布的版本不能覆盖，发错了只能发下一个版本。
3. **`name` 和 publisher ID 一旦发布不可更改**；删除扩展后名字会被永久保留。

## 五、非微软客户端

Cursor、Windsurf、VSCodium、Trae 读的是 **Open VSX**，不是微软市场。同一个 vsix 需要再发一次：

```bash
npx ovsx publish release/svgazip-0.0.8.vsix -p <open-vsx-token>
```

需要 Eclipse 账号，并创建与 publisher 同名的命名空间 `zynigo`。

## 六、GitHub Release 分发（不走市场，也能给别人装）

`.github/workflows/release.yml` 已配好：

| 触发 | 产物 |
|---|---|
| push 到 `main` | Actions artifact（保留 30 天） |
| push tag `v*` | GitHub Release，含 `svgazip-<version>.vsix` + 固定名 `svgazip.vsix` |

发版：

```bash
# 1. 改 package.json 的 version（或 npm version patch --no-git-tag-version）
git commit -am "chore: release v0.0.12"
git push
git tag v0.0.12 && git push origin v0.0.12
```

tag 与 `package.json` 版本不一致时 CI 会直接 fail，防止发出错版本的包。

用户安装（**必须两步**）：

```bash
curl -fL -o /tmp/svgazip.vsix \
  https://github.com/yelunnibi/zy-svga-compresser/releases/latest/download/svgazip.vsix
code --install-extension /tmp/svgazip.vsix --force
```

> **`code --install-extension <URL>` 不可用**（VS Code 1.143.0 实测）：
> CLI 的 `asExtensionIdOrVSIX()` 只判断字符串是否以 `.vsix` 结尾，是就转成**本地路径**，
> 于是 `https://...` 变成 `$PWD/https:/github.com/...`，报 `ENOENT`。
> 官方支持的只有 `<扩展ID>` 或 `<本地 vsix 路径>` 两种形式。

### 为什么不用 `--target` 打多平台包

VS Code 支持 `vsce package --target darwin-arm64` 这类按平台打包，但本扩展的 vsix 是**一个包内含多平台原生库**（7 个 `sharp-*.node` + macOS libvips ×2 + Windows DLL ×4），
用户在 mac/win 装同一个文件即可。代价是体积 26MB；好处是不用让用户选对平台包。

CI 必须显式跑 `npm run setup:native`：Linux runner 上 `npm ci` 只会拿到 `linux-x64` 的 sharp 原生模块，
不补的话产物在 mac/win 上装得上但一启动就崩。`scripts/verify-dist-native.js` 会在打包前硬拦这种残缺产物。
