import * as vscode from "vscode";

/** 与 package.json 中 contributes.views 的 id 保持一致 */
export const SIDEBAR_VIEW_ID = "zy-svga.sidebar";

export interface SidebarViewCallbacks {
  /** 打开编辑器内的压缩面板 */
  openPanel: () => void;
  /** 还原最近一次备份 */
  restoreBackup: () => void;
}

/**
 * 活动栏侧边视图。
 *
 * 它本身不是操作界面——只提供一个常驻入口：点击活动栏图标 → 面板里点主按钮，
 * 即可打开与右键入口完全相同的压缩面板。这样既保留了「用完就走」的轻量定位，
 * 又给了不想进资源管理器右键的用户一条固定路径。
 */
export default class SidebarViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri, private readonly callbacks: SidebarViewCallbacks) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "assets")],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
      switch (message?.type) {
        case "openPanel":
          this.callbacks.openPanel();
          break;
        case "restoreBackup":
          this.callbacks.restoreBackup();
          break;
      }
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "assets", "sidebar-icon.svg"));

    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <style>
      body {
        padding: 16px 14px;
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        user-select: none;
      }
      .hero { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
      .hero img { width: 34px; height: 34px; flex: none; opacity: 0.92; }
      .hero .title { font-size: 13px; font-weight: 600; line-height: 1.3; }
      .hero .sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
      .formats {
        font-size: 11px;
        line-height: 1.7;
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-textBlockQuote-background);
        border-left: 2px solid var(--vscode-textBlockQuote-border);
        padding: 6px 8px;
        border-radius: 3px;
        margin-bottom: 14px;
        word-break: break-all;
      }
      button {
        display: block;
        width: 100%;
        padding: 7px 10px;
        border: none;
        border-radius: 3px;
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
        text-align: center;
      }
      button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
      .primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        margin-bottom: 8px;
      }
      .primary:hover { background: var(--vscode-button-hoverBackground); }
      .secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
      .divider { height: 1px; background: var(--vscode-panel-border); margin: 16px 0 12px; }
      .hint { font-size: 11px; line-height: 1.6; color: var(--vscode-descriptionForeground); }
      .hint b { color: var(--vscode-foreground); font-weight: 600; }
      kbd {
        font-family: var(--vscode-editor-font-family);
        font-size: 10px;
        padding: 1px 4px;
        border-radius: 2px;
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-textCodeBlock-background);
      }
    </style>
  </head>
  <body>
    <div class="hero">
      <img src="${iconUri}" alt="" />
      <div>
        <div class="title">ZY SVGA Compresser</div>
        <div class="sub">图片与动画压缩</div>
      </div>
    </div>

    <div class="formats">支持 .svga · .png · .jpg · .webp · .svg · .gif</div>

    <button class="primary" id="open">打开压缩面板</button>
    <button class="secondary" id="restore">还原上一次备份</button>

    <div class="divider"></div>

    <div class="hint">
      在资源管理器里右键图片或文件夹，选 <b>Image Compression</b> 也能打开，并且会直接带上所选文件。
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById("open").addEventListener("click", () => vscode.postMessage({ type: "openPanel" }));
      document.getElementById("restore").addEventListener("click", () => vscode.postMessage({ type: "restoreBackup" }));
    </script>
  </body>
</html>`;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
