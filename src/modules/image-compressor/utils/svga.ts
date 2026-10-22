import * as fs from "fs/promises";
import * as pako from "pako";
import protobuf from "protobufjs";
import svgaProto from "@image-compressor/config/svgaProto.json";
import * as imageSizeModule from "image-size";
import * as os from "os";
import * as path from "path";
import logger from "./logger";
import type {
  DecodeMemoryInfo,
  MemoryAdvice,
  MemoryRisk,
  MemoryThreshold,
  SvgaAppliedPlan,
  SvgaCompressOptions,
  SvgaCompressResult,
  SvgaParsed,
  SvgaReclaimReport,
  SvgaTextureInfo,
} from "@image-compressor/typing";

/**
 * 解码后每像素字节数。
 *
 * 播放器（Android BitmapFactory / Flutter ui.Image / iOS CGImage）会把内嵌图片
 * 统一解码成 RGBA8888 位图，每像素固定 4 字节。这一步与图片原本是 PNG 还是
 * JPEG、压缩率多高都无关，因此“文件体积”和“解码内存”是两个独立指标。
 */
const BYTES_PER_PIXEL = 4;

/** 默认内存阈值：30MB 以下安全，80MB 以上高风险 */
export const DEFAULT_MEMORY_THRESHOLD: MemoryThreshold = {
  safe: 30 * 1024 * 1024,
  danger: 80 * 1024 * 1024,
};

/** 默认压缩参数：全部关闭，行为与改造前一致 */
export const DEFAULT_SVGA_OPTIONS: SvgaCompressOptions = {
  fps: { enabled: false, target: 0, keepDuration: true },
  texture: { mode: "none", ratio: 1, maxEdge: 0 },
  canvas: { enabled: false, ratio: 1 },
  encode: { keepFormat: true, format: "png", quality: 80, palette: true },
  reclaim: { enabled: false },
};

