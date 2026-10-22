import * as vscode from "vscode";
import * as Tinify from "tinify";
import * as path from "path";
import * as fs from "fs";
import * as util from "util";
import * as svgo from "svgo";
import * as imageSize from "image-size";
import * as os from "os";
import { nanoid } from "nanoid";
import WebviewLoader from "./webview-loader";
import { getDirectoryStructure, isAvailableImage, isAvailableSvgoExt, isAvailableTinypngExt, isDev, isGIF, isSvga, sleep } from "./utils";
import {
  WebviewIPCSignal,
  type IPCMessage,
  ExtensionIPCSignal,
  WorkspaceNode,
  ExecutedStatus,
  ImageDirectoryStructureNode,
  DirectoryStructureNode,
  CompressedState,
  FileType,
  SaveMode,
  type SvgaCompressOptions,
  type BackupEntry,
} from "./typing";
import logger, { type LogLevel } from "./utils/logger";
import type { ISizeCalculationResult } from "image-size/dist/types/interface";
import { Uri } from "vscode";
import svgaUtility, { DEFAULT_SVGA_OPTIONS } from "./utils/svga";
import backupService from "./utils/backup";
import SidebarViewProvider, { SIDEBAR_VIEW_ID } from "./sidebar-view";
import open from "open";

const tinify = Tinify.default;
const sizeOf = util.promisify(imageSize.default);

const CONFIG_SECTION = "zy-svga";
enum CONFIG_KEY {
  Ignore = "ignore",
  TinypngApiKey = "tinypngApiKey",
  CompressedFilePostfix = "compressedFilePostfix",
  Concurrency = "concurrency",
  ForceOverwrite = "forceOverwrite",
  /** 默认落盘方式 */
  SaveMode = "saveMode",
  /** 全局 SVGA 压缩参数 */
  SvgaOptions = "svgaOptions",
  /** 解码内存安全阈值（MB） */
  MemorySafeThreshold = "memorySafeThreshold",
  /** 解码内存危险阈值（MB） */
  MemoryDangerThreshold = "memoryDangerThreshold",
  /** 单文件解码内存预算（MB），用于生成缩放建议 */
  MemoryBudget = "memoryBudget",
  /** 备份批次保留数量 */
  BackupKeep = "backupKeep",
  /** 覆盖原文件前做产物校验 */
  ValidateBeforeOverwrite = "validateBeforeOverwrite",
  /** 日志详细程度：debug / info / warning / error */
  LogLevel = "logLevel",
}
enum VSCODE_COMMAND {
  Compress = "zy-svga.compress",
  RestoreLastBackup = "zy-svga.restoreLastBackup",
  /** 导出诊断日志到文件 */
  ExportLog = "zy-svga.exportLog",
  /** 在输出面板打开日志通道 */
  ShowLog = "zy-svga.showLog",
}

/** 输出面板里的通道名，排查时在这里看实时日志 */
const LOG_CHANNEL_NAME = "ZY SVGA Compresser";

const MB = 1024 * 1024;

export class ImageCompressor {
  public readonly name = "ZY SVGA Compresser";
  private tempFolder: vscode.Uri;
  private vsCodeContext: vscode.ExtensionContext;
  private ignorePatterns: string[];
  private tinypngApiKeyValid = false;
  private webviewTempFolderMap = new WeakMap<vscode.Webview, vscode.Uri>();
  private webviewIdTempFolderMap = new Map<string, vscode.Uri>();
  private readonly disposers: vscode.Disposable[] = [];
  private static instance: ImageCompressor | undefined;
  private sharp: typeof import("sharp") | undefined;
  /**
   * 单文件参数覆盖表。
   *
   * 以 fsPath 为键，跨面板共享；未登记的文件一律使用全局参数。
   * 这样既支持"一套参数打天下"，也支持个别动画单独调参。
   */
  private svgaOptionsOverrides = new Map<string, SvgaCompressOptions>();
  /** 每个文件最近一次使用的备份批次，供"还原此文件"用 */
  private lastBackupMap = new Map<string, { timestamp: string; backupFsPath: string; createdAt: number }>();
  /** 日志通道：把 logger 的输出接进「输出」面板，排查时可见 */
  private logChannel: vscode.OutputChannel | undefined;
  /**
   * 日志落盘路径。
   *
   * 内存缓冲会随扩展宿主重建（Reload Window）一起清空，磁盘文件才是
   * 「上次压缩那会儿到底发生了什么」的唯一可靠来源，所以每条日志都同步落一份。
   */
  private logFilePath: string | undefined;
  /** 落盘缓冲：批量压缩时日志很密，逐行 append 会把 IO 变成瓶颈 */
  private logPending: string[] = [];
  private logFlushTimer: ReturnType<typeof setTimeout> | undefined;
  /** 批量压缩的任务序号，用于给每个文件的日志行分配一个可 grep 的任务号 */
  private taskSeq = 0;

  constructor(context: vscode.ExtensionContext) {
    if (ImageCompressor.instance) {
      return ImageCompressor.instance;
    }
    ImageCompressor.instance = this;
    this.vsCodeContext = context;
    this.initLogChannel();
    this.applyMemoryThreshold();
    this.webviewInit();
  }

  /**
   * 把 logger 接到 OutputChannel 上。
   *
   * 扩展宿主的 console 输出只有 error 级别会被写进 exthost.log，
   * info/warn 全部丢弃，所以必须另开一条通道，否则排查时几乎看不到过程日志。
   */
  private initLogChannel() {
    try {
      logger.setLogLevel(this.logLevelConfig);
      this.logChannel = vscode.window.createOutputChannel(LOG_CHANNEL_NAME);
      this.vsCodeContext.subscriptions.push(this.logChannel);

      this.logFilePath = this.resolveLogFilePath();

      // 一个出口做两件事：输出面板实时可见 + 磁盘留档。
      // 只挂面板的话，Reload 一下日志就没了——用户报「刚才压缩的日志没记录下来」正是这个原因。
      logger.setSink((line) => {
        this.logChannel?.appendLine(line);
        this.appendLogToDisk(line);
      });
      // 退出/重载前把缓冲里剩下的日志刷出去，否则最后几行会丢
      this.vsCodeContext.subscriptions.push({ dispose: () => this.flushLogToDisk() });

      logger.info(
        "logChannel",
        `已就绪（扩展 ${this.vsCodeContext.extension.packageJSON?.version || "?"}，VSCode ${vscode.version}，` +
          `${os.type()} ${os.release()} ${os.arch()}，Electron ${process.versions.electron}，Node ${process.versions.node}，` +
          `日志等级 ${logger.currentLevel}，PID ${process.pid}）`
      );
      if (this.logFilePath) {
        logger.info("logChannel", `磁盘日志 ${this.logFilePath}`);
      }
      logger.info(
        "logChannel",
        `工作区 ${vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join(", ") || "(未打开)"}`
      );
    } catch (e) {
      // 通道建不起来也要继续跑，只是日志少一个出口
      console.error("initLogChannel failed", e);
    }
  }

