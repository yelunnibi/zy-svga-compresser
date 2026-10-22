import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import SVGA from "svgaplayerweb";
import type { WorkspaceNode } from "@typing";
import { formatBytes } from "@utils";
import logger from "@extension/utils/logger.ts";

/**
 * 预览：上格原图、下格压缩图，同屏上下对比。
 *
 * 为什么不用「原图 / 压缩后」分段切换：对比要看的是同一个画面在两套参数下的差别，
 * 来回切换会丢失参照；上下并排，视线不用移动就能看出差异。
 *
 * 播放采用自驱动时间轴（requestAnimationFrame + stepToFrame），而不是让两个播放器
 * 各自 startAnimation。原因是两个文件的帧率与帧数并不相同（这正是压缩的结果），
 * 各自播放必然不同步；由同一条时间轴换算各自的帧号，画面对应关系才成立。
 */

const CHECKER_BG = {
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
  backgroundImage:
    "linear-gradient(45deg, rgb(20, 20, 20) 25%, transparent 25%, transparent 75%, rgb(20, 20, 20) 75%, rgb(20, 20, 20)), linear-gradient(45deg, rgb(20, 20, 20) 25%, transparent 25%, transparent 75%, rgb(20, 20, 20) 75%, rgb(20, 20, 20))",
} as const;

interface MediaClock {
  frames: number;
  fps: number;
  /** 总时长（秒） */
  duration: number;
}

/** 单格媒体的加载状态 */
type MediaState = "loading" | "ready" | "error";

/** 加载中 / 加载失败的覆盖提示 */
function StageOverlay(props: { state: MediaState; hint?: string }) {
  const { state, hint } = props;
  if (state === "ready") return null;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-[6px] px-[16px] text-center text-[11px] text-[#7a7a7a]">
      {state === "loading" ? (
        <>
          <span className="w-[14px] h-[14px] rounded-full border-2 border-[#3a3a3a] border-t-[#8a8a8a] animate-spin"></span>
          <span>正在解析 SVGA…</span>
        </>
      ) : (
        <span>{hint || "预览加载失败（文件可能已被移动或格式异常）"}</span>
      )}
    </div>
  );
}

/**
 * 兼容 svgaplayerweb 的渲染缺陷，消除「压缩后图形错位」的预览误报。
 *
 * 该播放器的 Renderer.drawSprite 有两条画图分支：
 *   ① src 是字符串（base64 / URL）  → ctx.drawImage(img, 0, 0, layout.width, layout.height)，按 layout 拉伸 ✅
 *   ② src 是 <img> 对象（解码缓存命中）→ ctx.drawImage(img, 0, 0)，按图片原始像素绘制，完全无视 layout ❌
 *
 * prepare() 会把每一张内嵌 base64 图都解码成 <img> 存进 _bitmapCache，所以实际永远走 ②。
 * 原始 SVGA 的纹理像素恰好等于 layout（导出器的约定），两条分支结果一致，因此这个坑一直没暴露；
 * 但本插件会把纹理像素缩小（如 304x376 → 243x301），② 就会把整张位图按 80% 画出来，
 * 而矢量图层走 shape 分支、不受影响地停在原位 —— 预览里看着就像「机器人眼睛跑到了身体上」。
 * Android / iOS / Flutter 播放器都是按 layout 拉伸，**压缩产物本身没有任何问题**。
 *
 * 做法：把图片塞进优先级最高的 _dynamicImage，并补上 `data:` 前缀（否则裸 base64 又会落回 ②），
 * 强制播放器走 ①，让预览与真机渲染一致。
 */
interface LayoutAwarePlayer {
  setImage(url: string, forKey: string): void;
  _renderer?: { _bitmapCache?: Record<string, HTMLImageElement & { _svgaSrc?: string }> };
}

function forceLayoutAwareImages(player: SVGA.Player, item: SVGA.VideoEntity) {
  const images = (item as unknown as { images?: Record<string, unknown> })?.images;
  if (!images) return;
  const p = player as unknown as LayoutAwarePlayer;
  const cache = p._renderer?._bitmapCache;
  Object.keys(images).forEach((key) => {
    const value = images[key];
    if (typeof value !== "string" || value.startsWith("data:")) return;
    const url = value.startsWith("iVBO")
      ? `data:image/png;base64,${value}`
      : value.startsWith("/9j/2w")
      ? `data:image/jpeg;base64,${value}`
      : null;
    if (!url) return;
    const bitmapKey = key.replace(/\.matte$/, "");
    // 让 .matte 键复用已解码的位图，避免换分支后重新异步加载
    if (cache && cache[bitmapKey] && !cache[key]) cache[key] = cache[bitmapKey];
    // 预置 _svgaSrc，避免播放器对同一个 data URL 再赋一次 src 触发重解码
    const img = cache?.[bitmapKey];
    if (img) img._svgaSrc = url;
    p.setImage(url, bitmapKey);
  });
}

