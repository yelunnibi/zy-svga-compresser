import type { ParsedPath } from "path";

declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: "development" | "production";
    mikas_libvips_loaded: boolean;
  }
}

export interface IPCMessage {
  signal: string;
  payload: any;
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 3,
}

export enum CompressedState {
  IDLE = "idle",
  PENDING = "pending",
  FULFILLED = "fulfilled",
  REJECTED = "rejected",
  SAVED = "saved",
}

export interface DirectoryStructureNode {
  key: string;
  title: string;
  isLeaf: boolean;
  name: string;
  fsPath: string;
  type: FileType.File | FileType.Directory;
  size?: number;
  parsedInfo: ParsedPath;
  parentPath: string;
  children?: Array<DirectoryStructureNode>;
}

/**
 * 解码内存风险等级
 * - safe    安全
 * - caution 需要留意
 * - danger  高风险，低端设备易 OOM
 */
export type MemoryRisk = "safe" | "caution" | "danger";

/** 单张纹理解码后的信息 */
export interface SvgaTextureInfo {
  /** imageKey */
  key: string;
  /** 图片本身的像素宽（不是画布宽） */
  width: number;
  /** 图片本身的像素高 */
  height: number;
  /** 解码为 RGBA8888 位图后占用的字节数 = width * height * 4 */
  bytes: number;
  /** 压缩前编码格式 */
  format?: string;
  /** 该纹理是否含透明通道（决定能否安全转 JPEG） */
  hasAlpha?: boolean;
  /** 尺寸解析失败的标记 */
  parseError?: string;
}

/**
 * SVGA 解码内存估算结果
 *
 * 计算依据：播放器（Android BitmapFactory / Flutter ui.Image）会把内嵌图片
 * 全部解码为 RGBA8888 位图常驻内存，每像素 4 字节，与压缩后的文件体积无关。
 */
export interface DecodeMemoryInfo {
  /** 全部纹理解码后的总字节数 */
  totalBytes: number;
  /** 纹理张数 */
  textureCount: number;
  /** 占用最大的那张纹理 */
  maxTexture: SvgaTextureInfo | null;
  /** 风险等级 */
  risk: MemoryRisk;
  /** 尺寸解析失败的纹理数量 */
  unresolvedCount: number;
  /** 明细（用于展开详情，体积较大时可省略） */
  textures: SvgaTextureInfo[];
}

/** 内存阈值配置（字节），超过 danger 视为高风险 */
export interface MemoryThreshold {
  /** 安全上限，默认 30MB */
  safe: number;
  /** 危险下限，默认 80MB */
  danger: number;
}

/** SVGA 帧率处理参数 */
export interface SvgaFpsOptions {
  /** 是否启用帧率调整 */
  enabled: boolean;
  /** 目标 fps；<=0 或 >= 原 fps 时不生效 */
  target: number;
  /**
   * 是否保持原时长
   * - true  丢帧重采样：抽掉多余帧，时长不变，体积真降（推荐）
   * - false 只改 fps 数值：时长改变（快放/慢放），体积几乎不变
   */
  keepDuration: boolean;
}

/** SVGA 纹理分辨率参数 */
export interface SvgaTextureOptions {
  /** none 不缩放 / ratio 等比缩放 / maxEdge 限制最长边 */
  mode: "none" | "ratio" | "maxEdge";
  /** 等比缩放比例，0.05 - 1 */
  ratio: number;
  /** 最长边像素上限，mode = maxEdge 时生效 */
  maxEdge: number;
}

/** SVGA 画布与布局参数 */
export interface SvgaCanvasOptions {
  /** 默认关闭：开启后会改变播放尺寸，前端需同步调整 */
  enabled: boolean;
  /** 画布与布局坐标的缩放比例，0.05 - 1 */
  ratio: number;
}

/** SVGA 图片编码参数 */
export interface SvgaEncodeOptions {
  /** 保持原图片格式（推荐，避免无谓的体积膨胀） */
  keepFormat: boolean;
  /** keepFormat = false 时使用的目标格式 */
  format: "png" | "jpeg" | "webp";
  /** 编码质量 1 - 100 */
  quality: number;
  /** PNG 是否使用调色板量化（体积更小，颜色多时会有色带） */
  palette: boolean;
}

/** 无引用纹理回收参数 */
export interface SvgaReclaimOptions {
  /**
   * 回收没有被任何 sprite 引用的内嵌图片。
   *
   * 有些 SVGA 里存在画面上永远用不到的闲置图片——设计换了素材、导出工具没清理，
   * 都会留下这种图。它们照样占着解码内存，删掉能同时降体积和降内存。
   *
   * 注意：抽帧**不会**制造孤儿纹理（图片引用挂在 sprite 上，抽帧只改 frames，
   * 不动 sprite），所以这个开关和 fps 抽帧是两个独立的事，开它不会让抽帧降内存。
   */
  enabled: boolean;
}