  /** 按天落盘的日志文件路径；单日超 8MB 轮转一次 */
  private resolveLogFilePath(): string | undefined {
    try {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const dir = path.join(this.vsCodeContext.globalStorageUri.fsPath, "logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `zy-svga-${day}.log`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 8 * 1024 * 1024) {
          fs.renameSync(file, `${file}.1`);
        }
      } catch {
        // 轮转失败不影响继续写
      }
      // 立刻建出空文件：这样「磁盘日志: xxx」这行提示一出现，用户就能直接去打开它，
      // 也避免了刚启动就 Reload 时连文件都还没建出来
      if (!fs.existsSync(file)) fs.writeFileSync(file, "");
      return file;
    } catch {
      return undefined;
    }
  }

  private appendLogToDisk(line: string) {
    if (!this.logFilePath) return;
    this.logPending.push(line);
    if (this.logFlushTimer) return;
    this.logFlushTimer = setTimeout(() => this.flushLogToDisk(), 200);
  }

  private flushLogToDisk() {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = undefined;
    }
    if (!this.logFilePath || !this.logPending.length) return;
    const chunk = `${this.logPending.join("\n")}\n`;
    this.logPending = [];
    try {
      // 用同步写：这样才能保证「导出日志」时磁盘文件一定是完整的，
      // 而不是还差最后 200ms 没刷出去。单次几 KB，开销可以忽略。
      fs.appendFileSync(this.logFilePath, chunk);
    } catch {
      // 日志写盘失败绝不能影响主流程
    }
  }

  /** 读磁盘日志尾部若干行；Reload 会清空内存缓冲，这里补的是上一次会话的现场 */
  private readDiskLogTail(maxLines: number): { path: string; lines: string; total: number } | null {
    if (!this.logFilePath) return null;
    try {
      this.flushLogToDisk();
      if (!fs.existsSync(this.logFilePath)) return null;
      const all = fs.readFileSync(this.logFilePath, "utf8").split("\n").filter(Boolean);
      return { path: this.logFilePath, lines: all.slice(-maxLines).join("\n"), total: all.length };
    } catch {
      return null;
    }
  }

  private configInit(webview: vscode.Webview) {
    try {
      const ignorePattern = this.ignorePatternConfig;
      this.ignorePatterns = ignorePattern.replace(/\s/g, "").split(";").filter(Boolean);
      this.applyMemoryThreshold();
      this.tinypngApiKeyValidate()
        .then((res) => {
          webview.postMessage({
            signal: ExtensionIPCSignal.TinypngUsageUpdate,
            payload: {
              usage: String(res.usage || "0"),
            },
          });
        })
        // 兜底：校验流程出任何意外都只记一行日志。
        // 缺这一层的话，reject 会变成 unhandled rejection，
        // VSCode 会统一弹成 "An unknown error occurred"。
        .catch((e) => logger.error("configInit.tinypngApiKeyValidate", e));
    } catch (e) {
      logger.error("configInit", e);
    }
  }

  /** 把配置里的内存阈值同步给压缩引擎 */
  private applyMemoryThreshold() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const safe = Number(config.get(CONFIG_KEY.MemorySafeThreshold));
    const danger = Number(config.get(CONFIG_KEY.MemoryDangerThreshold));
    svgaUtility.setMemoryThreshold({
      safe: Number.isFinite(safe) && safe > 0 ? safe * MB : undefined,
      danger: Number.isFinite(danger) && danger > 0 ? danger * MB : undefined,
    });
  }

  /**
   * TinyPNG API Key 校验。
   *
   * 关键语义：本扩展的主功能是 SVGA 压缩，**完全不依赖 TinyPNG**。
   * 因此「没配 Key」是一种正常的"未启用"状态，不是错误 —— 既不弹窗，更不能 reject。
   *
   * 历史坑（0.0.6 及以前）：空 Key 时走 `reject({ valid: false })`，而调用处
   * `.then()` 没有 `.catch()`，于是成了 unhandled rejection；扔出去的又是普通对象
   * 而非 Error 实例，VSCode 认不出来，统一兜底成
   * "An unknown error occurred. Please consult the log for more details."。
   * 它挂在打开面板的初始化流程上，所以每开一次面板就弹一次，与 SVGA 压缩毫无关系。
   *
   * 现在的约定：**无论何种情况都 resolve**，用 `valid` 字段表达结果。
   */
  private tinypngApiKeyValidate(): Promise<{ valid: boolean; usage: number }> {
    const apiKey = this.tinypngApiKeyConfig;
    if (!apiKey) {
      logger.info("tinypngApiKey", "未配置，跳过校验（本扩展压 SVGA 不依赖此 Key）");
      return Promise.resolve({ valid: false, usage: 0 });
    }
    // withProgress 返回的是 Thenable（只有 then，没有 catch），
    // 包一层 Promise 才能让调用方安全地挂 .catch()
    return Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          cancellable: false,
          title: `${this.name} - Image Compressor: Preparing...`,
        },
        async () => {
          tinify.key = apiKey;
          try {
            await tinify.validate();
            this.tinypngApiKeyValid = true;
            logger.info("tinypngApiKey", `校验通过，已用额度 ${tinify.compressionCount || 0}`);
            return { valid: true, usage: tinify.compressionCount };
          } catch (e) {
            // 配了 Key 却校验不通过，这才是真错误：报一次，但依然 resolve
            this.tinypngApiKeyValid = false;
            const message = e instanceof Error ? e.message : String(e);
            logger.error("tinypngApiKey", `校验失败：${message}`);
            // 等进度通知收掉，否则错误提示会被它挤掉
            await sleep(500);
            vscode.window.showErrorMessage(`TinyPNG: API validation failed: ${message}`);
            return { valid: false, usage: tinify.compressionCount };
          }
        }
      )
    );
  }

  private async createRootTempFolder() {
    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No open workspace folder");
      return;
    }
    const tempFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, `.${CONFIG_SECTION}`);
    try {
      await vscode.workspace.fs.createDirectory(tempFolderUri);
      this.tempFolder = tempFolderUri;
      logger.info("createRootTempFolder", tempFolderUri.fsPath);
    } catch (error) {
      logger.error("createRootTempFolder", error);
    }
  }

  private async getAvailableImageDirectoryStructure(uri: vscode.Uri, webview: vscode.Webview, parentUri?: vscode.Uri): Promise<WorkspaceNode> {
    return getDirectoryStructure<ImageDirectoryStructureNode>(
      uri,
      parentUri,
      isAvailableImage,
      //@ts-ignore
      async (node: DirectoryStructureNode) => {
        let dimensions: ImageDirectoryStructureNode["dimensions"];
        let memory: ImageDirectoryStructureNode["memory"];
        try {
          if (isSvga(node.fsPath)) {
            const { movieEntity } = await svgaUtility.parse(node.fsPath);
            dimensions = {
              width: movieEntity.params.viewBoxWidth,
              height: movieEntity.params.viewBoxHeight,
              version: movieEntity.version,
              ...movieEntity.params,
            };
            // 体积之外，同步给出解码内存估算
            memory = svgaUtility.analyzeMemory(movieEntity);
          } else {
            dimensions = await sizeOf(node.fsPath);
          }
        } catch (e) {
          logger.error("dimensions.parse", e);
          dimensions = {
            width: 0,
            height: 0,
            error: `[Parse Error]: ${e}`,
          };
        }
        return {
          compressedState: dimensions.error ? CompressedState.REJECTED : CompressedState.IDLE,
          sourceWebviewUri: webview.asWebviewUri(Uri.file(node.fsPath)).toString(),
          optimizedFsPath: "",
          optimizedWebviewUri: "",
          optimizedSize: 0,
          errorMessage: dimensions.error ? dimensions.error : "",
          disabled: Boolean(dimensions.error),
          disableCheckbox: node.type === FileType.Directory && node?.children.length === 0,
          dimensions,
          optimizedDimensions: {
            width: 0,
            height: 0,
          },
          memory,
          svgaOptions: this.svgaOptionsOverrides.get(node.fsPath),
          backup: this.lastBackupMap.get(node.fsPath),
          ...node,
        };
      },
      this.ignorePatterns
    );
  }

  /**
   * 解析「没有显式选中文件」时的默认入口：
   * 当前激活的图片文件优先，否则退回工作区根目录。
   * 供侧边栏入口与命令面板调用。
   */
  private resolveDefaultEntryUri(): vscode.Uri | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri && isAvailableImage(activeUri.fsPath)) {
      return activeUri;
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private async webviewInit() {
    const dispose = vscode.commands.registerCommand(VSCODE_COMMAND.Compress, async (entry?: vscode.Uri, others?: vscode.Uri[]) => {
      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage("请先打开一个工作区文件夹，再使用图像压缩功能。");
        return;
      }
      const target = entry ?? this.resolveDefaultEntryUri();
      if (!target) {
        vscode.window.showWarningMessage("请先在资源管理器中选中一个图片文件或文件夹。");
        return;
      }
      logger.info(
        "webviewInit",
        `打开压缩面板：目标 ${target.fsPath}（来源 ${entry ? "资源管理器选中" : "默认入口"}，附带 ${others?.length || 0} 个额外路径）`
      );
      const { webviewPanel, webviewId } = await this.createWebviewPanel();
      logger.info("webviewInit", `面板已创建 webviewId=${webviewId}`);
      this.configInit(webviewPanel.webview);
      await this.createRootTempFolder();
      webviewPanel.onDidDispose(() => {
        this.webviewDestroy(webviewId);
      });
      this.setWebviewMessageListener(webviewPanel.webview);
      let treePromises;
      if (Array.isArray(others) && others.length) {
        treePromises = others.map<Promise<WorkspaceNode>>((uri) => this.getAvailableImageDirectoryStructure(uri, webviewPanel.webview));
      } else {
        treePromises = [this.getAvailableImageDirectoryStructure(target, webviewPanel.webview)];
      }
      const treeData = (await Promise.all<WorkspaceNode>(treePromises)).filter(Boolean);
      logger.info(
        "webviewInit",
        `工作区扫描完成：${treeData.length} 个顶层节点${treeData.length !== treePromises.length ? `（${treePromises.length - treeData.length} 个无法读取）` : ""}`
      );
      if (webviewPanel.active) {
        webviewPanel.webview.postMessage({
          signal: ExtensionIPCSignal.Init,
          payload: {
            workspace: treeData,
            svgaOptions: this.globalSvgaOptions,
            saveMode: this.saveModeConfig,
            memoryThreshold: svgaUtility.memoryThreshold,
            memoryBudget: this.memoryBudgetConfig * MB,
            backups: await this.listBackups(),
          },
        });
      }
      const tempDir = vscode.Uri.joinPath(this.tempFolder, Date.now() + "");
      await vscode.workspace.fs.createDirectory(tempDir);
      !this.webviewTempFolderMap.has(webviewPanel.webview) && this.webviewTempFolderMap.set(webviewPanel.webview, tempDir);
      !this.webviewIdTempFolderMap.has(webviewId) && this.webviewIdTempFolderMap.set(webviewId, tempDir);
    });
    this.disposers.push(dispose);

    // 命令面板入口：还原最近一次备份
    const restoreDispose = vscode.commands.registerCommand(VSCODE_COMMAND.RestoreLastBackup, () => this.restoreLatestBackup());
    this.disposers.push(restoreDispose);

    // 命令面板入口：导出诊断日志 / 打开输出面板
    const exportLogDispose = vscode.commands.registerCommand(VSCODE_COMMAND.ExportLog, () => this.exportLog());
    const showLogDispose = vscode.commands.registerCommand(VSCODE_COMMAND.ShowLog, () => this.logChannel?.show(true));
    this.disposers.push(exportLogDispose, showLogDispose);

    // 活动栏侧边视图：常驻入口，点按钮打开同一个压缩面板
    const sidebarDispose = vscode.window.registerWebviewViewProvider(
      SIDEBAR_VIEW_ID,
      new SidebarViewProvider(this.vsCodeContext.extensionUri, {
        openPanel: () => {
          void vscode.commands.executeCommand(VSCODE_COMMAND.Compress);
        },
        restoreBackup: () => {
          void this.restoreLatestBackup();
        },
      })
    );
    this.disposers.push(sidebarDispose);
  }

  private async webviewDestroy(webviewId: string) {
    try {
      const tempDir = this.webviewIdTempFolderMap.get(webviewId);
      await vscode.workspace.fs.delete(tempDir, {
        recursive: true,
        useTrash: false,
      });
      logger.info("webviewDestroy", `${webviewId} tempFolder has deleted`);
    } catch (e) {
      logger.error("webviewDestroy", `${webviewId} tempFolder delete error ${e}`);
    }
  }

  private createCompressTaskQueue(files: { key: string; fsPath: string; ext: string }[], tempUri: vscode.Uri) {
    return files.map<() => Promise<any> | any>((file) => {
      // 任务号在排队时就分配：并发跑起来后日志会交错，靠它才能把
      // 「同一个文件的请求 → 解析 → 5 步处理 → 校验 → 完成」串成一条线
      const tag = `#${++this.taskSeq}`;
      if (isAvailableTinypngExt(file.ext)) {
        return () => this.tinifyCompress(file.fsPath, tempUri);
      } else if (isAvailableSvgoExt(file.ext)) {
        return () => this.svgoCompress(file.fsPath, tempUri);
      } else if (isGIF(file.ext)) {
        return () => this.gifCompress(file.fsPath, tempUri);
      } else if (isSvga(file.ext)) {
        return () => this.svgaCompress(file.fsPath, tempUri, tag);
      } else {
        logger.warn("createCompressTaskQueue", `跳过不支持的文件类型 ${file.ext} → ${file.fsPath}`);
        return () => Promise.resolve();
      }
    });
  }

  private consumeCompressTaskQueue<T>(tasks: (() => Promise<T>)[], fulfilledCb: (res: any) => void, rejectedCb: (res: any) => void, concurrency = 6) {
    let i = 0;
    const ret = [];
    const executing = [];
    const enqueue = function () {
      if (i === tasks.length) {
        return Promise.resolve();
      }
      const task = tasks[i++];
      const p = Promise.resolve()
        .then(() => task())
        .then((res) => {
          fulfilledCb(res);
          return res;
        })
        .catch((e) => {
          rejectedCb(e);
        });
      ret.push(p);

      let r = Promise.resolve();
      if (concurrency <= tasks.length) {
        const e = p.then(() => {
          return executing.splice(executing.indexOf(e), 1);
        });
        executing.push(e);
        if (executing.length >= concurrency) {
          r = Promise.race(executing);
        }
      }
      return r.then(() => enqueue());
    };
    return enqueue().then(() => Promise.all(ret));
  }

  /**
   * tinypng压缩
   */
  private tinifyCompress(fsPath: string, tempUri: vscode.Uri) {
    return new Promise<{
      key: string;
      sourceFsPath: string;
      errorMessage: string;
      destinationFsPath: string;
      optimizedSize: number;
      optimizedDimensions: ISizeCalculationResult;
    }>((resolve, reject) => {
      try {
        if (!this.tinypngApiKeyValid) {
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
        logger.error("tinifyCompressError", e);
        reject({
          key: fsPath,
          sourceFsPath: fsPath,
          errorMessage: e.toString(),
        });
      }
    });
  }

  /**
   * svgo压缩
   */
  private async svgoCompress(fsPath: string, tempUri: vscode.Uri) {
    return new Promise(async (resolve, reject) => {
      try {
        const postfix = this.postfixConfig;
        const svgBuffer = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
        const output = svgo.optimize(svgBuffer.toString(), {});
        const parsedPath = path.parse(fsPath);
        const destinationFsPath = path.join(tempUri.fsPath, `${parsedPath.name}${postfix}${parsedPath.ext}`);
        const destinationUri = vscode.Uri.file(destinationFsPath);
        await vscode.workspace.fs.writeFile(destinationUri, Buffer.from(output.data));
        const stat = await vscode.workspace.fs.stat(destinationUri);
        const dimensions = await sizeOf(destinationFsPath);
        resolve({
          key: fsPath,
          sourceFsPath: fsPath,
          destinationFsPath,
          optimizedSize: stat.size,
          optimizedDimensions: dimensions,
        });
      } catch (e) {
        logger.error("svgoCompress", e);
        reject({
          key: fsPath,
          sourceFsPath: fsPath,
          errorMessage: e.toString(),
        });
      }
    });
  }

  /**
   * gif压缩
   */
  private async gifCompress(fsPath: string, tempUri: vscode.Uri) {
    return new Promise(async (resolve, reject) => {
      try {
        const postfix = this.postfixConfig;
        if (!this.sharp) {
          this.sharp = (await import("sharp")).default;
          // Reducing concurrency should reduce the memory usage too.
          const divisor = process.env.NODE_ENV === "development" ? 4 : 2;
          this.sharp.concurrency(Math.floor(Math.max(os.cpus().length / divisor, 1)));
        }
        const image = this.sharp(fsPath, {
          animated: true,
          limitInputPixels: false,
        });
        const parsedPath = path.parse(fsPath);
        const destinationFsPath = path.join(tempUri.fsPath, `${parsedPath.name}${postfix}${parsedPath.ext}`);
        const destinationUri = vscode.Uri.file(destinationFsPath);
        await image
          .gif({
            colors: 10,
          })
          .toFile(destinationFsPath);
        const stat = await vscode.workspace.fs.stat(destinationUri);
        const dimensions = await sizeOf(destinationFsPath);
        resolve({
          key: fsPath,
          sourceFsPath: fsPath,
          destinationFsPath: destinationFsPath,
          optimizedSize: stat.size,
          optimizedDimensions: dimensions,
        });
      } catch (e) {
        logger.error("gifCompress", e);
        reject({
          key: fsPath,
          sourceFsPath: fsPath,
          errorMessage: e.toString(),
        });
      }
    });
  }

  /**
   * Svga压缩
   *
   * 关键变化：不再写死质量与编码格式，而是按该文件生效的参数（单文件覆盖优先于全局）
   * 执行缩放、抽帧与重编码，并回传压缩前后的体积与解码内存对照。
   */
  private svgaCompress(fsPath: string, tempUri: vscode.Uri, logTag = "") {
    const flag = logTag ? `svgaCompress${logTag}` : "svgaCompress";
    return new Promise(async (resolve, reject) => {
      const t0 = Date.now();
      try {
        const postfix = this.postfixConfig;
        const parsedPath = path.parse(fsPath);
        const destinationFsPath = path.join(tempUri.fsPath, `${parsedPath.name}${postfix}${parsedPath.ext}`);
        const options = this.resolveSvgaOptions(fsPath);
        logger.info(
          flag,
          `请求 ${fsPath} → ${destinationFsPath}（参数来源：${this.svgaOptionsOverrides.has(fsPath) ? "单文件覆盖" : "全局配置"}）`
        );
        const result = await svgaUtility.compress(fsPath, destinationFsPath, options, logTag);
        resolve({
          key: fsPath,
          sourceFsPath: fsPath,
          destinationFsPath: result.destination,
          optimizedSize: result.after.size,
          optimizedDimensions: {
            width: result.after.viewBoxWidth,
            height: result.after.viewBoxHeight,
            version: result.applied.version,
            fps: result.after.fps,
            frames: result.after.frames,
          },
          /** 供界面显示体积与内存的前后对照 */
          svgaResult: {
            before: {
              size: result.before.size,
              fps: result.before.fps,
              frames: result.before.frames,
              viewBoxWidth: result.before.viewBoxWidth,
              viewBoxHeight: result.before.viewBoxHeight,
              memory: result.before.memory,
            },
            after: {
              size: result.after.size,
              fps: result.after.fps,
              frames: result.after.frames,
              viewBoxWidth: result.after.viewBoxWidth,
              viewBoxHeight: result.after.viewBoxHeight,
              memory: result.after.memory,
            },
            applied: result.applied,
            reclaim: result.reclaim,
          },
        });
      } catch (e) {
        // 详细的过程与栈由 svgaUtility.compress 内部记；这里只补一条「请求级」的失败，
        // 保证即使异常发生在进入压缩器之前（比如读配置）也有痕迹。
        logger.error(
          flag,
          `请求失败 ${fsPath}（${Date.now() - t0}ms）：${e instanceof Error ? e.message : String(e)}`
        );
        reject({
          key: fsPath,
          sourceFsPath: fsPath,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }

  /**
   * 压缩已选择的文件
   */
  private async handleCompressSelectedCommand(
    payload: {
      files: Array<{ key: string; fsPath: string; ext: string }>;
    },
    senderWebview: vscode.Webview
  ) {
    const { files = [] } = payload;
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    const batchStart = Date.now();
    let okCount = 0;
    let failCount = 0;
    try {
      const tempUri = this.webviewTempFolderMap.get(senderWebview) || this.tempFolder;
      const tasksQueue = this.createCompressTaskQueue(files, tempUri);
      const concurrency = this.taskConcurrencyConfig;
      logger.info(
        "compressBatch",
        `开始：${files.length} 个文件，并发 ${concurrency}，临时目录 ${tempUri.fsPath}`
      );
      logger.debug("compressBatch", `文件清单：${files.map((f) => path.basename(f.fsPath)).join(", ") || "(空)"}`);
      const result = await this.consumeCompressTaskQueue(
        tasksQueue,
        (res) => {
          okCount++;
          logger.info(
            "compressBatch",
            `✔ ${path.basename(res.sourceFsPath)} 完成（进度 ${okCount + failCount}/${files.length}）`
          );
          statusBarItem.text = `${res.sourceFsPath} compress successful!`;
          statusBarItem.show();
          senderWebview.postMessage({
            signal: ExtensionIPCSignal.Compressed,
            payload: {
              status: ExecutedStatus.Fulfilled,
              data: {
                ...res,
                optimizedWebviewUri: senderWebview.asWebviewUri(vscode.Uri.file(res.destinationFsPath)).toString(),
              },
              error: "",
            },
          });
        },
        (res) => {
          failCount++;
          // 单个文件失败必须落到日志里：只 postMessage 给界面的话，
          // 用户导出日志时看不到是哪个文件、因为什么失败。
          logger.error(
            "compressBatch",
            `✘ ${path.basename(res?.sourceFsPath || "?")} 失败（进度 ${okCount + failCount}/${files.length}）：${res?.errorMessage || res}`
          );
          statusBarItem.text = `${res.sourceFsPath} compress failed!`;
          statusBarItem.show();
          senderWebview.postMessage({
            signal: ExtensionIPCSignal.Compressed,
            payload: {
              status: ExecutedStatus.Rejected,
              data: res,
              error: res.errorMessage,
            },
          });
        },
        Number(concurrency)
      );
      logger.info(
        "compressBatch",
        `结束：成功 ${okCount}，失败 ${failCount}，共 ${files.length} 个文件，耗时 ${Date.now() - batchStart}ms`
      );
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.TinypngUsageUpdate,
        payload: {
          usage: this.tinypngUsage,
        },
      });
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.AllCompressed,
        payload: {
          status: ExecutedStatus.Fulfilled,
          data: result,
          error: "",
        },
      });
      statusBarItem.dispose();
    } catch (e) {
      logger.error("compressBatch", `批次异常终止（耗时 ${Date.now() - batchStart}ms）：${e instanceof Error ? e.stack || e.message : String(e)}`);
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.AllCompressed,
        payload: {
          status: ExecutedStatus.Rejected,
          data: [],
          error: e.message,
        },
      });
    } finally {
      statusBarItem.dispose();
    }
  }

  /**
   * 压缩当前文件
   */
  private async handleCompressCurrentCommand(
    payload: {
      file: { key: string; fsPath: string; ext: string };
    },
    senderWebview: vscode.Webview
  ) {
    const file = payload.file;
    const tempUri = this.webviewTempFolderMap.get(senderWebview) || this.tempFolder;
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    const tag = `#${++this.taskSeq}`;
    const t0 = Date.now();
    try {
      logger.info("compressSingle", `请求压缩当前文件 ${file.fsPath}（类型 ${file.ext}，任务 ${tag}）`);
      let task;
      if (isAvailableTinypngExt(file.ext)) {
        task = this.tinifyCompress(file.fsPath, tempUri);
      } else if (isAvailableSvgoExt(file.ext)) {
        task = this.svgoCompress(file.fsPath, tempUri);
      } else if (isGIF(file.ext)) {
        task = this.gifCompress(file.fsPath, tempUri);
      } else if (isSvga(file.ext)) {
        task = this.svgaCompress(file.fsPath, tempUri, tag);
      } else {
        // 以前这里静默 resolve()，随后 res 是 undefined，抛出的 TypeError 又被 catch 吞掉，
        // 结果是「点了没反应，日志里也什么都没有」。现在明确记一条。
        logger.warn("compressSingle", `不支持的文件类型 ${file.ext}，已跳过：${file.fsPath}`);
        task = Promise.resolve();
      }
      const res = await task;
      if (!res) {
        logger.warn("compressSingle", `无产物可提交（任务 ${tag}，耗时 ${Date.now() - t0}ms）：${file.fsPath}`);
        return;
      }
      logger.info(
        "compressSingle",
        `✔ ${path.basename(file.fsPath)} 完成（任务 ${tag}，耗时 ${Date.now() - t0}ms）`
      );
      statusBarItem.text = `${res.sourceFsPath} compress successful!`;
      statusBarItem.show();
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.TinypngUsageUpdate,
        payload: {
          usage: this.tinypngUsage,
        },
      });
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.CurrentCompressed,
        payload: {
          status: ExecutedStatus.Fulfilled,
          data: {
            ...res,
            optimizedWebviewUri: senderWebview.asWebviewUri(vscode.Uri.file(res.destinationFsPath)).toString(),
          },
          error: "",
        },
      });
    } catch (e) {
      logger.error(
        "compressSingle",
        `✘ 失败（任务 ${tag}，耗时 ${Date.now() - t0}ms）${file.fsPath}：${e instanceof Error ? e.stack || e.message : String(e)}`
      );
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.CurrentCompressed,
        payload: {
          status: ExecutedStatus.Rejected,
          data: {},
          error: e instanceof Error ? e.message : String(e),
        },
      });
    } finally {
      statusBarItem.dispose();
    }
  }

  // ------------------------------------------------------------------ 落盘

  /**
   * 计算单个文件的落盘目标路径。
   * - Copy：与原文件同目录，文件名带后缀
   * - 覆盖类：直接写回原路径
   */
  private resolveDestinationUri(file: { sourceFsPath: string; tempFsPath: string }, mode: SaveMode): vscode.Uri {
    if (mode === SaveMode.Copy) {
      const sourceParsedInfo = path.parse(file.sourceFsPath);
      const tempParsedInfo = path.parse(file.tempFsPath);
      return vscode.Uri.file(`${sourceParsedInfo.dir}/${tempParsedInfo.base}`);
    }
    return vscode.Uri.file(file.sourceFsPath);
  }

  /**
   * 覆盖前的安全校验。
   *
   * 只对 svga 生效：确认产物能解码、纹理没丢。校验不通过则拒绝覆盖，
   * 避免把坏文件写回去。
   */
  private async guardOverwrite(tempFsPath: string, sourceFsPath: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.validateBeforeOverwriteConfig) return { ok: true };
    if (!isSvga(sourceFsPath)) return { ok: true };
    return svgaUtility.validateOutput(tempFsPath);
  }

  /**
   * 执行一批落盘。
   *
   * 覆盖类模式会先校验产物；OverwriteWithBackup 会先把原文件整批备份，
   * 并把备份批次记到各文件上，供"还原"使用。
   */
  private async performSave(
    files: { key: string; sourceFsPath: string; tempFsPath: string }[],
    mode: SaveMode,
    workspaceRoot: string
  ): Promise<{
    results: Array<{ status: ExecutedStatus; key: string; overwrite: boolean; savedFsPath: string; error: string }>;
    backup: BackupEntry | null;
  }> {
    const results: Array<{ status: ExecutedStatus; key: string; overwrite: boolean; savedFsPath: string; error: string }> = [];
    const isOverwrite = mode !== SaveMode.Copy;
    const t0 = Date.now();
    logger.info(
      "performSave",
      `开始落盘：${files.length} 个文件，模式 ${mode}${isOverwrite ? "（会覆盖原文件）" : "（另存副本）"}`
    );
    logger.debug("performSave", `文件清单：${files.map((f) => path.basename(f.sourceFsPath)).join(", ") || "(空)"}`);

    // 覆盖前先做批量校验，任何一个不通过都不动盘
    if (isOverwrite) {
      logger.info("performSave", "覆盖前校验产物（任何一个不通过就整体中止，不做部分覆盖）");
      for (const file of files) {
        const guard = await this.guardOverwrite(file.tempFsPath, file.sourceFsPath);
        if (!guard.ok) {
          logger.error("performSave", `产物校验未通过，已中止覆盖：${path.basename(file.sourceFsPath)} → ${guard.reason}`);
          throw new Error(`已中止覆盖：${path.basename(file.sourceFsPath)} 压缩结果校验未通过（${guard.reason}）`);
        }
      }
      logger.info("performSave", `${files.length} 个产物校验通过，可以覆盖`);
    }

    // ⚠️ 覆盖类操作一律强制备份：Overwrite 与 OverwriteWithBackup 行为统一。
    // 历史事故：曾允许「直接覆盖不备份」，导致原文件被压缩产物不可逆覆盖（slop_area.svga 已丢失）。
    // 备份只增加磁盘占用（保留最近 N 批），但能杜绝不可逆的数据丢失，因此不再提供"不备份"通路。
    let backup: BackupEntry | null = null;
    if (isOverwrite) {
      logger.info("performSave", `备份 ${files.length} 个原文件…（覆盖模式强制备份）`);
      backup = await backupService.create(
        workspaceRoot,
        files.map((file) => file.sourceFsPath)
      );
      if (backup) {
        logger.info(
          "performSave",
          `备份完成：批次 ${backup.timestamp}，${backup.files.length} 个文件（保留最近 ${this.backupKeepConfig} 批）`
        );
        for (const file of backup.files) {
          const record = { timestamp: backup.timestamp, backupFsPath: file.backupFsPath, createdAt: backup.createdAt };
          this.lastBackupMap.set(file.sourceFsPath, record);
        }
        await backupService.prune(workspaceRoot, this.backupKeepConfig);
      } else {
        // 备份没成功就不允许覆盖，宁可失败也不能丢文件
        logger.error("performSave", "备份失败，已中止覆盖，未对任何文件做修改");
        throw new Error("已中止覆盖：备份失败，未对任何文件做修改");
      }
    }

    for (const file of files) {
      try {
        const sourceUri = vscode.Uri.file(file.tempFsPath);
        const destinationUri = this.resolveDestinationUri(file, mode);
        await vscode.workspace.fs.copy(sourceUri, destinationUri, { overwrite: true });
        results.push({
          status: ExecutedStatus.Fulfilled,
          key: file.key,
          overwrite: isOverwrite,
          savedFsPath: destinationUri.fsPath,
          error: "",
        });
        logger.info("performSave", `✔ 写入 ${destinationUri.fsPath}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        results.push({
          status: ExecutedStatus.Rejected,
          key: file.key,
          overwrite: isOverwrite,
          savedFsPath: "",
          error: message,
        });
        // 单个文件写失败以前只往 results 里塞一条，日志里查不到，这里补上
        logger.error("performSave", `✘ 写入失败 ${file.sourceFsPath}：${message}`);
      }
    }

    logger.info(
      "performSave",
      `完成：成功 ${results.filter((r) => r.status === ExecutedStatus.Fulfilled).length}，` +
        `失败 ${results.filter((r) => r.status === ExecutedStatus.Rejected).length}，耗时 ${Date.now() - t0}ms`
    );
    return { results, backup };
  }

  /**
   * 保存已选的已压缩文件
   */
  private async handleSaveSelectedCommand(
    payload: {
      files: {
        key: string;
        sourceFsPath: string;
        tempFsPath: string;
      }[];
      mode?: SaveMode;
    },
    senderWebview: vscode.Webview
  ) {
    try {
      const { files = [] } = payload;
      const mode = payload.mode || this.saveModeConfig;
      const workspaceRoot = this.workspaceRoot;
      logger.info("handleSaveSelected", `保存已选 ${files.length} 个文件，模式 ${payload.mode ? "界面指定" : "配置默认"}=${mode}`);
      const { results, backup } = await this.performSave(files, mode, workspaceRoot);

      senderWebview.postMessage({
        signal: ExtensionIPCSignal.Saved,
        payload: {
          status: ExecutedStatus.Fulfilled,
          data: results,
          mode,
          backup,
          error: "",
        },
      });

      const failed = results.filter((item) => item.status === ExecutedStatus.Rejected);
      if (failed.length) {
        vscode.window.showWarningMessage(`${results.length - failed.length} 个文件处理完成，${failed.length} 个失败`);
      } else if (backup) {
        vscode.window
          .showInformationMessage(`${results.length} 个文件已覆盖原文件，原文件已备份`, "还原")
          .then((choice) => {
            if (choice === "还原") this.restoreBackup(backup!.timestamp);
          });
      } else {
        vscode.window.showInformationMessage(`${results.length} pictures operation completed`);
      }
    } catch (e) {
      logger.error("handleSaveCommand", e);
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.Saved,
        payload: {
          status: ExecutedStatus.Rejected,
          data: [],
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  /**
   * 保存当前已压缩文件
   */
  private async handleSaveCurrentCommand(
    payload: {
      file: {
        key: string;
        sourceFsPath: string;
        tempFsPath: string;
      };
      mode?: SaveMode;
    },
    senderWebview: vscode.Webview
  ) {
    const file = payload.file;
    const mode = payload.mode || this.saveModeConfig;
    try {
      logger.info("handleSaveCurrent", `保存当前文件 ${file.sourceFsPath}，模式=${mode}`);
      const { results, backup } = await this.performSave([file], mode, this.workspaceRoot);
      const result = results[0];
      if (result.status === ExecutedStatus.Rejected) {
        throw new Error(result.error);
      }
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.CurrentSaved,
        payload: {
          status: ExecutedStatus.Fulfilled,
          data: { ...result, mode },
          backup,
          error: "",
        },
      });
    } catch (e) {
      logger.error("handleSaveCurrentCommand", e);
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.CurrentSaved,
        payload: {
          status: ExecutedStatus.Rejected,
          data: {},
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  // ------------------------------------------------------------- 参数与备份

  /** 取某个文件真正生效的 SVGA 参数：单文件覆盖 > 全局 */
  private resolveSvgaOptions(fsPath: string): SvgaCompressOptions {
    const override = this.svgaOptionsOverrides.get(fsPath);
    if (override) return this.mergeOptions(this.globalSvgaOptions, override);
    return this.globalSvgaOptions;
  }

  /** 浅合并，保证结构完整（避免界面只传了部分字段时崩掉） */
  private mergeOptions(base: SvgaCompressOptions, patch: Partial<SvgaCompressOptions>): SvgaCompressOptions {
    return {
      fps: { ...base.fps, ...(patch.fps || {}) },
      texture: { ...base.texture, ...(patch.texture || {}) },
      canvas: { ...base.canvas, ...(patch.canvas || {}) },
      encode: { ...base.encode, ...(patch.encode || {}) },
      reclaim: { ...base.reclaim, ...(patch.reclaim || {}) },
    };
  }

  /**
   * 参数变更。
   *
   * scope = global 时写入 VSCode 配置（持久化）；
   * scope = file 时只记在内存里，作用于单个文件。
   */
  private async handleUpdateSvgaOptions(payload: { scope: "global" | "file"; fsPath?: string; options: Partial<SvgaCompressOptions> }, senderWebview: vscode.Webview) {
    try {
      if (payload.scope === "global") {
        const next = this.mergeOptions(this.globalSvgaOptions, payload.options);
        await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_KEY.SvgaOptions, next, vscode.ConfigurationTarget.Workspace);
      } else if (payload.fsPath) {
        const current = this.svgaOptionsOverrides.get(payload.fsPath) || this.globalSvgaOptions;
        this.svgaOptionsOverrides.set(payload.fsPath, this.mergeOptions(current, payload.options));
      }
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.SvgaOptionsUpdated,
        payload: {
          svgaOptions: this.globalSvgaOptions,
          overrides: Object.fromEntries(this.svgaOptionsOverrides),
        },
      });
    } catch (e) {
      logger.error("handleUpdateSvgaOptions", e);
    }
  }

  /** 按目标内存反推纹理缩放比例 */
  private async handleRequestMemoryAdvice(payload: { fsPath: string; targetMB?: number }, senderWebview: vscode.Webview) {
    try {
      const target = (payload.targetMB && payload.targetMB > 0 ? payload.targetMB : this.memoryBudgetConfig) * MB;
      const { movieEntity } = await svgaUtility.parse(payload.fsPath);
      const memory = svgaUtility.analyzeMemory(movieEntity);
      const advice = svgaUtility.buildMemoryAdvice(memory.totalBytes, target, memory.textureCount);
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.MemoryAdvice,
        payload: { fsPath: payload.fsPath, advice, currentBytes: memory.totalBytes, targetBytes: target },
      });
    } catch (e) {
      logger.error("handleRequestMemoryAdvice", e);
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.MemoryAdvice,
        payload: { fsPath: payload.fsPath, advice: null, error: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  private async listBackups(): Promise<BackupEntry[]> {
    try {
      return await backupService.list(this.workspaceRoot);
    } catch {
      return [];
    }
  }

  private async handleRequestBackupList(_payload: unknown, senderWebview: vscode.Webview) {
    senderWebview.postMessage({
      signal: ExtensionIPCSignal.BackupList,
      payload: { backups: await this.listBackups() },
    });
  }

  /** 还原指定批次 */
  private async handleRestoreBackup(payload: { timestamp: string; fsPath?: string }, senderWebview: vscode.Webview) {
    try {
      const result = payload.fsPath
        ? await this.restoreSingleFile(payload.timestamp, payload.fsPath)
        : await backupService.restore(this.workspaceRoot, payload.timestamp);
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.Restored,
        payload: { status: ExecutedStatus.Fulfilled, result, timestamp: payload.timestamp, error: "" },
      });
      vscode.window.showInformationMessage("还原完成");
    } catch (e) {
      senderWebview.postMessage({
        signal: ExtensionIPCSignal.Restored,
        payload: { status: ExecutedStatus.Rejected, error: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  private async restoreSingleFile(timestamp: string, fsPath: string) {
    const res = await backupService.restoreFile(this.workspaceRoot, timestamp, fsPath);
    if (!res.ok) throw new Error(res.reason || "还原失败");
    return { restored: [fsPath], failed: [] as Array<{ sourceFsPath: string; reason: string }> };
  }

  /** 还原最近一次备份，供命令面板调用 */
  private async restoreLatestBackup() {
    const backups = await this.listBackups();
    if (!backups.length) {
      vscode.window.showInformationMessage("没有可还原的备份");
      return;
    }
    const latest = backups[0];
    const choice = await vscode.window.showWarningMessage(
      `将还原最近一次备份（${latest.timestamp}，共 ${latest.fileCount} 个文件）？`,
      { modal: true },
      "还原"
    );
    if (choice !== "还原") return;
    const result = await backupService.restore(this.workspaceRoot, latest.timestamp);
    vscode.window.showInformationMessage(`已还原 ${result.restored.length} 个文件${result.failed.length ? `，${result.failed.length} 个失败` : ""}`);
  }

  private async restoreBackup(timestamp: string) {
    const result = await backupService.restore(this.workspaceRoot, timestamp);
    vscode.window.showInformationMessage(`已还原 ${result.restored.length} 个文件`);
    return result;
  }

  /**
   * 创建webview实例
   */
  private async createWebviewPanel() {
    const allWorkspaceUri = vscode.workspace.workspaceFolders.map((i) => i.uri);
    const panel = vscode.window.createWebviewPanel(CONFIG_SECTION, this.name, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        ...allWorkspaceUri,
        isDev
          ? vscode.Uri.joinPath(this.vsCodeContext.extensionUri, "src", "modules", "image-compressor", "webview", "dist")
          : vscode.Uri.joinPath(this.vsCodeContext.extensionUri, "dist", "image-compressor-dist"),
      ],
    });
    panel.iconPath = vscode.Uri.joinPath(this.vsCodeContext.extensionUri, "assets", "icon.png");
    const webviewLoader = new WebviewLoader(this.vsCodeContext, panel.webview, {
      htmlEntry: isDev ? ["src", "modules", "image-compressor", "webview", "dist", "index.html"] : ["dist", "image-compressor-dist", "index.html"],
      distDir: isDev ? ["src", "modules", "image-compressor", "webview", "dist"] : ["dist", "image-compressor-dist"],
    });
    panel.webview.html = await webviewLoader.getHtml();
    return {
      webviewPanel: panel,
      webviewId: nanoid(),
    };
  }

  /**
   * 编辑器内打开文件
   */
  private handleOpenFileCommand(payload: { file: string }) {
    const fileUri = vscode.Uri.parse(`vscode://file${payload.file}`);
    vscode.env.openExternal(fileUri);
  }

  /**
   * 资源管理器打开文件
   */
  private handleOpenFileInExplorerCommand(payload: { file: string }) {
    open(payload.file);
  }

  /**
   * 导出诊断日志。
   *
   * 扩展宿主和 webview 是两个进程，各自有自己的 logger 缓存；webview 侧的日志
   * 由界面点按钮时随消息一起带过来，这里合并成一份文件，省得排查时两边翻。
   */
  private async exportLog(webviewLog?: string) {
    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
        now.getMinutes()
      )}${pad(now.getSeconds())}`;

      const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
      const defaultUri = vscode.Uri.joinPath(base, `zy-svga-log-${stamp}.log`);

      const target = await vscode.window.showSaveDialog({
        defaultUri,
        saveLabel: "导出日志",
        filters: { "日志文件": ["log", "txt"], "所有文件": ["*"] },
      });
      if (!target) {
        logger.info("exportLog", "用户取消了导出");
        return;
      }

      const extVersion = this.vsCodeContext.extension.packageJSON?.version || "?";
      const workspace = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join(", ") || "(未打开工作区)";
      const diskTail = this.readDiskLogTail(2000);
      const header = [
        "======== ZY SVGA Compresser 诊断日志 ========",
        `生成时间: ${now.toLocaleString()}`,
        `扩展版本: ${extVersion}`,
        `VSCode: ${vscode.version}`,
        `系统: ${os.type()} ${os.release()} ${os.arch()}`,
        `Electron / Node: ${process.versions.electron} / ${process.versions.node}`,
        `工作区: ${workspace}`,
        `日志等级: ${logger.currentLevel}`,
        `本次会话日志: ${logger.size} 条${logger.truncated ? "（已达容量上限，最早的部分已被丢弃，请看下方的磁盘历史）" : ""}`,
        `磁盘日志: ${this.logFilePath || "(未启用)"}`,
      ].join("\n");

      const content = [
        header,
        "",
        "======== 扩展宿主日志（本次会话）========",
        logger.dump(),
        "",
        "======== Webview 日志（界面侧，随本次导出一起带过来）========",
        webviewLog && webviewLog.trim() ? webviewLog : "(界面侧没有日志)",
        "",
        `======== 磁盘历史日志（${diskTail ? `文件共 ${diskTail.total} 行，这里取最近 ${2000} 行，含 Reload 之前的会话` : "未启用"}）========`,
        diskTail ? `文件: ${diskTail.path}\n${diskTail.lines}` : "(没有磁盘日志)",
        "",
      ].join("\n");

      await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
      logger.info("exportLog", `已写入 ${target.fsPath}（${Buffer.byteLength(content, "utf8")} 字节）`);

      const pick = await vscode.window.showInformationMessage(`日志已导出：${target.fsPath}`, "打开日志", "打开所在文件夹");
      if (pick === "打开日志") {
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc);
      } else if (pick === "打开所在文件夹") {
        void open(path.dirname(target.fsPath));
      }
    } catch (e) {
      logger.error("exportLog", e);
      vscode.window.showErrorMessage(`导出日志失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 把 webview 消息的 payload 压成一行摘要。
   *
   * 不能直接 JSON.stringify：导出日志那条消息会把整个 webview 日志原文带过来，
   * 原样记录等于把日志翻倍；文件批次的 payload 也可能很长。
   * 所以只挑对排查有用的字段：哪个文件、多少项、什么模式。
   */
  private summarizePayload(signal: string, payload: any): string {
    try {
      if (signal === WebviewIPCSignal.ExportLog) {
        const len = typeof payload?.webviewLog === "string" ? payload.webviewLog.length : 0;
        return `携带界面侧日志 ${len} 字符`;
      }
      if (!payload || typeof payload !== "object") return String(payload ?? "");
      const parts: string[] = [];
      if (payload.file?.fsPath) parts.push(`file=${payload.file.fsPath}`);
      if (Array.isArray(payload.files)) parts.push(`files=${payload.files.length} 个`);
      if (payload.mode) parts.push(`mode=${payload.mode}`);
      if (payload.scope) parts.push(`scope=${payload.scope}`);
      if (payload.fsPath) parts.push(`fsPath=${payload.fsPath}`);
      if (payload.timestamp) parts.push(`timestamp=${payload.timestamp}`);
      if (payload.options) parts.push(`options=${JSON.stringify(payload.options)}`);
      if (payload.targetMB) parts.push(`targetMB=${payload.targetMB}`);
      return parts.length ? parts.join(" ") : JSON.stringify(payload).slice(0, 300);
    } catch {
      return "<payload 无法序列化>";
    }
  }

  /**
   * 设置webview事件监听
   */
  private setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      (message: IPCMessage) => {
        const { signal, payload } = message;
        // 在入口处记一条：这样「界面点了什么」和「宿主做了什么」落在同一份时间线上，
        // 出问题时能立刻区分是消息没送到，还是送到了但处理失败。
        logger.info("webview.msg", `${signal} ${this.summarizePayload(signal, payload)}`);
        try {
          switch (signal) {
            case WebviewIPCSignal.CompressSelected:
              this.handleCompressSelectedCommand(payload, webview);
              break;
            case WebviewIPCSignal.CompressCurrent:
              this.handleCompressCurrentCommand(payload, webview);
              break;
            case WebviewIPCSignal.SaveSelected:
              this.handleSaveSelectedCommand(payload, webview);
              break;
            case WebviewIPCSignal.SaveCurrent:
              this.handleSaveCurrentCommand(payload, webview);
              break;
            case WebviewIPCSignal.OpenFile:
              this.handleOpenFileCommand(payload);
              break;
            case WebviewIPCSignal.OpenFileInExplorer:
              this.handleOpenFileInExplorerCommand(payload);
              break;
            case WebviewIPCSignal.UpdateSvgaOptions:
              this.handleUpdateSvgaOptions(payload, webview);
              break;
            case WebviewIPCSignal.RequestMemoryAdvice:
              this.handleRequestMemoryAdvice(payload, webview);
              break;
            case WebviewIPCSignal.RequestBackupList:
              this.handleRequestBackupList(payload, webview);
              break;
            case WebviewIPCSignal.RestoreBackup:
              this.handleRestoreBackup(payload, webview);
              break;
            case WebviewIPCSignal.ExportLog:
              void this.exportLog(payload?.webviewLog);
              break;
            case WebviewIPCSignal.ShowLog:
              this.logChannel?.show(true);
              break;
            default:
              // 收到宿主不认识的信号往往意味着界面与插件版本不匹配（改了协议没重启）
              logger.warn("webview.msg", `未处理的信号 ${signal}`);
              break;
          }
        } catch (e) {
          logger.error(
            "webview.msg",
            `处理 ${signal} 时抛出异常：${e instanceof Error ? e.stack || e.message : String(e)}`
          );
        }
      },
      undefined,
      this.vsCodeContext.subscriptions
    );
  }

  // ------------------------------------------------------------------ 配置

  /** 当前工作区根目录，取第一个文件夹；没有则退回进程工作目录 */
  private get workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : process.cwd();
  }

  private get tinypngApiKeyConfig() {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY.TinypngApiKey) || "";
  }

  private get tinypngUsage() {
    return tinify.compressionCount || "0";
  }

  private get ignorePatternConfig() {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY.Ignore) || "";
  }

  private get postfixConfig() {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY.CompressedFilePostfix) || "";
  }

  private get taskConcurrencyConfig() {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY.Concurrency) || 6;
  }

  private get forceOverwriteConfig() {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY.ForceOverwrite) || "";
  }

  /** 全局 SVGA 压缩参数 */
  private get globalSvgaOptions(): SvgaCompressOptions {
    const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<Partial<SvgaCompressOptions>>(CONFIG_KEY.SvgaOptions);
    if (!raw || typeof raw !== "object") return DEFAULT_SVGA_OPTIONS;
    return this.mergeOptions(DEFAULT_SVGA_OPTIONS, raw);
  }

  /**
   * 默认落盘方式。
   *
   * 「覆盖」类一律归一到「覆盖并备份」——不再提供"直接覆盖、不备份"的通路，
   * 因为误用会造成不可逆的原文件丢失。旧配置里若写了 overwrite 也按带备份处理；
   * 旧开关 forceOverwrite 同样按带备份处理（行为比升级前更安全）。
   */
  private get saveModeConfig(): SaveMode {
    const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY.SaveMode);
    if (raw === SaveMode.Copy) return SaveMode.Copy;
    if (raw === SaveMode.Overwrite || raw === SaveMode.OverwriteWithBackup) return SaveMode.OverwriteWithBackup;
    return this.forceOverwriteConfig ? SaveMode.OverwriteWithBackup : SaveMode.Copy;
  }

  private get memoryBudgetConfig(): number {
    const value = Number(vscode.workspace.getConfiguration(CONFIG_SECTION).get(CONFIG_KEY.MemoryBudget));
    return Number.isFinite(value) && value > 0 ? value : 30;
  }

  private get backupKeepConfig(): number {
    const value = Number(vscode.workspace.getConfiguration(CONFIG_SECTION).get(CONFIG_KEY.BackupKeep));
    return Number.isFinite(value) && value > 0 ? value : 20;
  }

  private get validateBeforeOverwriteConfig(): boolean {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(CONFIG_KEY.ValidateBeforeOverwrite);
    return value !== false;
  }

  /** 日志等级；默认最详细的 debug，保证「过程日志一条不缺」 */
  private get logLevelConfig(): LogLevel {
    const raw = String(vscode.workspace.getConfiguration(CONFIG_SECTION).get(CONFIG_KEY.LogLevel) || "debug").toLowerCase();
    if (raw === "debug" || raw === "info" || raw === "warning" || raw === "error") return raw;
    if (raw === "warn") return "warning";
    return "debug";
  }

  public get dispatcher() {
    return this.disposers;
  }

  public static getInstance(context: vscode.ExtensionContext) {
    if (!this.instance) {
      this.instance = new ImageCompressor(context);
    }
    return this.instance;
  }
}

export default function registerImageCompressorSupport(context: vscode.ExtensionContext) {
  context.subscriptions.push(...new ImageCompressor(context).dispatcher);
}
