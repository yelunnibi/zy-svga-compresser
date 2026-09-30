import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react";
import { Dropdown, Tree, Tooltip } from "antd";
import type { DataNode, TreeProps } from "antd/es/tree";
import { formatFileSize, formatReducedRate, vscode, workspaceParse, WorkspaceParsedInfo } from "@utils";
import {
  CaretDownOutlined,
  FileImageFilled,
  FileTextOutlined,
  FolderFilled,
  FolderOpenFilled,
  Loading3QuartersOutlined,
  PieChartOutlined,
  SaveOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import useLatest from "@hooks/useLatest.ts";
import WorkspaceNodeTitle from "@components/workspace-node-title";
import CompressBar from "@components/compress-bar";
import PreviewStack from "@components/preview-stack";
import AnimationInfo from "@components/animation-info";
import {
  BackupEntry,
  CompressedState,
  DecodeMemoryInfo,
  ExecutedStatus,
  ExtensionIPCSignal,
  FileType,
  IPCMessage,
  SaveMode,
  SvgaAppliedPlan,
  SvgaCompressOptions,
  SvgaReclaimReport,
  WebviewIPCSignal,
  WorkspaceNode,
} from "@typing";
import logger from "@extension/utils/logger.ts";
import { Item, ItemParams, Menu, Submenu, useContextMenu } from "react-contexify";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import "react-contexify/dist/ReactContexify.css";

const WORKSPACE_CONTEXT_MENU_ID = "workspace-context-menu";

enum WorkspaceContextMenuItemId {
  OpenRawFile = "OpenFile",
  OpenOptimizedFile = "OpenOptimizedFile",
  OpenFileInExplorer = "OpenFileInExplorer",
  RestoreBackup = "RestoreBackup",
}

/** 全局默认参数，与扩展端 DEFAULT_SVGA_OPTIONS 保持一致 */
const FALLBACK_SVGA_OPTIONS: SvgaCompressOptions = {
  fps: { enabled: false, target: 0, keepDuration: true },
  texture: { mode: "none", ratio: 1, maxEdge: 0 },
  canvas: { enabled: false, ratio: 1 },
  encode: { keepFormat: true, format: "png", quality: 80, palette: true },
  reclaim: { enabled: false },
};

const HEADER_BTN =
  "text-[12px] px-[10px] py-[3px] rounded-[4px] border-[1px] border-solid cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-[5px]";

function App() {
  // Workspace tree data
  const [workspace, setWorkspace] = useState<Array<WorkspaceNode>>([]);
  const workspaceLatest = useLatest(workspace);

  // Workspace tree node map
  const [workspaceNodeMap, setWorkspaceNodeMap] = useState<Map<string, WorkspaceNode>>(new Map());
  const workspaceNodeMapLatest = useLatest(workspaceNodeMap);

  const [workspaceParsedInfo, setWorkspaceParsedInfo] = useState<WorkspaceParsedInfo>({
    total: 0,
    totalSize: 0,
    reducedSize: 0,
    png: 0,
    jpg: 0,
    webp: 0,
    svg: 0,
  });

  // The currently selected file
  const [currentFile, setCurrentFile] = useState<DataNode & WorkspaceNode>();
  const currentFileLatest = useLatest(currentFile);
  const [currentRightClickFile, setCurrentRightClickFile] = useState<DataNode & WorkspaceNode>();

  // List of currently selected files
  const [selectedFiles, setSelectedFiles] = useState<Array<DataNode & WorkspaceNode>>([]);
  const selectedFilesLatest = useLatest(selectedFiles);

  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCurrentCompressing, setIsCurrentCompressing] = useState(false);
  const [isSelectedCompressing, setIsSelectedCompressing] = useState(false);

  const { show: showWorkspaceContextMenu } = useContextMenu({
    id: WORKSPACE_CONTEXT_MENU_ID,
  });

  const [tinypngUsage, setTinypngUsage] = useState("--");

  // ---------------------------------------------------------- 状态：参数与备份
  const [globalOptions, setGlobalOptions] = useState<SvgaCompressOptions>(FALLBACK_SVGA_OPTIONS);
  const [fileOverrides, setFileOverrides] = useState<Record<string, SvgaCompressOptions>>({});
  const [scope, setScope] = useState<"global" | "file">("global");
  const [saveMode, setSaveMode] = useState<SaveMode>(SaveMode.Copy);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [isPanelOpen, setIsPanelOpen] = useState(true);

  /**
   * 各文件「上次压缩时用的参数」，用于判断当前预览的压缩图是否已过期。
   * 参数一改，旧结果就不可信了 —— 界面上必须能看出来，否则用户会拿着旧图当新结果。
   */
  const [compressedWith, setCompressedWith] = useState<Record<string, string>>({});

  // handler 里需要读到最新的参数，避免闭包捕获旧值
  const optCtxRef = useRef({ fileOverrides, globalOptions });
  optCtxRef.current = { fileOverrides, globalOptions };

  const handleFileSelected: TreeProps["onSelect"] = (_key, payload) => {
    const node = payload.node as unknown as WorkspaceNode;
    if (node.type === FileType.File) {
      // 记下用户切到了哪个文件：后面所有操作日志都靠这条来归属
      logger.info("webview.ui", `选中文件 ${node.fsPath}`);
      setCurrentFile(node);
      currentFileLatest.current = node;
    }
  };

  const handleFileChecked: TreeProps["onCheck"] = (_key, payload) => {
    const nodeList = payload.checkedNodes as unknown as WorkspaceNode[];
    const newSelectedFiles = nodeList.filter((node) => {
      return node.type === FileType.File && node.compressedState !== CompressedState.SAVED && node.compressedState !== CompressedState.PENDING;
    });
    logger.info(
      "webview.ui",
      `勾选变化：已选 ${newSelectedFiles.length} 个（原 ${selectedFilesLatest.current.length} 个）`
    );
    setSelectedFiles(newSelectedFiles);
    selectedFilesLatest.current = newSelectedFiles;
  };

  const handleCompressCommand = () => {
    setIsSelectedCompressing(true);
    selectedFiles.forEach((file) => {
      const node = workspaceNodeMap.get(file.key);
      if (node) {
        file.compressedState = CompressedState.PENDING;
        file.optimizedFsPath = "";
        file.optimizedSize = 0;
        file.optimizedWebviewUri = "";
        file.optimizedDimensions = { width: 0, height: 0 };
        file.disableCheckbox = true;
        workspaceNodeMap.set(file.key, node);
      }
    });
    vscode.postMessage({
      signal: WebviewIPCSignal.CompressSelected,
      payload: {
        files: selectedFiles.map((file) => ({
          key: file.key,
          fsPath: file.fsPath,
          ext: file.parsedInfo.ext,
        })),
      },
    });
    const newSelectedFiles = [...selectedFiles];
    const newWorkspace = [...workspace];
    setSelectedFiles(newSelectedFiles);
    selectedFilesLatest.current = newSelectedFiles;
    setWorkspace(newWorkspace);
    workspaceLatest.current = newWorkspace;
  };

  const handleCompressCurrentCommand = () => {
    if (!currentFile) return;
    setIsCurrentCompressing(true);
    const node = workspaceNodeMap.get(currentFile.key);
    if (node) {
      node.compressedState = CompressedState.PENDING;
      node.optimizedFsPath = "";
      node.optimizedSize = 0;
      node.optimizedWebviewUri = "";
      node.optimizedDimensions = { width: 0, height: 0 };
      node.disableCheckbox = true;
      workspaceNodeMap.set(node.key, node);
      vscode.postMessage({
        signal: WebviewIPCSignal.CompressCurrent,
        payload: {
          file: {
            key: node.key,
            fsPath: node.fsPath,
            ext: node.parsedInfo.ext,
          },
        },
      });
      const newWorkspace = [...workspace];
      setWorkspace(newWorkspace);
      workspaceLatest.current = newWorkspace;
    }
  };

  /** 落盘：mode 缺省时由扩展端按配置决定 */
  const handleSave = (mode?: SaveMode) => {
    setIsSaving(true);
    vscode.postMessage({
      signal: WebviewIPCSignal.SaveSelected,
      payload: {
        files: selectedFiles
          .filter((file) => file.compressedState === CompressedState.FULFILLED && file.optimizedFsPath)
          .map((file) => ({
            key: file.key,
            sourceFsPath: file.fsPath,
            tempFsPath: file.optimizedFsPath,
          })),
        mode,
      },
    });
  };

  const handleSaveCurrent = (mode?: SaveMode) => {
    if (!currentFile) return;
    vscode.postMessage({
      signal: WebviewIPCSignal.SaveCurrent,
      payload: {
        file: {
          key: currentFile.key,
          sourceFsPath: currentFile.fsPath,
          tempFsPath: currentFile.optimizedFsPath,
        },
        mode,
      },
    });
  };

  const handleWorkspaceParse = (workspace: WorkspaceNode[]) => {
    const dummyHead = {
      key: "$$root",
      title: "dummyHead",
      children: workspace,
    };
    return workspaceParse(dummyHead as unknown as WorkspaceNode);
  };

  const handleInitial = (payload: {
    workspace: WorkspaceNode[];
    svgaOptions?: SvgaCompressOptions;
    saveMode?: SaveMode;
    backups?: BackupEntry[];
  }) => {
    setIsWorkspaceLoading(false);
    const { nodeMap, workspaceParsedInfo } = handleWorkspaceParse(payload.workspace);
    setWorkspaceParsedInfo(workspaceParsedInfo);
    setWorkspaceNodeMap(nodeMap);
    workspaceNodeMapLatest.current = nodeMap;
    setWorkspace(payload.workspace);
    workspaceLatest.current = payload.workspace;

    if (payload.svgaOptions) setGlobalOptions({ ...FALLBACK_SVGA_OPTIONS, ...payload.svgaOptions });
    if (payload.saveMode) setSaveMode(payload.saveMode);
    setBackups(payload.backups || []);

    // 带入各文件已单独设置的参数
    const overrides: Record<string, SvgaCompressOptions> = {};
    const collect = (nodes: WorkspaceNode[]) => {
      nodes.forEach((node) => {
        if (node.svgaOptions) overrides[node.fsPath] = node.svgaOptions;
        if (node.children) collect(node.children as unknown as WorkspaceNode[]);
      });
    };
    collect(payload.workspace);
    setFileOverrides(overrides);
  };

  const handleCompressed = (payload: {
    status: ExecutedStatus;
    error: string;
    data: {
      key: string;
      sourceFsPath: string;
      destinationFsPath: string;
      optimizedWebviewUri: string;
      optimizedSize: number;
      optimizedDimensions: { width: number; height: number; type: string };
      svgaResult?: {
        before: { size: number; fps: number; frames: number; viewBoxWidth: number; viewBoxHeight: number; memory: DecodeMemoryInfo };
        after: { size: number; fps: number; frames: number; viewBoxWidth: number; viewBoxHeight: number; memory: DecodeMemoryInfo };
        applied: SvgaAppliedPlan;
        reclaim?: SvgaReclaimReport;
      };
    };
  }) => {
    const { status, error, data } = payload;
    const { key, optimizedSize, optimizedDimensions, optimizedWebviewUri, destinationFsPath, svgaResult } = data;
    const node = workspaceNodeMapLatest.current.get(key);
    const selectedNode = selectedFilesLatest.current.find((file) => file.key === key);
    let updatePayload: Record<string, unknown> = {};
    if (status === ExecutedStatus.Fulfilled) {
      updatePayload = {
        optimizedSize: optimizedSize,
        optimizedDimensions: optimizedDimensions,
        compressedState: CompressedState.FULFILLED,
        optimizedFsPath: destinationFsPath,
        optimizedWebviewUri: optimizedWebviewUri,
        disableCheckbox: false,
      };
      // svga 额外带上内存对照与实际参数
      if (svgaResult) {
        updatePayload.optimizedMemory = svgaResult.after.memory;
        updatePayload.memory = svgaResult.before.memory;
        updatePayload.appliedPlan = svgaResult.applied;
        updatePayload.reclaimReport = svgaResult.reclaim;
      }
    } else {
      updatePayload = {
        disableCheckbox: false,
        compressedState: CompressedState.REJECTED,
        errorMessage: error,
      };
    }
    node && Object.assign(node, updatePayload);
    selectedNode && Object.assign(selectedNode, updatePayload);
    if (currentFileLatest.current && key === currentFileLatest.current.key) {
      setCurrentFile({
        ...currentFileLatest.current,
        ...(node || {}),
      } as DataNode & WorkspaceNode);
    }
    node && workspaceNodeMapLatest.current.set(key, node);
    setSelectedFiles([...selectedFilesLatest.current]);
    setWorkspace([...workspaceLatest.current]);

    // 记下这次压缩用的是哪套参数，供「参数已变更」判断
    if (status === ExecutedStatus.Fulfilled) {
      const { fileOverrides: fo, globalOptions: go } = optCtxRef.current;
      const used = JSON.stringify(fo[key] || go);
      setCompressedWith((prev) => ({ ...prev, [key]: used }));
    }
  };

  const handleCurrentCompressed = (payload: Parameters<typeof handleCompressed>[0]) => {
    handleCompressed(payload);
    setIsCurrentCompressing(false);
  };

  const handleSaved = (payload: {
    status: ExecutedStatus;
    error: string;
    mode?: SaveMode;
    backup?: BackupEntry | null;
    data: Array<{ status: ExecutedStatus; key: string; overwrite: boolean; savedFsPath: string; error: string }>;
  }) => {
    setIsSaving(false);
    const { status, data = [], backup } = payload;
    if (status === ExecutedStatus.Fulfilled) {
      data.forEach((file) => {
        const node = workspaceNodeMapLatest.current.get(file.key);
        if (!node) return;
        if (file.status === ExecutedStatus.Fulfilled) {
          node.compressedState = CompressedState.SAVED;
          node.disableCheckbox = true;
          if (backup) {
            const record = backup.files.find((item) => item.sourceFsPath === file.key);
            if (record) {
              node.backup = { timestamp: backup.timestamp, backupFsPath: record.backupFsPath, createdAt: backup.createdAt };
            }
          }
        } else {
          node.compressedState = CompressedState.REJECTED;
          node.errorMessage = file.error;
        }
        workspaceNodeMapLatest.current.set(file.key, node);
      });
    }
    if (backup) setBackups((prev) => [backup, ...prev.filter((item) => item.timestamp !== backup.timestamp)]);
    const { workspaceParsedInfo } = handleWorkspaceParse(workspaceLatest.current);
    setSelectedFiles([...selectedFilesLatest.current]);
    setWorkspace([...workspaceLatest.current]);
    setWorkspaceParsedInfo(workspaceParsedInfo);
  };

  const handleCurrentSaved = (payload: {
    status: ExecutedStatus;
    error: string;
    backup?: BackupEntry | null;
    data: { status: ExecutedStatus; key: string; overwrite: boolean; savedFsPath: string; error: string };
  }) => {
    setIsSaving(false);
    const { status, data, backup } = payload;
    const node = data?.key ? workspaceNodeMapLatest.current.get(data.key) : undefined;
    if (status === ExecutedStatus.Fulfilled && node) {
      if (data.status === ExecutedStatus.Fulfilled) {
        node.compressedState = CompressedState.SAVED;
        node.disableCheckbox = true;
        if (backup) {
          const record = backup.files.find((item) => item.sourceFsPath === data.key);
          if (record) {
            node.backup = { timestamp: backup.timestamp, backupFsPath: record.backupFsPath, createdAt: backup.createdAt };
          }
        }
      } else {
        node.compressedState = CompressedState.REJECTED;
        node.errorMessage = data.error;
      }
    } else if (node) {
      node.compressedState = CompressedState.REJECTED;
      node.errorMessage = data?.error || payload.error;
    }
    if (backup) setBackups((prev) => [backup, ...prev.filter((item) => item.timestamp !== backup.timestamp)]);
    node && workspaceNodeMapLatest.current.set(data.key, node);
    const { workspaceParsedInfo } = handleWorkspaceParse(workspaceLatest.current);
    setSelectedFiles([...selectedFilesLatest.current]);
    node && setCurrentFile(node);
    setWorkspace([...workspaceLatest.current]);
    setWorkspaceParsedInfo(workspaceParsedInfo);
  };

  const handleAllCompressed = () => {
    setIsSelectedCompressing(false);
  };

  const handleSvgaOptionsUpdated = (payload: {
    svgaOptions: SvgaCompressOptions;
    overrides: Record<string, SvgaCompressOptions>;
  }) => {
    if (payload.svgaOptions) setGlobalOptions({ ...FALLBACK_SVGA_OPTIONS, ...payload.svgaOptions });
    if (payload.overrides) setFileOverrides(payload.overrides);
  };

  const handleBackupList = (payload: { backups: BackupEntry[] }) => {
    setBackups(payload.backups || []);
  };

  const handleRestored = () => {
    // 还原后原文件已变，重新解析一次最稳妥
    vscode.postMessage({ signal: WebviewIPCSignal.RequestBackupList, payload: {} });
  };

  useLayoutEffect(() => {
    const handleReceiveMessage = (event: { data: IPCMessage }) => {
      const message = event.data;
      const { signal, payload } = message;
      // 记下收到的每条扩展消息，导出日志时能还原出界面侧的时间线。
      // 失败的消息要带真实原因：只记一句 signal 的话，日志里看不出为什么失败。
      const status = (payload as { status?: ExecutedStatus } | undefined)?.status;
      if (status === ExecutedStatus.Rejected) {
        logger.error(
          "webview.recv",
          `${signal} 失败：${(payload as { error?: string } | undefined)?.error || "(扩展端未提供原因)"}`
        );
      } else {
        logger.info("webview.recv", signal);
      }
      switch (signal) {
        case ExtensionIPCSignal.Init:
          handleInitial(payload);
          break;
        case ExtensionIPCSignal.Compressed:
          handleCompressed(payload);
          break;
        case ExtensionIPCSignal.AllCompressed:
          handleAllCompressed();
          break;
        case ExtensionIPCSignal.CurrentCompressed:
          handleCurrentCompressed(payload);
          break;
        case ExtensionIPCSignal.Saved:
          handleSaved(payload);
          break;
        case ExtensionIPCSignal.CurrentSaved:
          handleCurrentSaved(payload);
          break;
        case ExtensionIPCSignal.TinypngUsageUpdate:
          setTinypngUsage(payload.usage);
          break;
        case ExtensionIPCSignal.SvgaOptionsUpdated:
          handleSvgaOptionsUpdated(payload);
          break;
        case ExtensionIPCSignal.BackupList:
          handleBackupList(payload);
          break;
        case ExtensionIPCSignal.Restored:
          handleRestored();
          break;
      }
    };
    window.addEventListener("message", handleReceiveMessage);
    return () => {
      window.removeEventListener("message", handleReceiveMessage);
    };
  }, []);

  const availableCompressSelectedFiles = useMemo(() => {
    return selectedFiles.filter(
      (file) => file.type === FileType.File && file.compressedState !== CompressedState.PENDING && file.compressedState !== CompressedState.SAVED
    );
  }, [selectedFiles]);

  const availableSavedSelectedFiles = useMemo(() => {
    return selectedFiles.filter((file) => file.type === FileType.File && file.compressedState === CompressedState.FULFILLED && file.optimizedFsPath);
  }, [selectedFiles]);

  /** 当前生效的参数：仅当前文件模式下优先取该文件的覆盖值 */
  const currentOptions = useMemo(() => {
    if (scope === "file" && currentFile) {
      return fileOverrides[currentFile.fsPath] || globalOptions;
    }
    return globalOptions;
  }, [scope, currentFile, fileOverrides, globalOptions]);

  const isSvgaFile = Boolean(currentFile && currentFile.parsedInfo.ext === ".svga");

  /* ---------------------------------------------------------- 预览与压缩状态 */
  const hasResult = Boolean(
    currentFile && currentFile.compressedState === CompressedState.FULFILLED && currentFile.optimizedWebviewUri
  );

  /** 已压缩，但参数又改了 —— 下格画面已过期 */
  const isStale = useMemo(() => {
    if (!currentFile || !hasResult) return false;
    const used = compressedWith[currentFile.fsPath];
    if (!used) return false;
    return used !== JSON.stringify(currentOptions);
  }, [currentFile, hasResult, compressedWith, currentOptions]);

  const currentCompressing =
    isCurrentCompressing ||
    Boolean(currentFile && currentFile.compressedState === CompressedState.PENDING);

  const handleScopeChange = (next: "global" | "file") => {
    setScope(next);
  };

  const handleOptionsChange = (patch: Partial<SvgaCompressOptions>) => {
    if (scope === "global") {
      vscode.postMessage({
        signal: WebviewIPCSignal.UpdateSvgaOptions,
        payload: { scope: "global", options: patch },
      });
      // 本地先乐观更新，避免界面卡顿
      setGlobalOptions((prev) => ({
        fps: { ...prev.fps, ...(patch.fps || {}) },
        texture: { ...prev.texture, ...(patch.texture || {}) },
        canvas: { ...prev.canvas, ...(patch.canvas || {}) },
        encode: { ...prev.encode, ...(patch.encode || {}) },
        reclaim: { ...prev.reclaim, ...(patch.reclaim || {}) },
      }));
    } else if (currentFile) {
      vscode.postMessage({
        signal: WebviewIPCSignal.UpdateSvgaOptions,
        payload: { scope: "file", fsPath: currentFile.fsPath, options: patch },
      });
      setFileOverrides((prev) => {
        const base = prev[currentFile.fsPath] || globalOptions;
        return {
          ...prev,
          [currentFile.fsPath]: {
            fps: { ...base.fps, ...(patch.fps || {}) },
            texture: { ...base.texture, ...(patch.texture || {}) },
            canvas: { ...base.canvas, ...(patch.canvas || {}) },
            encode: { ...base.encode, ...(patch.encode || {}) },
            reclaim: { ...base.reclaim, ...(patch.reclaim || {}) },
          },
        };
      });
    }
  };

  /** 把当前参数落到所有选中文件上 */
  const handleApplyToSelected = () => {
    const target = scope === "file" && currentFile ? fileOverrides[currentFile.fsPath] || globalOptions : globalOptions;
    selectedFiles.forEach((file) => {
      vscode.postMessage({
        signal: WebviewIPCSignal.UpdateSvgaOptions,
        payload: { scope: "file", fsPath: file.fsPath, options: target },
      });
      setFileOverrides((prev) => ({ ...prev, [file.fsPath]: target }));
    });
  };

  const handleResetFileOptions = () => {
    if (!currentFile) return;
    setFileOverrides((prev) => {
      const next = { ...prev };
      delete next[currentFile.fsPath];
      return next;
    });
    // 用全局参数覆盖回去
    vscode.postMessage({
      signal: WebviewIPCSignal.UpdateSvgaOptions,
      payload: { scope: "file", fsPath: currentFile.fsPath, options: globalOptions },
    });
  };

  const handleRestore = (timestamp?: string, fsPath?: string) => {
    const target = timestamp || backups[0]?.timestamp;
    if (!target) return;
    vscode.postMessage({
      signal: WebviewIPCSignal.RestoreBackup,
      payload: { timestamp: target, fsPath },
    });
  };

  /**
   * 导出诊断日志。
   *
   * 界面和扩展宿主是两个进程，各自的 logger 缓存互不可见；
   * 这里把自己这份随消息带过去，由扩展端合并后写成一个文件。
   */
  const handleExportLog = () => {
    vscode.postMessage({
      signal: WebviewIPCSignal.ExportLog,
      payload: { webviewLog: logger.dump() },
    });
  };

  // 直接复用 antd 的回调签名，回调里的 node 在运行时就是我们构建的 WorkspaceNode。
  const handleShowWorkspaceContextMenu: TreeProps["onRightClick"] = (e) => {
    setCurrentRightClickFile(e.node as unknown as WorkspaceNode);
    showWorkspaceContextMenu({
      event: e.event as any,
    });
  };

  const handleWorkspaceContextMenuItemClick = (payload: ItemParams) => {
    const { id } = payload;
    const file = currentRightClickFile;
    if (!file) return;
    switch (id) {
      case WorkspaceContextMenuItemId.OpenRawFile:
      case WorkspaceContextMenuItemId.OpenOptimizedFile:
        vscode.postMessage({
          signal: WebviewIPCSignal.OpenFile,
          payload: {
            file: id === WorkspaceContextMenuItemId.OpenRawFile ? file.fsPath : file.optimizedFsPath,
          },
        });
        break;
      case WorkspaceContextMenuItemId.OpenFileInExplorer:
        vscode.postMessage({
          signal: WebviewIPCSignal.OpenFileInExplorer,
          payload: { file: file.fsPath },
        });
        break;
      case WorkspaceContextMenuItemId.RestoreBackup:
        if (file.backup) handleRestore(file.backup.timestamp, file.fsPath);
        break;
    }
  };

  const saveModeMenuItems = [
    {
      key: SaveMode.OverwriteWithBackup,
      label: "覆盖原文件并备份（推荐）",
    },
    {
      key: SaveMode.Overwrite,
      label: "直接覆盖，不备份",
    },
  ];

  const canCompressSelected = !isSelectedCompressing && availableCompressSelectedFiles.length > 0;
  const canSaveSelected = !isSaving && availableSavedSelectedFiles.length > 0;

  return (
    <>
      <section id="app" className="flex flex-col">
        {/* 顶部操作栏：所有落盘动作集中在这里 */}
        <header className="flex-shrink-0 h-[42px] px-[12px] flex items-center gap-[8px] border-b-[1px] border-solid border-[#414141] bg-[#252526]">
          <button
            className={`${HEADER_BTN} border-[#0e639c] bg-[#0e639c] text-white`}
            disabled={!canCompressSelected}
            onClick={handleCompressCommand}
          >
            {isSelectedCompressing ? <Loading3QuartersOutlined spin /> : <ThunderboltOutlined />}
            压缩选中{availableCompressSelectedFiles.length ? `（${availableCompressSelectedFiles.length}）` : ""}
          </button>
          <button
            className={`${HEADER_BTN} border-[#5a5a5a] bg-transparent text-[#d4d4d4] hover:bg-[#3d3d3d]`}
            disabled={!canSaveSelected}
            onClick={() => handleSave(SaveMode.Copy)}
          >
            {isSaving ? <Loading3QuartersOutlined spin /> : <SaveOutlined />}
            保存为副本
          </button>
          <Dropdown
            menu={{
              items: saveModeMenuItems,
              onClick: ({ key }) => handleSave(key as SaveMode),
            }}
            disabled={!canSaveSelected}
          >
            <button className={`${HEADER_BTN} border-[#5a5a5a] bg-transparent text-[#d4d4d4] hover:bg-[#3d3d3d]`} disabled={!canSaveSelected}>
              覆盖原文件
              <CaretDownOutlined className="text-[10px]" />
            </button>
          </Dropdown>

          <div className="flex-1"></div>

          <Tooltip title="把本次会话的扩展端与界面端日志导出成一个文件，便于排查问题">
            <button className={`${HEADER_BTN} border-[#5a5a5a] bg-transparent text-[#d4d4d4] hover:bg-[#3d3d3d]`} onClick={handleExportLog}>
              <FileTextOutlined />
              导出日志
            </button>
          </Tooltip>

          <Tooltip title={isPanelOpen ? "收起参数条" : "展开参数条"}>
            <SettingOutlined
              className={`text-[16px] cursor-pointer ${isPanelOpen ? "text-white" : "text-[#8a8a8a]"}`}
              onClick={() => setIsPanelOpen(!isPanelOpen)}
            />
          </Tooltip>
          {backups.length > 0 && (
            <Tooltip title={`最近备份：${backups[0].timestamp}（${backups[0].fileCount} 个文件）`}>
              <button
                className="text-[12px] px-[8px] py-[3px] rounded-[4px] border-[1px] border-solid border-[#5a5a5a] bg-transparent text-[#d4d4d4] cursor-pointer flex items-center gap-[5px] hover:bg-[#3d3d3d]"
                onClick={() => handleRestore()}
              >
                <UndoOutlined />
                还原上一次
              </button>
            </Tooltip>
          )}
        </header>

        {/* 参数条：仅 svga 文件需要，非 svga 时整条隐藏 */}
        {isPanelOpen && isSvgaFile && currentFile && (
          <CompressBar
            options={currentOptions}
            scope={scope}
            selectedCount={availableCompressSelectedFiles.length}
            originFps={currentFile.dimensions?.fps || 0}
            originFrames={currentFile.dimensions?.frames || 0}
            onScopeChange={handleScopeChange}
            onChange={handleOptionsChange}
            onApplyToSelected={handleApplyToSelected}
            onResetFile={handleResetFileOptions}
          />
        )}

        <main className="flex-1 flex min-h-0">
          <Allotment>
            <Allotment.Pane preferredSize={200} minSize={160} maxSize={380}>
              <div className="relative h-full">
                <div className="h-full px-[12px] pb-[12px] bg-[#333333] w-full overflow-auto flex flex-col relative">
                  {isWorkspaceLoading ? (
                    <div className="flex flex-1 h-full items-center justify-center text-white">
                      <Loading3QuartersOutlined spin className="mx-[6px]" />
                      <p>Workspace resolving...</p>
                    </div>
                  ) : (
                    <Tree
                      titleRender={WorkspaceNodeTitle}
                      switcherIcon={(props) => {
                        if (props.isLeaf) {
                          return null;
                        }
                        return <CaretDownOutlined className="text-[#94a3ad] !text-[18px]" />;
                      }}
                      className="h-full"
                      onRightClick={handleShowWorkspaceContextMenu}
                      onSelect={handleFileSelected}
                      onCheck={handleFileChecked}
                      showIcon={true}
                      icon={(props) => {
                        // @ts-ignore
                        const { type } = props;
                        if (type === FileType.File) {
                          return <FileImageFilled className="text-emerald-400 text-[18px]]" />;
                        } else if (type === FileType.Directory) {
                          if (props.expanded) {
                            return <FolderOpenFilled className="text-[#94a3ad] text-[18px]" />;
                          } else {
                            return <FolderFilled className="text-[#94a3ad] text-[18px]" />;
                          }
                        }
                      }}
                      autoExpandParent
                      defaultExpandAll
                      treeData={workspace as unknown as DataNode[]}
                      checkable
                    />
                  )}
                </div>
              </div>
            </Allotment.Pane>

            {/* 中间：上格原图、下格压缩图，同屏对比 */}
            <Allotment.Pane minSize={320}>
              <div className="h-full flex flex-col min-h-0 bg-[#2b2b2b]">
                <PreviewStack
                  file={currentFile}
                  hasResult={hasResult}
                  stale={isStale}
                  compressing={currentCompressing}
                  onCompress={handleCompressCurrentCommand}
                />
              </div>
            </Allotment.Pane>

            {/* 右侧：动画信息与解码内存 */}
            <Allotment.Pane preferredSize={340} minSize={280} maxSize={620}>
              <AnimationInfo file={currentFile} />
            </Allotment.Pane>
          </Allotment>
        </main>

        <footer className="px-[12px] h-[40px] flex-shrink-0 flex justify-between items-center border-t-[1px] border-solid border-[#414141] bg-[#252526]">
          <div className="flex gap-x-[12px] text-white items-center h-full flex-shrink-0 mr-[12px] text-[12px]">
            <Tooltip
              trigger="click"
              title={
                <div className="min-w-[200px]">
                  <ul className="w-full flex flex-col gap-y-[6px]">
                    <li className="flex items-center justify-between">
                      <span>Total:</span>
                      <span>{workspaceParsedInfo.total}</span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>Total Size:</span>
                      <span>{formatFileSize(workspaceParsedInfo.totalSize)}</span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>Reduced Size:</span>
                      <span>{formatFileSize(workspaceParsedInfo.reducedSize)}</span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>Reduced Rate:</span>
                      <span>{formatReducedRate(workspaceParsedInfo.reducedSize, workspaceParsedInfo.totalSize)}%</span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>PNG:</span>
                      <span>{workspaceParsedInfo.png}</span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>JPG/JPEG:</span>
                      <span>{workspaceParsedInfo.jpg}</span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>WebP:</span>
                      <span>{workspaceParsedInfo.webp}</span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>SVG:</span>
                      <span>{workspaceParsedInfo.svg}</span>
                    </li>
                  </ul>
                </div>
              }
            >
              <PieChartOutlined className="text-[16px] cursor-pointer" />
            </Tooltip>
            <span>已选 {selectedFiles.length}</span>
            <span className="text-[#7a7a7a]">|</span>
            <span>TinyPNG 用量 {tinypngUsage}</span>
            {backups.length > 0 && (
              <>
                <span className="text-[#7a7a7a]">|</span>
                <span className="text-[#8a8a8a]">
                  备份 {backups.length} 批，最近 {backups[0].timestamp}
                </span>
              </>
            )}
          </div>
          <div className="flex gap-x-[8px] flex-shrink-0">
            <VSCodeButton appearance="secondary" disabled={!currentFile || !currentFile.optimizedFsPath} onClick={() => handleSaveCurrent(SaveMode.Copy)}>
              <div className="h-full flex items-center text-[12px]">保存当前为副本</div>
            </VSCodeButton>
            <VSCodeButton
              appearance="primary"
              disabled={!currentFile || !currentFile.optimizedFsPath}
              onClick={() => handleSaveCurrent(SaveMode.OverwriteWithBackup)}
            >
              <div className="h-full flex items-center text-[12px]">覆盖当前并备份</div>
            </VSCodeButton>
          </div>
        </footer>
      </section>

      <Menu id={WORKSPACE_CONTEXT_MENU_ID} theme="dark">
        <Submenu label="Open File">
          <Item id={WorkspaceContextMenuItemId.OpenRawFile} onClick={handleWorkspaceContextMenuItemClick}>
            Raw
          </Item>
          <Item
            id={WorkspaceContextMenuItemId.OpenOptimizedFile}
            disabled={!currentRightClickFile || !currentRightClickFile.optimizedFsPath}
            onClick={handleWorkspaceContextMenuItemClick}
          >
            Optimized
          </Item>
        </Submenu>
        <Item id={WorkspaceContextMenuItemId.OpenFileInExplorer} onClick={handleWorkspaceContextMenuItemClick}>
          Open in explorer
        </Item>
        <Item
          id={WorkspaceContextMenuItemId.RestoreBackup}
          disabled={!currentRightClickFile || !currentRightClickFile.backup}
          onClick={handleWorkspaceContextMenuItemClick}
        >
          还原为原文件
        </Item>
      </Menu>
    </>
  );
}

export default App;