export interface PreviewStackProps {
  file: WorkspaceNode | null;
  /** 本次参数下是否已有压缩结果 */
  hasResult: boolean;
  /** 已有结果但参数又改了 */
  stale: boolean;
  compressing: boolean;
  onCompress: () => void;
}

export default function PreviewStack(props: PreviewStackProps) {
  const { file, hasResult, stale, compressing, onCompress } = props;

  const isSvga = Boolean(file && file.parsedInfo?.ext === ".svga");
  const rawSrc = file?.sourceWebviewUri || "";
  const optSrc = file?.optimizedWebviewUri || "";
  const dims = file?.dimensions;
  const plan = file?.appliedPlan;

  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [t, setT] = useState(0);

  /** 各格加载状态：解析失败时必须给明确提示，否则用户只看到一片空白 */
  const [mediaStatus, setMediaStatus] = useState<{ raw: MediaState; opt: MediaState }>({ raw: "loading", opt: "loading" });
  const markStatus = (slot: "raw" | "opt", state: MediaState) =>
    setMediaStatus((prev) => (prev[slot] === state ? prev : { ...prev, [slot]: state }));

  const rawHostRef = useRef<HTMLDivElement>(null);
  const optHostRef = useRef<HTMLDivElement>(null);
  const rawPlayerRef = useRef<SVGA.Player | null>(null);
  const optPlayerRef = useRef<SVGA.Player | null>(null);

  /** 已绘制帧号：帧号没变就不重绘，避免每帧都刷两个 canvas */
  const drawnRef = useRef({ raw: -1, opt: -1 });
  /** 播放器是否已装载 videoItem，未就绪时 stepToFrame 会出错 */
  const readyRef = useRef({ raw: false, opt: false });
  /** 当前播放位置（秒）。放 ref 里，避免 rAF 回调捕获旧值 */
  const tRef = useRef(0);

  /** 原图时钟：帧率与帧数来自源文件解析结果 */
  const rawClock: MediaClock = useMemo(() => {
    const frames = Math.max(1, dims?.frames || 1);
    const fps = dims?.fps && dims.fps > 0 ? dims.fps : 20;
    return { frames, fps, duration: frames / fps };
  }, [dims?.frames, dims?.fps]);

  /** 压缩图时钟：优先用本次实际生效的参数（丢帧后帧数会变） */
  const optClock: MediaClock = useMemo(() => {
    if (plan && plan.frames > 0) {
      const fps = plan.fps > 0 ? plan.fps : rawClock.fps;
      return { frames: Math.max(1, plan.frames), fps, duration: plan.duration > 0 ? plan.duration : plan.frames / fps };
    }
    return rawClock;
  }, [plan, rawClock]);

  /** 循环总时长取两条时间轴里较长的那条，保证两边都能播完 */
  const span = hasResult ? Math.max(rawClock.duration, optClock.duration) : rawClock.duration;

  // rAF 回调读这里，保证读到最新值
  const liveRef = useRef({ rawClock, optClock, span, hasResult, playing, loop });
  liveRef.current = { rawClock, optClock, span, hasResult, playing, loop };

  /* ---------------------------------------------------------- 播放器装载 */
  const mountPlayer = useCallback(
    (
      host: HTMLDivElement | null,
      src: string,
      slot: "raw" | "opt",
      playerRef: MutableRefObject<SVGA.Player | null>
    ) => {
      if (!host || !src) return () => {};
      let disposed = false;
      const player = new SVGA.Player(host);
      player.setContentMode("AspectFit");
      playerRef.current = player;
      readyRef.current[slot] = false;
      markStatus(slot, "loading");
      const parser = new SVGA.Parser();
      parser.load(
        src,
        (item) => {
          if (disposed) return;
          player.setVideoItem(item);
          // 必须在 setVideoItem（内部 prepare() 建好解码缓存）之后调用
          forceLayoutAwareImages(player, item);
          readyRef.current[slot] = true;
          drawnRef.current[slot] = -1;
          try {
            player.stepToFrame(0, false);
          } catch (e) {
            logger.error("preview.svga.step", e);
          }
          markStatus(slot, "ready");
        },
        (err) => {
          logger.error("preview.svga.load", err);
          markStatus(slot, "error");
        }
      );
      return () => {
        disposed = true;
        readyRef.current[slot] = false;
        try {
          player.clear();
        } catch (e) {
          logger.error("preview.svga.clear", e);
        }
        if (playerRef.current === player) playerRef.current = null;
      };
    },
    []
  );

  useEffect(() => {
    if (!isSvga) return;
    drawnRef.current = { raw: -1, opt: -1 };
    return mountPlayer(rawHostRef.current, rawSrc, "raw", rawPlayerRef);
  }, [isSvga, rawSrc, mountPlayer]);

  useEffect(() => {
    if (!isSvga) return;
    drawnRef.current.opt = -1;
    return mountPlayer(hasResult && optSrc ? optHostRef.current : null, hasResult ? optSrc : "", "opt", optPlayerRef);
  }, [isSvga, optSrc, hasResult, mountPlayer]);

  /* ---------------------------------------------------------- 时间轴驱动 */
  useEffect(() => {
    if (!isSvga) return;
    let raf = 0;
    let last = performance.now();

    const apply = (seconds: number) => {
      const { rawClock: rc, optClock: oc, hasResult: has } = liveRef.current;
      if (readyRef.current.raw) {
        const rawFrame = Math.min(rc.frames - 1, Math.floor(((seconds / rc.duration) % 1) * rc.frames));
        if (rawFrame !== drawnRef.current.raw) {
          drawnRef.current.raw = rawFrame;
          rawPlayerRef.current?.stepToFrame(rawFrame, false);
        }
      }
      if (has && readyRef.current.opt) {
        const optFrame = Math.min(oc.frames - 1, Math.floor(((seconds / oc.duration) % 1) * oc.frames));
        if (optFrame !== drawnRef.current.opt) {
          drawnRef.current.opt = optFrame;
          optPlayerRef.current?.stepToFrame(optFrame, false);
        }
      }
    };

    const tick = (now: number) => {
      const dt = Math.min(now - last, 120); // 窗口切回来时不要跳一大步
      last = now;
      const { playing: p, loop: lp, span: T } = liveRef.current;

      if (p && T > 0) {
        let next = tRef.current + dt / 1000;
        if (next >= T) {
          if (lp) {
            next = next % T;
          } else {
            next = T;
            setPlaying(false);
          }
        }
        tRef.current = next;
        setT(next);
      }
      apply(tRef.current);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isSvga, rawSrc, optSrc, hasResult]);

  // 切换文件后从头播
  useEffect(() => {
    tRef.current = 0;
    setT(0);
    drawnRef.current = { raw: -1, opt: -1 };
  }, [rawSrc]);

  // 出现压缩结果后把画面拉回起点，保证两格从同一帧开始对比
  useEffect(() => {
    if (!hasResult) return;
    tRef.current = 0;
    setT(0);
    drawnRef.current = { raw: -1, opt: -1 };
  }, [hasResult, optSrc]);

  const seek = (value: number) => {
    tRef.current = value;
    setT(value);
    setPlaying(false);
  };

  /* ---------------------------------------------------------- 渲染 */
  if (!file) {
    return <div className="flex-1 flex items-center justify-center text-[12px] text-[#7a7a7a]">在左侧选择一个图片文件</div>;
  }

  const optMeta = hasResult
    ? `${file.optimizedDimensions?.width || 0}×${file.optimizedDimensions?.height || 0} · ${formatBytes(file.optimizedSize || 0)}`
    : "—";

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* 头部：文件名 + 压缩状态徽标 */}
      <div className="flex-shrink-0 h-[30px] px-[12px] flex items-center gap-[8px] border-b-[1px] border-solid border-[#414141]">
        <span className="text-[12px] text-white font-semibold truncate">{file.name || file.title}</span>
        <div className="flex-1"></div>
        <span
          className={`text-[10.5px] leading-[16px] px-[7px] rounded-[9px] border-[1px] border-solid whitespace-nowrap ${
            compressing
              ? "text-sky-300 border-[#2f5f78] bg-[#122a35]"
              : stale
              ? "text-amber-300 border-[#6b5a2f] bg-[#302a14]"
              : hasResult
              ? "text-emerald-300 border-[#2f6b45] bg-[#14301f]"
              : "text-[#8a8a8a] border-[#5a5a5a] bg-transparent"
          }`}
        >
          {compressing ? "压缩中…" : stale ? "参数已变更" : hasResult ? "已压缩" : "未压缩"}
        </span>
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        {/* 上格：原图 */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-shrink-0 h-[22px] px-[12px] flex items-center gap-[7px]">
            <span className="text-[10px] font-semibold px-[6px] leading-[14px] rounded-[3px] bg-[#3a3a3a] text-[#c9c9c9]">原图</span>
            <div className="flex-1"></div>
            <span className="text-[10.5px] text-[#7a7a7a] font-mono truncate">
              {dims?.width || 0}×{dims?.height || 0}
              {isSvga ? ` · ${rawClock.fps} fps · ${rawClock.frames} 帧` : ""} · {formatBytes(file.size || 0)}
            </span>
          </div>
          <div className="flex-1 min-h-0 flex items-center justify-center px-[14px] pb-[8px]">
            {isSvga ? (
              <div className="relative w-full h-full">
                <div ref={rawHostRef} className="w-full h-full overflow-hidden rounded-[5px]" style={CHECKER_BG}></div>
                <StageOverlay state={mediaStatus.raw} />
              </div>
            ) : (
              <img src={rawSrc} alt="原图" className="max-w-full max-h-full object-contain rounded-[5px]" style={CHECKER_BG} />
            )}
          </div>
        </div>

        <div className="flex-shrink-0 h-[1px] bg-[#4a4a4a]"></div>

        {/* 下格：压缩图 */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-shrink-0 h-[22px] px-[12px] flex items-center gap-[7px]">
            <span
              className={`text-[10px] font-semibold px-[6px] leading-[14px] rounded-[3px] ${
                hasResult ? "bg-[#0e639c] text-white" : "bg-[#333] text-[#6f6f6f]"
              }`}
            >
              压缩后
            </span>
            <div className="flex-1"></div>
            <span className="text-[10.5px] text-[#7a7a7a] font-mono truncate">
              {hasResult ? `${optMeta}${isSvga ? ` · ${optClock.fps} fps · ${optClock.frames} 帧` : ""}` : "—"}
            </span>
          </div>
          <div className={`relative flex-1 min-h-0 flex items-center justify-center px-[14px] pb-[8px] ${stale ? "opacity-40" : ""}`}>
            {isSvga ? (
              hasResult && (
                <div className="relative w-full h-full">
                  <div ref={optHostRef} className="w-full h-full overflow-hidden rounded-[5px]" style={CHECKER_BG}></div>
                  <StageOverlay state={mediaStatus.opt} />
                </div>
              )
            ) : (
              hasResult && (
                <img src={optSrc} alt="压缩后" className="max-w-full max-h-full object-contain rounded-[5px]" style={CHECKER_BG} />
              )
            )}

            {!hasResult && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-[8px] text-[11.5px] text-[#7a7a7a]">
                {compressing ? (
                  <>
                    <span className="w-[16px] h-[16px] rounded-full border-2 border-[#2f5f78] border-t-sky-400 animate-spin"></span>
                    <span>正在压缩…</span>
                  </>
                ) : (
                  <>
                    <span className="text-[19px] opacity-50">⚡</span>
                    <span>还没有压缩结果，参数调好后点「压缩选中」</span>
                    <button
                      className="text-[11.5px] px-[11px] py-[3px] rounded-[4px] border-none bg-[#0e639c] text-white cursor-pointer hover:bg-[#1177bb]"
                      onClick={onCompress}
                    >
                      立即压缩
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 播放控制：静态图片没有时间轴 */}
      {isSvga && (
        <div className="flex-shrink-0 h-[34px] px-[12px] flex items-center gap-[10px] border-t-[1px] border-solid border-[#414141]">
          <button
            className="text-[12px] w-[26px] h-[20px] rounded-[3px] border-[1px] border-solid border-[#5a5a5a] bg-transparent text-[#d4d4d4] cursor-pointer hover:bg-[#3d3d3d]"
            onClick={() => setPlaying(!playing)}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            className={`text-[11px] px-[7px] h-[20px] rounded-[3px] border-[1px] border-solid cursor-pointer ${
              loop ? "border-[#0e639c] text-sky-300 bg-[#0d2b3d]" : "border-[#5a5a5a] text-[#b5b5b5] hover:bg-[#3d3d3d]"
            }`}
            onClick={() => setLoop(!loop)}
          >
            循环
          </button>
          <input
            type="range"
            className="flex-1 h-[16px] cursor-pointer"
            style={{ accentColor: "#0e639c" }}
            min={0}
            max={span}
            step={Math.max(span / 240, 0.001)}
            value={Math.min(t, span)}
            onChange={(e) => seek(Number(e.target.value))}
          />
          <span className="text-[11px] text-[#7a7a7a] font-mono tabular-nums whitespace-nowrap">
            {Math.min(t, span).toFixed(2)} / {span.toFixed(2)} s
          </span>
        </div>
      )}
    </div>
  );
}
