import * as fs from "fs/promises";
import * as path from "path";
import type { BackupEntry, BackupManifest } from "@image-compressor/typing";

/** 备份根目录名（相对工作区） */
export const BACKUP_DIR_NAME = ".zy-svga";
export const BACKUP_SUBDIR = "backup";
export const MANIFEST_NAME = "manifest.json";
export const FILES_SUBDIR = "files";

/** 默认保留的备份批次数量，超出后清理最旧的 */
export const DEFAULT_KEEP_BACKUPS = 20;

/** 生成 YYYYMMDD-HHmmss 形式的时间戳 */
function buildTimestamp(date = new Date()): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 避免同一秒内多次备份撞名 */
async function resolveTimestampRoot(backupRoot: string, timestamp: string): Promise<{ timestamp: string; root: string }> {
  let candidate = timestamp;
  let index = 1;
  // 最多尝试 100 次，避免极端情况下死循环
  while (index <= 100) {
    const root = path.join(backupRoot, candidate);
    try {
      await fs.access(root);
      index++;
      candidate = `${timestamp}-${index}`;
    } catch {
      return { timestamp: candidate, root };
    }
  }
  const fallback = `${timestamp}-${Date.now()}`;
  return { timestamp: fallback, root: path.join(backupRoot, fallback) };
}

function backupRootPath(workspaceRoot: string) {
  return path.join(workspaceRoot, BACKUP_DIR_NAME, BACKUP_SUBDIR);
}

async function fileSize(fsPath: string): Promise<number> {
  try {
    const stat = await fs.stat(fsPath);
    return stat.size;
  } catch {
    return 0;
  }
}