/** SVGA 压缩完整参数 */
export interface SvgaCompressOptions {
  fps: SvgaFpsOptions;
  texture: SvgaTextureOptions;
  canvas: SvgaCanvasOptions;
  encode: SvgaEncodeOptions;
  reclaim: SvgaReclaimOptions;
}

/** 纹理回收结果 */
export interface SvgaReclaimReport {
  /** 本次是否执行了回收 */
  enabled: boolean;
  /** 被删掉的纹理 key（enabled = false 时为空） */
  reclaimedKeys: string[];
  /** 被删掉的纹理数量 */
  reclaimedCount: number;
  /** 估算释放的解码内存（字节） */
  reclaimedBytes: number;
  /** 产物里最终保留的纹理数量 */
  keptCount: number;
  /**
   * 产物里仍然闲置（没有任何 sprite 引用）的图片数量。
   *
   * enabled = true 时正常应为 0；enabled = false 时它就是「还能再省多少」的答案，
   * 用来区分“这文件本来就没有闲置图片”和“有闲置图片但你没开回收”。
   */
  orphanCount: number;
}

/** 压缩前计算出的实际应用计划，用于界面回显“到底用了什么参数” */
export interface SvgaAppliedPlan {
  /** 原始 fps */
  originFps: number;
  /** 原始总帧数 */
  originFrames: number;
  /** 实际生效的 fps（丢帧只能按整数倍抽帧，可能与目标值有偏差） */
  fps: number;
  /** 实际生效的总帧数 */
  frames: number;
  /** 抽帧步长，1 表示未抽帧 */
  frameStep: number;
  /** 纹理统一缩放比例（maxEdge 模式下为估计值） */
  textureScale: number;
  /** 画布缩放比例 */
  canvasScale: number;
  /** 画布尺寸 */
  viewBoxWidth: number;
  viewBoxHeight: number;
  /** 目标时长（秒） */
  duration: number;
  /** 版本号是否因参数变更而提升 */
  version: string;
}

/** SVGA 压缩结果 */
export interface SvgaCompressResult {
  /** 压缩产物路径 */
  destination: string;
  /** 压缩前的统计 */
  before: {
    size: number;
    fps: number;
    frames: number;
    viewBoxWidth: number;
    viewBoxHeight: number;
    memory: DecodeMemoryInfo;
  };
  /** 压缩后的统计 */
  after: {
    size: number;
    fps: number;
    frames: number;
    viewBoxWidth: number;
    viewBoxHeight: number;
    memory: DecodeMemoryInfo;
  };
  /** 实际应用的计划 */
  applied: SvgaAppliedPlan;
  /** 无引用纹理回收结果 */
  reclaim: SvgaReclaimReport;
}

/** 落盘模式 */
export enum SaveMode {
  /** 输出 .min 副本，不动原文件 */
  Copy = "copy",
  /** 直接覆盖原文件，不备份 */
  Overwrite = "overwrite",
  /** 覆盖原文件并自动备份（默认） */
  OverwriteWithBackup = "overwriteWithBackup",
}

/** 备份条目 */
export interface BackupEntry {
  /** 备份批次时间戳目录名 */
  timestamp: string;
  /** 备份根目录绝对路径 */
  rootPath: string;
  /** 该批次内的文件数 */
  fileCount: number;
  /** 总字节数 */
  totalBytes: number;
  /** 创建时间（毫秒） */
  createdAt: number;
  /** 该批次内的文件映射 */
  files: Array<{
    /** 原文件路径 */
    sourceFsPath: string;
    /** 备份文件路径 */
    backupFsPath: string;
    /** 原文件大小 */
    size: number;
  }>;
}

/** 备份清单文件结构（落在 .zy-svga/backup/<timestamp>/manifest.json） */
export interface BackupManifest {
  createdAt: number;
  timestamp: string;
  files: Array<{
    sourceFsPath: string;
    backupFsPath: string;
    size: number;
  }>;
}

/** 内存优化建议 */
export interface MemoryAdvice {
  /** 是否给出建议 */
  available: boolean;
  /** 目标内存上限（字节） */
  targetBytes: number;
  /** 建议的纹理缩放比例 */
  suggestedTextureRatio: number;
  /** 预计达成后的内存（字节） */
  estimatedBytes: number;
  /** 一句话说明 */
  message: string;
}