/** 尺寸解析容错：兼容 CJS/ESM 互操作，解析失败返回 null */
function safeImageSize(buffer: Buffer): { width?: number; height?: number; type?: string } | null {
  try {
    const fn: any = (imageSizeModule as any).default || imageSizeModule;
    if (typeof fn !== "function") return null;
    return fn(buffer);
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 保留两位小数，避免浮点误差在 protobuf 里堆积 */
function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * 按比例缩放 SVG 路径字符串（`ShapeArgs.d` 与 `FrameEntity.clipPath`）。
 *
 * 为什么需要它：SVGA 的矢量路径是一段 SVG path 字符串（`d`），它与 rect/ellipse
 * 处在**同一套坐标系**里。画布缩放（applyCanvasScale）会等比放大 viewBox 与所有
 * 几何坐标，如果唯独落下路径字符串，路径类矢量就会停留在旧坐标上，相对其它图层错位。
 *
 * 缩放规则：
 * - 所有坐标数值 ×scale（绝对指令与相对指令的位移量都要缩放）；
 * - 唯一例外是 `A`/`a`（椭圆弧）指令：第 3 个参数（x 轴旋转角）与第 4、5 个参数
 *   （large-arc / sweep 标志位）是无量纲的，保持原值；
 * - 标志位允许与相邻数值连写（如 `011`），按单字符读取。
 */
export function scalePathData(d: string, scale: number): string {
  if (!d || !Number.isFinite(scale) || scale <= 0 || scale === 1) return d;
  const tokens: string[] = [];
  const len = d.length;
  let i = 0;
  let cmd = "";
  let argIndex = 0;

  while (i < len) {
    const ch = d[i];
    if (ch === " " || ch === "," || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f") {
      i++;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      cmd = ch;
      argIndex = 0;
      tokens.push(ch);
      i++;
      continue;
    }

    const lower = cmd.toLowerCase();
    const slot = argIndex % 7;
    const isArcFlag = lower === "a" && (slot === 3 || slot === 4);
    const isArcRotation = lower === "a" && slot === 2;

    if (isArcFlag) {
      tokens.push(d[i] === "1" ? "1" : "0");
      i++;
      argIndex++;
      continue;
    }

    const start = i;
    if (d[i] === "+" || d[i] === "-") i++;
    while (i < len && d[i] >= "0" && d[i] <= "9") i++;
    if (d[i] === ".") {
      i++;
      while (i < len && d[i] >= "0" && d[i] <= "9") i++;
    }
    if (d[i] === "e" || d[i] === "E") {
      let j = i + 1;
      if (d[j] === "+" || d[j] === "-") j++;
      if (d[j] >= "0" && d[j] <= "9") {
        i = j;
        while (i < len && d[i] >= "0" && d[i] <= "9") i++;
      }
    }
    let value = parseFloat(d.slice(start, i));
    if (!Number.isFinite(value)) value = 0;
    tokens.push(String(isArcRotation ? round2(value) : round2(value * scale)));
    argIndex++;
  }

  return tokens.join(" ");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 压缩日志的行前缀。
 *
 * 一批文件是并发压的（默认 6 并发），日志会交错在一起。没有这个前缀，
 * 你看到的就只是「图 a.png 1024x1024 → 512x512」这种句子，
 * 根本分不清它属于哪个文件。带上任务号后，`grep '#3'` 就是一条完整的时间线。
 */
function logFlag(logTag: string): string {
  return logTag ? `svgaCompress${logTag}` : "svgaCompress";
}

class SvgaUtility {
  private sharp: typeof import("sharp") | undefined;
  public protoMovieEntity = protobuf.Root.fromJSON(svgaProto).lookupType("com.opensource.svga.MovieEntity");

  /** 内存阈值，可由外部按 VSCode 配置覆盖 */
  public memoryThreshold: MemoryThreshold = { ...DEFAULT_MEMORY_THRESHOLD };

  public setMemoryThreshold(threshold: Partial<MemoryThreshold>) {
    this.memoryThreshold = {
      safe: threshold.safe ?? this.memoryThreshold.safe,
      danger: threshold.danger ?? this.memoryThreshold.danger,
    };
  }

  private async getSharp() {
    if (!this.sharp) {
      this.sharp = (await import("sharp")).default;
      // 降低并发以控制峰值内存占用
      const divisor = process.env.NODE_ENV === "development" ? 4 : 2;
      this.sharp.concurrency(Math.floor(Math.max(os.cpus().length / divisor, 1)));
    }
    return this.sharp;
  }

  public async parse(fsPath: string): Promise<{
    movieEntity: SvgaParsed.MovieEntity;
  }> {
    const buffer = await fs.readFile(fsPath);
    const movieEntity = this.protoMovieEntity.decode(pako.inflate(Uint8Array.from(buffer)));
    return {
      movieEntity: movieEntity as unknown as SvgaParsed.MovieEntity,
    };
  }

  /** 把已经解码好的 movieEntity 编码回 .svga 文件内容 */
  public encode(movieEntity: SvgaParsed.MovieEntity): Buffer {
    const encoded = this.protoMovieEntity.encode(movieEntity).finish();
    return Buffer.from(pako.deflate(encoded));
  }

  // ---------------------------------------------------------------- 内存分析

  private gradeRisk(totalBytes: number): MemoryRisk {
    if (totalBytes > this.memoryThreshold.danger) return "danger";
    if (totalBytes > this.memoryThreshold.safe) return "caution";
    return "safe";
  }

  /**
   * 估算解码内存。
   *
   * 内存 = Σ(纹理宽 × 纹理高) × 4 字节
   *
   * 注意这是**保守上界**：未考虑播放器可能做的纹理复用，也不含音频。
   * 实际值可能更低，不会更高——对预警场景而言，宁可估高不估低。
   */
  public analyzeMemory(movieEntity: SvgaParsed.MovieEntity): DecodeMemoryInfo {
    const images = movieEntity?.images || {};
    const textures: SvgaTextureInfo[] = [];
    let unresolvedCount = 0;

    for (const [key, raw] of Object.entries(images)) {
      let width = 0;
      let height = 0;
      let format: string | undefined;
      let parseError: string | undefined;

      try {
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        const dim = safeImageSize(buffer);
        if (dim && dim.width && dim.height) {
          width = dim.width;
          height = dim.height;
          format = dim.type;
        } else {
          parseError = "无法识别图片尺寸";
        }
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e);
      }

      if (parseError) unresolvedCount++;

      textures.push({
        key,
        width,
        height,
        bytes: width * height * BYTES_PER_PIXEL,
        format,
        parseError,
      });
    }

    let totalBytes = 0;
    let maxTexture: SvgaTextureInfo | null = null;
    for (const texture of textures) {
      totalBytes += texture.bytes;
      if (!maxTexture || texture.bytes > maxTexture.bytes) maxTexture = texture;
    }

    return {
      totalBytes,
      textureCount: textures.length,
      maxTexture,
      risk: this.gradeRisk(totalBytes),
      unresolvedCount,
      textures,
    };
  }

  /**
   * 反推建议：给定目标内存上限，算出纹理应该缩放到多少。
   *
   * 内存与纹理面积成正比、与缩放比例平方成正比，因此
   * 缩放比例 = sqrt(目标 / 当前)
   */
  public buildMemoryAdvice(currentBytes: number, targetBytes: number, textureCount: number): MemoryAdvice {
    if (!currentBytes || currentBytes <= targetBytes) {
      return {
        available: false,
        targetBytes,
        suggestedTextureRatio: 1,
        estimatedBytes: currentBytes,
        message: "当前解码内存已在目标范围内，无需额外缩放纹理",
      };
    }
    const ratio = clamp(Math.sqrt(targetBytes / currentBytes), 0.1, 1);
    const estimatedBytes = Math.round(currentBytes * ratio * ratio);
    const percent = Math.round(ratio * 100);
    return {
      available: true,
      targetBytes,
      suggestedTextureRatio: ratio,
      estimatedBytes,
      message: `纹理缩放到 ${percent}% 可降到约 ${formatBytes(estimatedBytes)}（共 ${textureCount} 张纹理）`,
    };
  }

  // ------------------------------------------------------------- 参数计算

  /**
   * 计算实际生效的压缩计划，不修改数据。
   *
   * 「丢帧保时长」的做法：把目标帧率取整后当作**真正生效的帧率**，再按
   * 帧数 ≈ 原帧数 × 新帧率 ÷ 原帧率 反推帧数（这样 帧数/帧率 ≈ 原时长）。
   * 之所以必须以帧率为锚、而不是像以前那样先定整数步长，
   * 是因为 `MovieParams.fps` 在 protobuf 里是 **int32**，小数会被截断：
   * 老写法 `fps = round2(originFps / frameStep)` 遇到 20/3 = 6.67 会存成 6，
   * 于是「保时长」反而把时长拉长了（100 帧 step3 → 34 帧 @6fps = 5.667s，原 5s），
   * 而且实际帧率常常离用户设的目标很远（20fps 设目标 13 实际只有 10）。
   *
   * 代价：帧数取整会带来不超过半帧的时长误差（≤ 0.5/新帧率 秒，10fps 时 ≤50ms），
   * 换来的是**目标帧率被如实执行**。界面上的 `frameStep` 是平均步长
   * （原帧数 ÷ 产物帧数，可含小数），>1 即表示确实抽掉了帧。
   */
  public planTransform(movieEntity: SvgaParsed.MovieEntity, options: SvgaCompressOptions): SvgaAppliedPlan {
    const params = movieEntity?.params || ({} as SvgaParsed.MovieParams);
    const originFps = params.fps || 0;
    const originFrames = params.frames || 0;

    let fps = originFps;
    let frames = originFrames;
    let frameStep = 1;

    const wantFps = options.fps?.enabled ? options.fps.target : 0;
    if (wantFps > 0 && originFps > 0 && wantFps < originFps) {
      if (options.fps.keepDuration && originFrames > 0) {
        // 丢帧保时长：帧率取整（int32 存不了小数），帧数按「时长不变」反推
        const target = Math.max(1, Math.round(wantFps));
        const nextFrames = Math.max(1, Math.round((originFrames * target) / originFps));
        if (target < originFps && nextFrames < originFrames) {
          fps = target;
          frames = nextFrames;
          frameStep = round2(originFrames / nextFrames);
        }
        // 目标帧率与原帧率过于接近（抽不出整帧）时维持原样，不产生无意义的改动
      } else {
        // 只改数值：时长改变，体积几乎不变。
        // 同样要取整 —— fps 存的是 int32，小数会被静默截断，回显的 fps 必须与落盘的数值一致。
        fps = Math.max(1, Math.round(wantFps));
        frames = originFrames;
        frameStep = 1;
      }
    }

    const textureScale = this.resolveUniformTextureScale(movieEntity, options);
    const canvasScale = options.canvas?.enabled ? clamp(options.canvas.ratio, 0.05, 1) : 1;

    return {
      originFps,
      originFrames,
      fps,
      frames,
      frameStep,
      textureScale,
      canvasScale,
      viewBoxWidth: round2((params.viewBoxWidth || 0) * canvasScale),
      viewBoxHeight: round2((params.viewBoxHeight || 0) * canvasScale),
      duration: fps > 0 ? round2(frames / fps) : 0,
      version: movieEntity?.version || "",
    };
  }

  /** 单张纹理的目标缩放比例 */
  private resolveTextureScale(width: number, height: number, options: SvgaCompressOptions): number {
    const texture = options.texture || DEFAULT_SVGA_OPTIONS.texture;
    let scale = 1;
    if (texture.mode === "ratio") {
      scale = clamp(texture.ratio, 0.05, 1);
    } else if (texture.mode === "maxEdge" && texture.maxEdge > 0) {
      const longest = Math.max(width, height);
      if (longest > texture.maxEdge) scale = texture.maxEdge / longest;
    }
    // 画布缩放时纹理必须同步缩小，否则白占内存
    if (options.canvas?.enabled) {
      scale *= clamp(options.canvas.ratio, 0.05, 1);
    }
    return clamp(scale, 0.05, 1);
  }

  /** 用于界面展示的统一纹理缩放比例（maxEdge 模式下取各纹理的最小值作为保守估计） */
  private resolveUniformTextureScale(movieEntity: SvgaParsed.MovieEntity, options: SvgaCompressOptions): number {
    const images = movieEntity?.images || {};
    const keys = Object.keys(images);
    if (!keys.length) {
      const texture = options.texture || DEFAULT_SVGA_OPTIONS.texture;
      const canvasScale = options.canvas?.enabled ? clamp(options.canvas.ratio, 0.05, 1) : 1;
      if (texture.mode === "ratio") return clamp(texture.ratio, 0.05, 1) * canvasScale;
      return canvasScale;
    }
    let minScale = 1;
    for (const key of keys) {
      const raw = images[key];
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      const dim = safeImageSize(buffer);
      if (!dim?.width || !dim?.height) continue;
      const scale = this.resolveTextureScale(dim.width, dim.height, options);
      if (scale < minScale) minScale = scale;
    }
    return clamp(minScale, 0.05, 1);
  }

  // ------------------------------------------------------------- 数据变换

  /**
   * 收集所有被 sprite 引用到的图片 key。
   *
   * SVGA 的 protobuf 里，图片引用**只有两个来源**（config/svgaProto.json）：
   *   - SpriteEntity.imageKey (id 1)：这个 sprite 画的是哪张图
   *   - SpriteEntity.matteKey (id 3)：这个 sprite 的遮罩用哪张图
   *
   * ShapeEntity 里没有 imageKey，图形都是矢量绘制，所以不需要递归遍历 shapes。
   * matteKey 按“保守偏安全”处理：即使某些播放器把 matteKey 当成另一个 sprite 的
   * imageKey 而不是 images 的键，把它算进引用集合也只是让我们少删一张图，不会出错。
   *
   * ⚠️ 引用集合**不等于**“必须存在于 images 的键”。AE 导出器会把矢量图层写成
   * sprite.imageKey = "形状图层1.vector" 这类名字，而 images 里根本没有这个条目
   * （该 sprite 靠 frame.shapes 绘制）。播放器查不到位图就静默跳过，动画照常渲染。
   * 实测用户素材 113 个文件里有 56 个是这种情况，所以任何“引用必须在 images 里”
   * 的硬校验都会大面积误杀——判断该用 collectReferencedImageKeys() ∩ 源文件 images。
   */
  public collectReferencedImageKeys(movieEntity: SvgaParsed.MovieEntity): Set<string> {
    const keys = new Set<string>();
    for (const sprite of movieEntity?.sprites || []) {
      if (sprite?.imageKey) keys.add(sprite.imageKey);
      if (sprite?.matteKey) keys.add(sprite.matteKey);
    }
    return keys;
  }

  /**
   * 找出没有被任何 sprite 引用的图片（只统计，不修改）。
   *
   * `trusted = false` 表示连一个引用都没解析出来——正常 SVGA 不可能这样，
   * 出现即说明解析异常，此时任何删除决定都不可信，调用方必须放弃动手。
   */
  private analyzeOrphans(movieEntity: SvgaParsed.MovieEntity): { keys: string[]; bytes: number; trusted: boolean } {
    const images = movieEntity?.images || {};
    const allKeys = Object.keys(images);
    if (!allKeys.length) return { keys: [], bytes: 0, trusted: false };

    const referenced = this.collectReferencedImageKeys(movieEntity);
    if (!referenced.size) return { keys: [], bytes: 0, trusted: false };

    const keys: string[] = [];
    let bytes = 0;
    for (const key of allKeys) {
      if (referenced.has(key)) continue;
      keys.push(key);
      const raw = images[key];
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      const dim = safeImageSize(buffer);
      if (dim?.width && dim?.height) bytes += dim.width * dim.height * BYTES_PER_PIXEL;
    }
    return { keys, bytes, trusted: true };
  }

  /**
   * 回收没有被任何 sprite 引用的内嵌图片。
   *
   * 为什么会有孤儿纹理：图片引用挂在 sprite 上（SpriteEntity.imageKey / matteKey），
   * 而抽帧只删 `sprite.frames`、从来不删 sprite，所以**抽帧本身产生不了孤儿纹理**
   * （已用对照实验验证）。孤儿纹理的真正来源是文件本身就带着闲置图片——
   * 设计换过素材、导出工具没清理、或者上游工具删过 sprite 却留下了 images 条目。
   * 这类图照样要解码进内存，删掉才能真正降内存。
   *
   * 安全性：
   *   1. 判定依据是“有没有 sprite 引用”，不是“有没有出现在某帧里”。被引用的 key
   *      一张都不动，所以运行时的动态贴图（player.setImage(key, bitmap)）不受影响
   *      —— 动态贴图的目标 key 必然是某个 sprite 的 imageKey，否则画不出来。
   *   2. 引用集合为空时直接放弃。正常的 SVGA 不可能一张图都不被引用；出现这种情况
   *      说明解析异常，此时删除会把动画清空，宁可不动。
   */
  public reclaimUnusedTextures(movieEntity: SvgaParsed.MovieEntity): SvgaReclaimReport {
    const allKeys = Object.keys(movieEntity?.images || {});
    const { keys, bytes, trusted } = this.analyzeOrphans(movieEntity);

    // 解析不出引用：放弃删除，也不谎报“没有孤儿纹理”
    if (!trusted || !keys.length) {
      return {
        enabled: true,
        reclaimedKeys: [],
        reclaimedCount: 0,
        reclaimedBytes: 0,
        keptCount: allKeys.length,
        orphanCount: trusted ? keys.length : 0,
      };
    }

    const images = movieEntity.images;
    const next: Record<string, Uint8Array> = {};
    const drop = new Set(keys);
    for (const key of allKeys) {
      if (!drop.has(key)) next[key] = images[key];
    }
    movieEntity.images = next;

    return {
      enabled: true,
      reclaimedKeys: keys,
      reclaimedCount: keys.length,
      reclaimedBytes: bytes,
      keptCount: Object.keys(next).length,
      orphanCount: 0,
    };
  }

  /**
   * 抽帧：把每个 sprite 的帧序列降采样到 `targetFrames` 帧。
   *
   * ⚠️ 绝不能用 `frames.filter((_, i) => i % step === 0)`。它保留的是
   * 0, step, 2*step, … 这一串下标，当 n 不是 step 的整数倍时，最后一个入选
   * 的下标只到 `step * floor((n-1)/step)`，**原片最后一帧（n-1）永远进不来**。
   * 而播放器的终止条件是 `currentFrame = min(frames-1, …)`（player.js:185），
   * 产物只会播到新的末帧 —— 于是原片结尾那段动画（往往是"最终定格/结果"）
   * 被整段裁掉。0.0.10 之前的 slop_angle（100 帧 / step 2）就因此丢了第 99 帧，
   * 机器人滑入到位的收尾段消失了。
   *
   * 实现是**首尾对齐的最近邻取样**：按 `k*(n-1)/(m-1)` 取下标，
   * 保证 k=0 → 第 0 帧、k=m-1 → 第 n-1 帧，中间均匀落点。
   * 支持任意目标帧数（含 100→65 这种非整除场景），不依赖整数步长。
   */
  private applyFrameStep(movieEntity: SvgaParsed.MovieEntity, targetFrames: number) {
    const params = movieEntity.params;
    const originFrames = params?.frames || 0;
    const want = Math.max(1, Math.floor(targetFrames || 0));
    if (!(originFrames > 0) || want >= originFrames) return; // 未要求抽帧

    for (const sprite of movieEntity.sprites || []) {
      const frames = sprite.frames;
      if (!Array.isArray(frames) || frames.length <= 1) continue;
      const n = frames.length;
      const m = Math.min(want, n);
      if (m >= n) continue; // 该 sprite 本就不足一帧可抽，原样保留
      const denom = m - 1;
      const picked: SvgaParsed.FrameEntity[] = [];
      for (let k = 0; k < m; k++) {
        // m === 1 时 denom=0，退化为"只留末帧"（保住最终状态而非起始帧）
        const idx = denom > 0 ? Math.round((k * (n - 1)) / denom) : n - 1;
        picked.push(frames[Math.min(n - 1, Math.max(0, idx))]);
      }
      sprite.frames = picked;
    }

    if (params) {
      params.frames = Math.min(want, originFrames);
    }
  }

  /**
   * 画布与布局等比缩放。
   *
   * 会同步缩放：viewBox、每帧 layout、transform 平移量、裁切路径、图形坐标
   * （rect/ellipse/矢量路径 d）、描边宽度与虚线参数。
   * transform 的 a/b/c/d 是线性部分（旋转与剪切），不含平移，因此保持不变。
   */
  private applyCanvasScale(movieEntity: SvgaParsed.MovieEntity, scale: number) {
    if (scale === 1) return;
    const params = movieEntity.params;
    if (params) {
      params.viewBoxWidth = round2((params.viewBoxWidth || 0) * scale);
      params.viewBoxHeight = round2((params.viewBoxHeight || 0) * scale);
    }

    for (const sprite of movieEntity.sprites || []) {
      for (const frame of sprite.frames || []) {
        if (frame.layout) {
          frame.layout.x = round2(frame.layout.x * scale);
          frame.layout.y = round2(frame.layout.y * scale);
          frame.layout.width = round2(frame.layout.width * scale);
          frame.layout.height = round2(frame.layout.height * scale);
        }
        if (frame.transform) {
          frame.transform.tx = round2(frame.transform.tx * scale);
          frame.transform.ty = round2(frame.transform.ty * scale);
        }
        // 裁切路径是帧坐标系下的 SVG path 字符串，必须与 layout/transform 一起缩放
        if (typeof frame.clipPath === "string" && frame.clipPath) {
          frame.clipPath = scalePathData(frame.clipPath, scale);
        }
        for (const shape of frame.shapes || []) {
          if (shape.rect) {
            shape.rect.x = round2(shape.rect.x * scale);
            shape.rect.y = round2(shape.rect.y * scale);
            shape.rect.width = round2(shape.rect.width * scale);
            shape.rect.height = round2(shape.rect.height * scale);
            if (typeof shape.rect.cornerRadius === "number") {
              shape.rect.cornerRadius = round2(shape.rect.cornerRadius * scale);
            }
          }
          if (shape.ellipse) {
            shape.ellipse.x = round2(shape.ellipse.x * scale);
            shape.ellipse.y = round2(shape.ellipse.y * scale);
            shape.ellipse.radiusX = round2(shape.ellipse.radiusX * scale);
            shape.ellipse.radiusY = round2(shape.ellipse.radiusY * scale);
          }
          if (shape.transform) {
            shape.transform.tx = round2(shape.transform.tx * scale);
            shape.transform.ty = round2(shape.transform.ty * scale);
          }
          // 矢量路径（ShapeArgs.d）：与 rect/ellipse 同一坐标系，之前漏缩导致路径类矢量错位
          if (shape.shape && typeof shape.shape.d === "string") {
            shape.shape.d = scalePathData(shape.shape.d, scale);
          }
          if (shape.styles) {
            if (typeof shape.styles.strokeWidth === "number") {
              shape.styles.strokeWidth = round2(shape.styles.strokeWidth * scale);
            }
            // 虚线段长与间隔同样是坐标系长度，需要一并缩放（miterLimit 是无量纲比值，不动）
            for (const dashKey of ["lineDashI", "lineDashII", "lineDashIII"] as const) {
              const dash = shape.styles[dashKey];
              if (typeof dash === "number") {
                shape.styles[dashKey] = round2(dash * scale);
              }
            }
          }
        }
      }
    }
  }

  /** 决定单张纹理的目标格式 */
  private resolveTargetFormat(meta: { format?: string; hasAlpha?: boolean }, options: SvgaCompressOptions): string {
    const encode = options.encode || DEFAULT_SVGA_OPTIONS.encode;
    const origin = (meta.format || "").toLowerCase();
    const supported = ["png", "jpeg", "jpg", "webp"];

    if (encode.keepFormat && supported.includes(origin)) {
      return origin === "jpg" ? "jpeg" : origin;
    }

    let target = encode.format || "png";
    // 含透明的图片不能转 JPEG，否则透明区域会变黑
    if (target === "jpeg" && meta.hasAlpha) target = "png";
    return target;
  }

  private async encodeTexture(
    pipeline: import("sharp").Sharp,
    format: string,
    options: SvgaCompressOptions
  ): Promise<Buffer> {
    const encode = options.encode || DEFAULT_SVGA_OPTIONS.encode;
    const quality = clamp(encode.quality || 80, 1, 100);

    if (format === "jpeg") {
      return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    if (format === "webp") {
      return pipeline.webp({ quality }).toBuffer();
    }
    const pngOptions: Record<string, unknown> = {
      compressionLevel: 9,
      effort: 10,
    };
    if (encode.palette) {
      pngOptions.palette = true;
      pngOptions.quality = quality;
    }
    return pipeline.png(pngOptions as any).toBuffer();
  }

  /**
   * 逐张处理内嵌纹理：缩放尺寸 + 按策略重编码。
   *
   * 两个关键保护：
   * 1. 若尺寸与格式都没变、而重编码结果反而更大，则保留原图，避免“越压越大”。
   * 2. 含透明的图不会转成 JPEG。
   */
  private async processTextures(
    movieEntity: SvgaParsed.MovieEntity,
    options: SvgaCompressOptions,
    flag = "svgaCompress"
  ) {
    const sharp = await this.getSharp();
    const images = movieEntity.images || {};
    const next: Record<string, Buffer> = {};
    let textureScaleSum = 0;
    let textureCount = 0;
    let keptOriginal = 0;
    let unreadable = 0;

    for (const [key, raw] of Object.entries(images)) {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      let meta: import("sharp").Metadata;
      try {
        meta = await sharp(buffer).metadata();
      } catch (e) {
        // 单张图读不出来就原样保留，绝不让一张坏图把整个压缩带崩
        next[key] = buffer;
        unreadable++;
        logger.warn(
          flag,
          `       图 ${key} 读取元信息失败，保留原图：${e instanceof Error ? e.message : String(e)}`
        );
        continue;
      }

      const originWidth = meta.width || 0;
      const originHeight = meta.height || 0;
      if (!originWidth || !originHeight) {
        next[key] = buffer;
        unreadable++;
        logger.warn(flag, `       图 ${key} 元信息缺尺寸（${originWidth}x${originHeight}），保留原图`);
        continue;
      }

      const scale = this.resolveTextureScale(originWidth, originHeight, options);
      const targetWidth = Math.max(1, Math.round(originWidth * scale));
      const targetHeight = Math.max(1, Math.round(originHeight * scale));
      const needsResize = targetWidth !== originWidth || targetHeight !== originHeight;

      const originFormat = (meta.format || "").toLowerCase();
      const targetFormat = this.resolveTargetFormat(meta, options);
      const needsFormatChange = targetFormat !== originFormat;

      let out: Buffer;
      let note = "";
      if (!needsResize && !needsFormatChange) {
        // 尺寸与格式都不变，只需重编码；若压缩无效则保留原图
        try {
          const encoded = await this.encodeTexture(sharp(buffer), targetFormat, options);
          if (encoded.length < buffer.length) {
            out = encoded;
          } else {
            out = buffer;
            note = "重编码反而更大，保留原图";
          }
        } catch (e) {
          out = buffer;
          note = `重编码失败保留原图：${e instanceof Error ? e.message : String(e)}`;
        }
      } else {
        let pipeline = sharp(buffer);
        if (needsResize) {
          pipeline = pipeline.resize(targetWidth, targetHeight, { fit: "fill" });
        }
        try {
          out = await this.encodeTexture(pipeline, targetFormat, options);
        } catch (e) {
          out = buffer;
          note = `重编码失败保留原图：${e instanceof Error ? e.message : String(e)}`;
        }
      }
      if (out === buffer) keptOriginal++;

      next[key] = out;
      // 逐张记账：哪张缩了、格式换没换、字节怎么变的。
      // 排查「体积/内存没降下来」时，答案通常就藏在某一张没被处理的图上。
      logger.debug(
        flag,
        `       图 ${key}: ${originWidth}x${originHeight} ${originFormat || "?"} ${formatBytes(buffer.length)}` +
          ` → ${targetWidth}x${targetHeight} ${targetFormat} ${formatBytes(out.length)}${note ? `  [${note}]` : ""}`
      );

      textureScaleSum += scale;
      textureCount++;
    }

    movieEntity.images = next;
    if (keptOriginal || unreadable) {
      logger.debug(flag, `       小结：保留原图 ${keptOriginal} 张，元信息读取失败 ${unreadable} 张`);
    }
    return {
      appliedScale: textureCount ? textureScaleSum / textureCount : 1,
      textureCount,
    };
  }

  // ---------------------------------------------------------------- 主流程

  /**
   * 压缩 SVGA。
   *
   * @param fsPath 源文件
   * @param destinationFsPath 输出文件
   * @param options 压缩参数，缺省表示只做无损重编码
   */
  public async compress(
    fsPath: string,
    destinationFsPath: string,
    options: SvgaCompressOptions = DEFAULT_SVGA_OPTIONS,
    logTag = ""
  ): Promise<SvgaCompressResult> {
    const flag = logFlag(logTag);
    const tStart = Date.now();
    try {
      logger.info(flag, `解析 ${fsPath}`);

      // 0) 解析源文件
      const tParse = Date.now();
      const { movieEntity } = await this.parse(fsPath);
      const stat = await fs.stat(fsPath);
      const params = movieEntity.params || ({} as SvgaParsed.MovieParams);
      logger.info(
        flag,
        `解析完成 ${Date.now() - tParse}ms：源文件 ${formatBytes(stat.size)}，` +
          `viewBox ${params.viewBoxWidth || 0}x${params.viewBoxHeight || 0}，` +
          `fps ${params.fps || 0}，frames ${params.frames || 0}，版本 ${movieEntity.version || "?"}`
      );
      logger.info(flag, `生效参数 ${JSON.stringify(options)}`);

      // 源文件真实存在的图片 key，提前留一份：后面 processTextures / 回收都会重写 images，
      // 校验时拿它来把“本来就指向不到位图的引用槽”（.vector 之类）排除在底线之外。
      const sourceImageKeys = Object.keys(movieEntity.images || {});

      const before = {
        size: stat.size,
        fps: params.fps || 0,
        frames: params.frames || 0,
        viewBoxWidth: params.viewBoxWidth || 0,
        viewBoxHeight: params.viewBoxHeight || 0,
        memory: this.analyzeMemory(movieEntity),
      };
      const originTextureCount = before.memory.textureCount;

      // 资源盘点：先把「多少图 / 多少 sprite / 有没有闲置图」记下来。
      // 后面任何一步数字对不上，都能回到这里看初始值。
      const orphanBefore = this.analyzeOrphans(movieEntity);
      logger.info(
        flag,
        `资源盘点：内嵌图 ${sourceImageKeys.length} 张，sprite ${movieEntity.sprites?.length || 0} 个，` +
          `被引用 key ${this.collectReferencedImageKeys(movieEntity).size} 个，` +
          `闲置图 ${orphanBefore.keys.length} 张(${formatBytes(orphanBefore.bytes)})` +
          `${orphanBefore.trusted ? "" : "，引用解析异常→统计不可信"}`
      );
      logger.info(
        flag,
        `内存基准 ${formatBytes(before.memory.totalBytes)}（${before.memory.textureCount} 张纹理 × 宽 × 高 × 4 字节，与文件体积无关）`
      );

      // 1) 纹理缩放与重编码
      const t1 = Date.now();
      const textureStat = await this.processTextures(movieEntity, options, flag);
      logger.info(
        flag,
        `[1/5] 纹理重编码 ${Date.now() - t1}ms：处理 ${textureStat.textureCount} 张，平均缩放 ${textureStat.appliedScale.toFixed(3)}`
      );

      // 2) 画布与布局缩放
      const t2 = Date.now();
      const canvasScale = options.canvas?.enabled ? clamp(options.canvas.ratio, 0.05, 1) : 1;
      this.applyCanvasScale(movieEntity, canvasScale);
      logger.info(
        flag,
        `[2/5] 画布缩放 ${Date.now() - t2}ms：` +
          (canvasScale === 1
            ? "未启用"
            : `比例 ${canvasScale} → viewBox ${movieEntity.params?.viewBoxWidth}x${movieEntity.params?.viewBoxHeight}` +
              "（viewBox / layout / transform / 图形坐标 / 描边宽度已同步）")
      );

      // 3) 抽帧与帧率调整
      const t3 = Date.now();
      const applied = this.planTransform(movieEntity, options);
      this.applyFrameStep(movieEntity, applied.frames);
      if (movieEntity.params) {
        movieEntity.params.fps = applied.fps;
      }
      logger.info(
        flag,
        `[3/5] 抽帧 ${Date.now() - t3}ms：fps ${applied.originFps} → ${applied.fps}，` +
          `帧 ${applied.originFrames} → ${applied.frames}` +
          (applied.frameStep > 1 ? `（平均每 ${applied.frameStep} 帧取 1，首尾帧对齐，末帧已保留）` : "（未抽帧）") +
          `，时长 ${applied.duration}s`
      );
      if (applied.frameStep > 1 && Math.abs(applied.duration - (applied.originFps > 0 ? applied.originFrames / applied.originFps : 0)) > 0.15) {
        logger.warn(
          flag,
          `      注意：目标帧率取整后帧数无法整除，时长与原始略有偏差（原 ${round2(
            applied.originFrames / applied.originFps
          )}s → ${applied.duration}s）`
        );
      }

      // 4) 回收无引用纹理。
      // 放在抽帧之后、写盘之前：此时 images 已是最终要写盘的那批数据。
      // 注意抽帧不是孤儿纹理的成因（见 reclaimUnusedTextures 注释），
      // 这一步回收的是文件里本来就闲置的图片。
      // 关闭时也照做一次统计，好让界面能区分“本来就没闲置图”和“有闲置图但没开回收”。
      const t4 = Date.now();
      let reclaim: SvgaReclaimReport;
      if (options.reclaim?.enabled) {
        reclaim = this.reclaimUnusedTextures(movieEntity);
      } else {
        const orphan = this.analyzeOrphans(movieEntity);
        reclaim = {
          enabled: false,
          reclaimedKeys: [],
          reclaimedCount: 0,
          reclaimedBytes: 0,
          keptCount: Object.keys(movieEntity.images || {}).length,
          orphanCount: orphan.trusted ? orphan.keys.length : 0,
        };
      }
      logger.info(
        flag,
        `[4/5] 回收无引用纹理 ${Date.now() - t4}ms：` +
          (reclaim.enabled
            ? `已删 ${reclaim.reclaimedCount} 张(${formatBytes(reclaim.reclaimedBytes)})，保留 ${reclaim.keptCount} 张`
            : `未开启；检测到闲置 ${reclaim.orphanCount} 张，保留 ${reclaim.keptCount} 张`)
      );
      if (reclaim.reclaimedKeys.length) {
        logger.info(flag, `       被删除的图：${reclaim.reclaimedKeys.join(", ")}`);
      }

      // 5) 打包写盘
      const t5 = Date.now();
      const expectedImageKeys = Object.keys(movieEntity.images || {});
      const file = this.encode(movieEntity);
      await fs.writeFile(destinationFsPath, file);
      logger.info(flag, `[5/5] 编码写盘 ${Date.now() - t5}ms：产物 ${formatBytes(file.length)} → ${destinationFsPath}`);

      const after = {
        size: file.length,
        fps: movieEntity.params?.fps || 0,
        frames: movieEntity.params?.frames || 0,
        viewBoxWidth: movieEntity.params?.viewBoxWidth || 0,
        viewBoxHeight: movieEntity.params?.viewBoxHeight || 0,
        memory: this.analyzeMemory(movieEntity),
      };

      // 自我保护：产物无法解码时直接抛错，避免覆盖原文件造成损失
      const t6 = Date.now();
      const validation = await this.validateOutput(destinationFsPath, {
        originTextureCount,
        allowTextureReduction: reclaim.enabled,
        sourceImageKeys,
        expectedImageKeys,
      });
      if (!validation.ok) {
        logger.error(flag, `校验未通过 ${Date.now() - t6}ms：${validation.reason}（产物已生成但不会被采用）`);
        throw new Error(`压缩结果校验未通过：${validation.reason}`);
      }
      logger.info(
        flag,
        `校验通过 ${Date.now() - t6}ms：图片集合对账 ${expectedImageKeys.length} 张一致，` +
          `sprite 引用 ${this.collectReferencedImageKeys(movieEntity).size} 个 key 无丢失`
      );

      const delta = before.size ? (((before.size - after.size) / before.size) * 100).toFixed(1) : "0";
      logger.info(
        flag,
        `完成 ${path.basename(fsPath)}：体积 ${formatBytes(before.size)} → ${formatBytes(after.size)}（-${delta}%），` +
          `内存 ${formatBytes(before.memory.totalBytes)} → ${formatBytes(after.memory.totalBytes)}，总耗时 ${Date.now() - tStart}ms`
      );

      return {
        destination: destinationFsPath,
        before,
        after,
        applied,
        reclaim,
      };
    } catch (e) {
      // 带上栈：压缩失败时最想知道的不是「失败了」，而是「死在哪一行」
      logger.error(
        flag,
        `压缩失败（${Date.now() - tStart}ms）${path.basename(fsPath)}：${e instanceof Error ? e.stack || e.message : String(e)}`
      );
      throw e;
    }
  }

  /**
   * 校验压缩产物是否可用，覆盖原文件前必须通过。
   *
   * 检查项：能否正常解码、动画参数/帧数据是否存在、图片集合是否符合预期。
   *
   * 关于“有引用的纹理不能丢”这条底线，判定口径是
   *   `collectReferencedImageKeys(产物) ∩ 源文件 images` ⊆ `产物 images`
   * 也就是：**源文件里本来就能解析到位图的引用，产物里必须一张不少**。
   *
   * 不能写成“所有引用都必须存在于 images”——SVGA 里 sprite.imageKey 允许指向一个
   * 不存在于 images 的“槽位名”（既用于运行时 setImage 动态贴图，也是 AE 导出矢量图层
   * 时的产物，如 `形状图层1.vector`）。播放器查不到位图会静默跳过，动画仍然正常
   * （见 SVGAPlayer-Flutter/lib/painter.dart: drawBitmap 里 bitmap == null 直接 return），
   * 所以这类条目是合法的，加严会把好文件全部拦下。
   *
   * `originTextureCount` 这条“纹理数量不得减少”的规则，只在未开启回收时才成立。
   * 开启回收后纹理本来就会变少，但那是有意为之，因此用 `allowTextureReduction` 放行。
   */
  public async validateOutput(
    fsPath: string,
    options: {
      originTextureCount?: number;
      allowTextureReduction?: boolean;
      /** 源文件里真实存在的图片 key；用于把“本来就指向不到位图的引用槽”排除在底线之外 */
      sourceImageKeys?: Iterable<string>;
      /** 期望产物里存在的图片 key；给出时按集合精确对账，最能抓住多删/少写 */
      expectedImageKeys?: Iterable<string>;
    } = {}
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      const { movieEntity } = await this.parse(fsPath);
      if (!movieEntity?.params) return { ok: false, reason: "缺少动画参数" };
      if (!movieEntity.images || !Object.keys(movieEntity.images).length) {
        return { ok: false, reason: "内嵌图片缺失" };
      }
      if (!Array.isArray(movieEntity.sprites) || !movieEntity.sprites.length) {
        return { ok: false, reason: "动画帧数据缺失" };
      }

      const present = new Set(Object.keys(movieEntity.images));
      const summarize = (keys: string[]) =>
        `${keys.slice(0, 3).join("、")}${keys.length > 3 ? ` 等 ${keys.length} 张` : ""}`;

      // 1) 与预期集合精确对账（调用方最清楚产物该有哪些图）
      if (options.expectedImageKeys) {
        const expected = new Set(options.expectedImageKeys);
        const lost = [...expected].filter((key) => !present.has(key));
        const extra = [...present].filter((key) => !expected.has(key));
        if (lost.length || extra.length) {
          const parts: string[] = [];
          if (lost.length) parts.push(`缺少 ${summarize(lost)}`);
          if (extra.length) parts.push(`多出 ${summarize(extra)}`);
          return { ok: false, reason: `产物图片集合与预期不符（${parts.join("；")}）` };
        }
      }

      // 2) 底线：源文件里本来能落地成位图的引用，产物里一张都不能少
      if (options.sourceImageKeys) {
        const sourceImages = new Set(options.sourceImageKeys);
        const referenced = this.collectReferencedImageKeys(movieEntity);
        const lost = [...referenced].filter((key) => sourceImages.has(key) && !present.has(key));
        if (lost.length) {
          return { ok: false, reason: `原有纹理被误删（${summarize(lost)}）` };
        }
      }

      const { originTextureCount, allowTextureReduction } = options;
      if (!allowTextureReduction && typeof originTextureCount === "number" && originTextureCount > 0) {
        const current = Object.keys(movieEntity.images).length;
        if (current < originTextureCount) {
          return { ok: false, reason: `纹理数量减少（${originTextureCount} → ${current}）` };
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
}

export default new SvgaUtility();