async function pathExists(fsPath: string): Promise<boolean> {
  try {
    await fs.access(fsPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 备份服务。
 *
 * 约定：备份统一落在 `<工作区>/.zy-svga/backup/<时间戳>/`，
 * 其中 files/ 下按序号存放副本，manifest.json 记录原始路径映射，
 * 这样还原时不依赖任何路径推断，也不存在路径穿越风险。
 */
class BackupService {
  /** 创建一批备份，返回批次信息；传入空数组时返回 null */
  public async create(workspaceRoot: string, sourceFsPaths: string[]): Promise<BackupEntry | null> {
    const sources = Array.from(new Set(sourceFsPaths.filter(Boolean)));
    if (!sources.length) return null;

    const root = backupRootPath(workspaceRoot);
    await fs.mkdir(root, { recursive: true });
    const resolved = await resolveTimestampRoot(root, buildTimestamp());
    const filesDir = path.join(resolved.root, FILES_SUBDIR);
    await fs.mkdir(filesDir, { recursive: true });

    const manifest: BackupManifest = {
      createdAt: Date.now(),
      timestamp: resolved.timestamp,
      files: [],
    };

    let index = 0;
    for (const sourceFsPath of sources) {
      if (!(await pathExists(sourceFsPath))) continue;
      const size = await fileSize(sourceFsPath);
      const slot = String(index).padStart(4, "0");
      const slotDir = path.join(filesDir, slot);
      await fs.mkdir(slotDir, { recursive: true });
      const backupFsPath = path.join(slotDir, path.basename(sourceFsPath));
      await fs.copyFile(sourceFsPath, backupFsPath);
      manifest.files.push({ sourceFsPath, backupFsPath, size });
      index++;
    }

    if (!manifest.files.length) {
      // 没有任何有效源文件，回滚掉空目录
      await fs.rm(resolved.root, { recursive: true, force: true });
      return null;
    }

    await fs.writeFile(path.join(resolved.root, MANIFEST_NAME), JSON.stringify(manifest, null, 2), "utf8");

    return {
      timestamp: resolved.timestamp,
      rootPath: resolved.root,
      fileCount: manifest.files.length,
      totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
      createdAt: manifest.createdAt,
      files: manifest.files,
    };
  }

  /** 列出全部备份批次，按时间倒序 */
  public async list(workspaceRoot: string): Promise<BackupEntry[]> {
    const root = backupRootPath(workspaceRoot);
    if (!(await pathExists(root))) return [];

    let entries: string[] = [];
    try {
      const dirents = await fs.readdir(root, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }

    const result: BackupEntry[] = [];
    for (const timestamp of entries) {
      const batchRoot = path.join(root, timestamp);
      const manifestPath = path.join(batchRoot, MANIFEST_NAME);
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const manifest = JSON.parse(raw) as BackupManifest;
        result.push({
          timestamp,
          rootPath: batchRoot,
          fileCount: manifest.files.length,
          totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
          createdAt: manifest.createdAt,
          files: manifest.files,
        });
      } catch {
        // 缺少或损坏的 manifest 直接跳过，不影响其它批次
      }
    }

    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 读取单个批次的清单 */
  public async readManifest(workspaceRoot: string, timestamp: string): Promise<BackupManifest | null> {
    const manifestPath = path.join(backupRootPath(workspaceRoot), timestamp, MANIFEST_NAME);
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      return JSON.parse(raw) as BackupManifest;
    } catch {
      return null;
    }
  }

  /**
   * 还原指定批次。
   *
   * 还原前会把当前文件再备份一次到 `<批次>/pre-restore/`，
   * 避免"还原"本身变成不可逆操作。
   */
  public async restore(
    workspaceRoot: string,
    timestamp: string
  ): Promise<{ restored: string[]; failed: Array<{ sourceFsPath: string; reason: string }> }> {
    const manifest = await this.readManifest(workspaceRoot, timestamp);
    if (!manifest) {
      return { restored: [], failed: [{ sourceFsPath: "-", reason: `找不到备份批次 ${timestamp}` }] };
    }

    const batchRoot = path.join(backupRootPath(workspaceRoot), timestamp);
    const preRestoreDir = path.join(batchRoot, "pre-restore");
    await fs.mkdir(preRestoreDir, { recursive: true });

    const restored: string[] = [];
    const failed: Array<{ sourceFsPath: string; reason: string }> = [];

    for (const file of manifest.files) {
      try {
        if (!(await pathExists(file.backupFsPath))) {
          failed.push({ sourceFsPath: file.sourceFsPath, reason: "备份文件已丢失" });
          continue;
        }
        // 先把当前状态存档，保证还原也可回退
        if (await pathExists(file.sourceFsPath)) {
          await fs.copyFile(file.sourceFsPath, path.join(preRestoreDir, path.basename(file.sourceFsPath)));
        }
        await fs.mkdir(path.dirname(file.sourceFsPath), { recursive: true });
        await fs.copyFile(file.backupFsPath, file.sourceFsPath);
        restored.push(file.sourceFsPath);
      } catch (e) {
        failed.push({
          sourceFsPath: file.sourceFsPath,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { restored, failed };
  }

  /** 只还原单个文件（取该批次中匹配的记录） */
  public async restoreFile(
    workspaceRoot: string,
    timestamp: string,
    sourceFsPath: string
  ): Promise<{ ok: boolean; reason?: string }> {
    const manifest = await this.readManifest(workspaceRoot, timestamp);
    if (!manifest) return { ok: false, reason: `找不到备份批次 ${timestamp}` };
    const target = manifest.files.find((file) => file.sourceFsPath === sourceFsPath);
    if (!target) return { ok: false, reason: "该批次中没有这个文件的备份" };
    try {
      if (!(await pathExists(target.backupFsPath))) return { ok: false, reason: "备份文件已丢失" };
      await fs.mkdir(path.dirname(sourceFsPath), { recursive: true });
      await fs.copyFile(target.backupFsPath, sourceFsPath);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 清理最旧的批次，只保留最近 keep 个 */
  public async prune(workspaceRoot: string, keep = DEFAULT_KEEP_BACKUPS): Promise<string[]> {
    const all = await this.list(workspaceRoot);
    const removed: string[] = [];
    for (const entry of all.slice(keep)) {
      try {
        await fs.rm(entry.rootPath, { recursive: true, force: true });
        removed.push(entry.timestamp);
      } catch {
        // 清理失败不影响主流程
      }
    }
    return removed;
  }

  /** 清空所有备份 */
  public async clearAll(workspaceRoot: string): Promise<void> {
    const root = backupRootPath(workspaceRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
}

export default new BackupService();
