import * as vscode from "vscode";
import Processor from "../processor";
import Plugin from "./base";
import logger from "../utils/logger";
import path from "path";
import { sleep, sizeOf } from "../utils";
import { ISizeCalculationResult } from "image-size/dist/types/interface";

import * as Tinify from "tinify";

const tinify = Tinify.default;

/**
 * ⚠️ 本文件当前**未被任何代码引用**——`TinypngPlugin` 全仓库没有实例化点，是历史遗留死代码。
 * 真正在跑的 TinyPNG 校验在 `../index.ts` 的 `tinypngApiKeyValidate()`。
 *
 * 若将来要复活本文件，注意它带着与 index.ts 同款的坑，别照抄：
 * 1. `apply()` 返回一个**永不 resolve 的 Promise**（会让压缩流程永久挂起）；
 * 2. `tinypngApiKeyValidate()` 用 `reject(false)` / `reject({ valid: false })` 抛出
 *    **非 Error 对象**。调用方一旦漏写 `.catch()`，就会变成 unhandled rejection，
 *    VSCode 认不出这种 rejection 值，会兜底弹 "An unknown error occurred."
 *    （0.0.6 及以前就踩过这个，见 ../index.ts 同名方法的注释）。
 */
export interface TinypngPluginOptions {}

export default class TinypngPlugin extends Plugin {
  readonly name = "TinypngPlugin";
  apiKeyValid = false;

  constructor(context: vscode.ExtensionContext, options: TinypngPluginOptions) {
    super(context);
  }

  apply(processor: Processor) {
    processor.hooks.validate.tapPromise(this.name, (lastResult) => {
      return new Promise<boolean>((resolve, reject) => {});
    });
  }

  /**
   * tinypng压缩
   */
  private compress(fsPath: string, tempUri: vscode.Uri) {
    return new Promise<{
      key: string;
      sourceFsPath: string;
      errorMessage: string;
      destinationFsPath: string;
      optimizedSize: number;
      optimizedDimensions: ISizeCalculationResult;
    }>((resolve, reject) => {
      try {
        if (!this.apiKeyValid) {
          reject({
            key: fsPath,
            sourceFsPath: fsPath,
            errorMessage: 'TinyPNG API validation failed. Be sure that you filled out "tinypngApiKey" setting already. Turn the compressor back on after setting.',
          });
          return;
        }
        const postfix = this.postfixConfig;
        const parsedPath = path.parse(fsPath);
        const destinationFsPath = path.join(tempUri.fsPath, `${parsedPath.name}${postfix}${parsedPath.ext}`);
        tinify.fromFile(fsPath).toFile(destinationFsPath, async (error) => {
          let errorMessage = "";
          if (error) {
            if (error instanceof tinify.AccountError) {
              errorMessage = "[AccountError]: Authentication failed. Have you set the API Key? Verify your API key and account limit.";
            } else if (error instanceof tinify.ClientError) {
              errorMessage = "[ClientError]: Check your source image and request options.";
            } else if (error instanceof tinify.ServerError) {
              errorMessage = "[ServerError]: Temporary issue with the Tinify API,TinyPNG API is currently not available.";
            } else if (error instanceof tinify.ConnectionError) {
              errorMessage = "[ConnectionError]: Network issue occurred. Please check your internet connectivity.";
            } else {
              errorMessage = "[UnknownError]: Something else went wrong, unrelated to the Tinify API. Please try again later.";
            }
            reject({
              key: fsPath,
              sourceFsPath: fsPath,
              errorMessage,
            });
          } else {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(destinationFsPath));
            const dimensions = await sizeOf(destinationFsPath);
            resolve({
              key: fsPath,
              sourceFsPath: fsPath,
              errorMessage,
              destinationFsPath,
              optimizedSize: stat.size,
              optimizedDimensions: dimensions,
            });
          }
        });
      } catch (e) {
        this.errorHandler(e, "compress");
        reject({
          key: fsPath,
          sourceFsPath: fsPath,
          errorMessage: e.toString(),
        });
      }
    });
  }

  /**
   * tinypng api Key校验
   */
  private tinypngApiKeyValidate() {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: `[${this.appName}]: Image Compressor Preparing...`,
      },
      (progress, token) => {
        return new Promise<{
          valid: boolean;
          usage: number;
        }>(async (resolve, reject) => {
          try {
            if (this.apiKey) {
              tinify.key = this.apiKey;
              try {
                await tinify.validate();
                this.apiKeyValid = true;
                resolve({
                  valid: true,
                  usage: tinify.compressionCount,
                });
              } catch (e) {
                reject(false);
                await sleep(500);
                vscode.window.showErrorMessage(`TinyPNG: API validation failed: ${e.message}`);
              }
            } else {
              reject({
                valid: false,
                usage: tinify.compressionCount,
              });
              await sleep(500);
              vscode.window
                .showErrorMessage(
                  'TinyPNG: API validation failed. Be sure that you filled out "tinypngApiKey" setting already. Turn the compressor back on after setting.',
                  "Open Settings"
                )
                .then((options) => {
                  if (options === "Open Settings") {
                    vscode.commands.executeCommand("workbench.action.openSettings", "tinypngApiKey");
                  }
                });
            }
          } catch (e) {
            reject({
              valid: false,
              usage: tinify.compressionCount,
            });
            await sleep(500);
            vscode.window.showErrorMessage(e.message);
          }
        });
      }
    );
  }

  private errorHandler(error: Error, fn: string) {
    logger.error(`[${this.name} => ${fn}()]`, error);
  }

  private get apiKey() {
    return vscode.workspace.getConfiguration(this.configSection).get<string>(this.configKey.TinypngApiKey) || "";
  }

  private get postfixConfig() {
    return vscode.workspace.getConfiguration(this.configSection).get<string>(this.configKey.CompressedFilePostfix) || "";
  }

  private get usage() {
    return tinify.compressionCount || "0";
  }
}
