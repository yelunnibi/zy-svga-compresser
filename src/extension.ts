import * as vscode from "vscode";
import registerImageCompressorSupport from "./modules/image-compressor";

export function activate(context: vscode.ExtensionContext) {
  // 注意：上游 main 分支此处曾被注释掉并留有调试代码，
  // 直接构建会得到一个不注册任何命令的空扩展。这里恢复真实注册逻辑。
  registerImageCompressorSupport(context);
}

export function deactivate() {}