export interface ImageDirectoryStructureNode {
  compressedState: CompressedState;
  sourceWebviewUri: string;
  optimizedFsPath: string;
  optimizedWebviewUri: string;
  optimizedSize: number;
  errorMessage: string;
  disabled: boolean;
  disableCheckbox: boolean;
  dimensions: {
    width: number;
    height: number;
    error?: string;
    // svga only
    viewBoxWidth?: number;
    viewBoxHeight?: number;
    fps?: number;
    frames?: number;
    version?: string;
  };
  optimizedDimensions: {
    width: number;
    height: number;
  };
  /** svga 专用：原文件解码内存估算 */
  memory?: DecodeMemoryInfo;
  /** svga 专用：压缩后解码内存估算 */
  optimizedMemory?: DecodeMemoryInfo;
  /** svga 专用：本次实际应用的压缩计划 */
  appliedPlan?: SvgaAppliedPlan;
  /** svga 专用：无引用纹理回收结果 */
  reclaimReport?: SvgaReclaimReport;
  /** svga 专用：该文件单独覆盖的参数，缺省表示使用全局参数 */
  svgaOptions?: SvgaCompressOptions;
  /** 该文件最近的备份记录 */
  backup?: {
    timestamp: string;
    backupFsPath: string;
    createdAt: number;
  };
  extra?: Record<string, any>;
  children?: Array<ImageDirectoryStructureNode>;
}

export type WorkspaceNode = DirectoryStructureNode & ImageDirectoryStructureNode;

export enum WebviewIPCSignal {
  CompressSelected = "webview.compressSelected",
  CompressCurrent = "webview.compressCurrent",
  SaveSelected = "webview.saveSelected",
  SaveCurrent = "webview.saveCurrent",
  OpenFile = "webview.openFile",
  OpenFileInExplorer = "webview.openFileInExplorer",
  /** 参数变更：全局或针对单个文件 */
  UpdateSvgaOptions = "webview.updateSvgaOptions",
  /** 请求按目标内存生成缩放建议 */
  RequestMemoryAdvice = "webview.requestMemoryAdvice",
  /** 应用内存建议并重压 */
  ApplyMemoryAdvice = "webview.applyMemoryAdvice",
  /** 请求备份列表 */
  RequestBackupList = "webview.requestBackupList",
  /** 还原指定备份批次 */
  RestoreBackup = "webview.restoreBackup",
  /** 导出诊断日志到文件，payload 里带上 webview 侧的日志 */
  ExportLog = "webview.exportLog",
  /** 在「输出」面板打开日志通道 */
  ShowLog = "webview.showLog",
}

export enum ExtensionIPCSignal {
  Init = "extension.init",
  TinypngUsageUpdate = "extension.tinypngUsageUpdate",
  Compressed = "extension.compressed",
  AllCompressed = "extension.allCompressed",
  CurrentCompressed = "extension.currentCompressed",
  Saved = "extension.saved",
  CurrentSaved = "extension.currentSaved",
  AllSaved = "extension.AllSaved",
  /** 参数已更新，携带全局参数与各文件覆盖值 */
  SvgaOptionsUpdated = "extension.svgaOptionsUpdated",
  /** 内存建议返回 */
  MemoryAdvice = "extension.memoryAdvice",
  /** 备份列表 */
  BackupList = "extension.backupList",
  /** 还原完成 */
  Restored = "extension.restored",
}

export enum ExecutedStatus {
  Fulfilled = "fulfilled",
  Rejected = "rejected",
}

/**
 * SVGA protobuf 结构（对齐 config/svgaProto.json）
 * 注意：protobufjs 解码产出的是普通对象，这里用 interface 描述便于读写。
 */
export declare namespace SvgaParsed {
  interface MovieParams {
    viewBoxWidth: number;
    viewBoxHeight: number;
    fps: number;
    frames: number;
  }

  interface Layout {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface Transform {
    a: number;
    b: number;
    c: number;
    d: number;
    tx: number;
    ty: number;
  }

  interface RectArgs {
    x: number;
    y: number;
    width: number;
    height: number;
    cornerRadius?: number;
  }

  interface EllipseArgs {
    x: number;
    y: number;
    radiusX: number;
    radiusY: number;
  }

  interface ShapeArgs {
    d: string;
  }

  interface RGBAColor {
    r: number;
    g: number;
    b: number;
    a: number;
  }

  interface ShapeStyle {
    fill?: RGBAColor;
    stroke?: RGBAColor;
    strokeWidth?: number;
    lineCap?: number;
    lineJoin?: number;
    miterLimit?: number;
    lineDashI?: number;
    lineDashII?: number;
    lineDashIII?: number;
  }

  interface ShapeEntity {
    type: number;
    shape?: ShapeArgs;
    rect?: RectArgs;
    ellipse?: EllipseArgs;
    styles?: ShapeStyle;
    transform?: Transform;
  }

  interface FrameEntity {
    alpha: number;
    layout?: Layout;
    transform?: Transform;
    clipPath?: string;
    shapes?: ShapeEntity[];
  }

  interface SpriteEntity {
    imageKey: string;
    frames: FrameEntity[];
    matteKey?: string;
  }

  interface AudioEntity {
    audioKey: string;
    startFrame: number;
    endFrame: number;
    startTime: number;
    totalTime: number;
  }

  interface MovieEntity {
    version: string;
    params: MovieParams;
    images: Record<string, Uint8Array>;
    sprites: SpriteEntity[];
    audios: AudioEntity[];
  }
}
