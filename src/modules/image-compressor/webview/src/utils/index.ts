import type { WebviewApi } from "vscode-webview";
import { FileType, IPCMessage, MemoryRisk, WorkspaceNode } from "@typing";
import logger from "@extension/utils/logger.ts";

/**
 * 把要发出去的消息压成一行摘要。
 *
 * 不能原样 JSON.stringify：ExportLog 会把整个界面日志原文一起发出去，
 * 原样记录等于把日志翻倍；文件批次也可能很长。所以只留排查要用的字段。
 */
function summarizeMessage(message: IPCMessage): string {
  try {
    const { signal, payload } = message as unknown as { signal?: string; payload?: any };
    if (payload?.webviewLog) {
      const len = typeof payload.webviewLog === "string" ? payload.webviewLog.length : 0;
      return `${signal} 携带界面日志 ${len} 字符`;
    }
    if (!payload || typeof payload !== "object") return `${signal} ${String(payload ?? "")}`;
    const parts: string[] = [];
    if (payload.file?.fsPath) parts.push(`file=${payload.file.fsPath}`);
    if (Array.isArray(payload.files)) parts.push(`files=${payload.files.length} 个`);
    if (payload.mode) parts.push(`mode=${payload.mode}`);
    if (payload.scope) parts.push(`scope=${payload.scope}`);
    if (payload.fsPath) parts.push(`fsPath=${payload.fsPath}`);
    if (payload.options) parts.push(`options=${JSON.stringify(payload.options)}`);
    return `${signal} ${parts.join(" ")}`;
  } catch {
    return "<消息无法序列化>";
  }
}

class VSCodeAPIWrapper {
  private readonly vsCodeApi: WebviewApi<unknown> | undefined;

  constructor() {
    if (typeof acquireVsCodeApi === "function") {
      this.vsCodeApi = acquireVsCodeApi();
    }
  }

  public postMessage(message: IPCMessage) {
    // 界面发出的每条消息都留痕：导出日志时能和宿主的 webview.msg 逐条对上，
    // 从而一眼判断是「界面压根没发」还是「发出去了但宿主没处理」。
    logger.info("webview.send", summarizeMessage(message));
    if (this.vsCodeApi) {
      this.vsCodeApi.postMessage(message);
    }
  }

  public getState(): unknown | undefined {
    if (this.vsCodeApi) {
      return this.vsCodeApi.getState();
    } else {
      const state = localStorage.getItem("vscodeState");
      return state ? JSON.parse(state) : undefined;
    }
  }

  public setState<T extends unknown | undefined>(newState: T): T {
    if (this.vsCodeApi) {
      return this.vsCodeApi.setState(newState);
    } else {
      localStorage.setItem("vscodeState", JSON.stringify(newState));
      return newState;
    }
  }
}

export const vscode = new VSCodeAPIWrapper();

export interface WorkspaceParsedInfo {
  total: number;
  totalSize: number;
  reducedSize: number;
  png: number;
  jpg: number;
  webp: number;
  svg: number;
}

export function workspaceParse(root: WorkspaceNode) {
  const nodeMap = new Map<string, WorkspaceNode>();
  const workspaceParsedInfo: WorkspaceParsedInfo = {
    total: 0,
    totalSize: 0,
    reducedSize: 0,
    png: 0,
    jpg: 0,
    webp: 0,
    svg: 0,
  };
  function travel(node: WorkspaceNode) {
    if (!node) return;
    const queue = [node];
    while (queue.length) {
      const n = queue.shift();
      if (n.type === FileType.File) {
        workspaceParsedInfo.total++;
        workspaceParsedInfo.totalSize += n.size;
        if (n.optimizedSize !== 0) {
          workspaceParsedInfo.reducedSize += n.size - n.optimizedSize;
        }
        switch (n.parsedInfo.ext) {
          case ".png":
            workspaceParsedInfo.png++;
            break;
          case ".jpg":
          case ".jpeg":
            workspaceParsedInfo.jpg++;
            break;
          case ".webp":
            workspaceParsedInfo.webp++;
            break;
          case ".svg":
            workspaceParsedInfo.svg++;
            break;
        }
      }
      if (Array.isArray(n.children)) {
        queue.push(...n.children);
      }
      if (!nodeMap.has(n.key)) nodeMap.set(n.key, n);
    }
  }
  travel(root);
  return {
    nodeMap,
    workspaceParsedInfo,
  };
}

export function calcReducedRate(originSize: number, optimizeSize: number) {
  if (!originSize || !optimizeSize) return "0";
  return (((originSize - optimizeSize) / originSize) * 100).toFixed(0);
}

export function formatReducedRate(reducedSize: number,totalSize:number) {
  if(!totalSize || !reducedSize) return "0"
  return ((reducedSize / totalSize) * 100).toFixed(2)
}

export function formatFileSize(fileSize: number): string {
  if (fileSize < 1024) {
    return fileSize.toFixed(2) + " B";
  } else if (fileSize < 1024 * 1024) {
    const fileSizeInKB = fileSize / 1024;
    return fileSizeInKB.toFixed(2) + " KB";
  } else if (fileSize < 1024 * 1024 * 1024) {
    const fileSizeInMB = fileSize / (1024 * 1024);
    return fileSizeInMB.toFixed(2) + " MB";
  } else {
    const fileSizeInGB = fileSize / (1024 * 1024 * 1024);
    return fileSizeInGB.toFixed(2) + " GB";
  }
}

function toPrecision(value: number, digits: number): string {
  const factor = Math.pow(10, digits);
  return String(Math.round(value * factor) / factor);
}

/** 紧凑字节格式，用于解码内存这类数量级较大的数值 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return toPrecision(bytes / 1024, 0) + " KB";
  if (bytes < 1024 * 1024 * 1024) return toPrecision(bytes / 1024 / 1024, 1) + " MB";
  return toPrecision(bytes / 1024 / 1024 / 1024, 2) + " GB";
}

/** 解码内存展示：小于 1GB 统一用 MB，便于横向比较 */
export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return toPrecision(bytes / 1024 / 1024, 1) + " MB";
}

/** 体积变化的百分比，正数表示变小 */
export function calcReducedPercent(before: number, after: number): number {
  if (!before || !after) return 0;
  return Math.round(((before - after) / before) * 1000) / 10;
}

export const MEMORY_RISK_META: Record<MemoryRisk, { label: string; color: string; bar: string; hint: string }> = {
  safe: {
    label: "解码内存正常",
    color: "text-emerald-400",
    bar: "#4ade80",
    hint: "低端设备也能轻松承载",
  },
  caution: {
    label: "解码内存偏高",
    color: "text-amber-400",
    bar: "#fbbf24",
    hint: "低端机上建议降到安全区间",
  },
  danger: {
    label: "解码内存过高",
    color: "text-red-400",
    bar: "#f87171",
    hint: "低端设备极易 OOM，务必先降分辨率",
  },
};

/** 风险条上当前值所处的位置，0-100 */
export function memoryRiskPosition(bytes: number, safe: number, danger: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  const max = danger > safe ? danger * 2.2 : Math.max(bytes, 1);
  return Math.min(100, Math.max(0, (bytes / max) * 100));
}
