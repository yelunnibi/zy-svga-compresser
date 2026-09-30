import { Tooltip } from "antd";
import type { DecodeMemoryInfo, MemoryAdvice, MemoryRisk, SvgaAppliedPlan } from "@typing";
import { MEMORY_RISK_META, calcReducedPercent, formatFileSize, formatMemory, memoryRiskPosition } from "@utils";

/* ------------------------------------------------------------------ 体积/内存对照 */

interface SizeCompareRowProps {
  label: string;
  before: string;
  after?: string;
  percent?: number;
  emphasize?: boolean;
  riskColor?: string;
  tip?: string;
}

function SizeCompareRow(props: SizeCompareRowProps) {
  const { label, before, after, percent, emphasize, riskColor, tip } = props;
  const row = (
    <div
      className={`flex items-center px-[10px] py-[7px] text-[12px] ${emphasize ? "bg-[#3a3427]" : "bg-[#333333]"}`}
      style={emphasize && riskColor ? { background: `${riskColor}1f` } : undefined}
    >
      <span className={`w-[58px] flex-shrink-0 ${emphasize && riskColor ? "" : "text-[#9d9d9d]"}`} style={emphasize && riskColor ? { color: riskColor } : undefined}>
        {label}
      </span>
      <span className={emphasize && riskColor ? "" : "text-[#d4d4d4]"} style={emphasize && riskColor ? { color: riskColor } : undefined}>
        {before}
      </span>
      {after !== undefined && (
        <>
          <span className="mx-[6px] text-[#7a7a7a]">→</span>
          <span className={`font-semibold ${emphasize && riskColor ? "" : "text-white"}`} style={emphasize && riskColor ? { color: riskColor } : undefined}>
            {after}
          </span>
          {percent !== undefined && percent !== 0 && (
            <span className={`ml-auto font-semibold ${percent > 0 ? "text-emerald-400" : "text-red-400"}`}>
              {percent > 0 ? "−" : "+"}
              {Math.abs(percent)}%
            </span>
          )}
        </>
      )}
    </div>
  );
  return tip ? (
    <Tooltip title={tip} placement="left">
      {row}
    </Tooltip>
  ) : (
    row
  );
}

export interface SizeComparePanelProps {
  beforeSize: number;
  afterSize?: number;
  beforeMemory?: DecodeMemoryInfo;
  afterMemory?: DecodeMemoryInfo;
}

/**
 * 体积与解码内存的并排对照。
 *
 * 两项刻意放在同一张表里：体积降了并不代表内存降了，
 * 并排才能一眼看出"这次压缩到底治好了哪个指标"。
 */
export function SizeComparePanel(props: SizeComparePanelProps) {
  const { beforeSize, afterSize, beforeMemory, afterMemory } = props;
  const hasAfterSize = typeof afterSize === "number" && afterSize > 0;
  const hasMemory = Boolean(beforeMemory);

  return (
    <div className="rounded-[6px] overflow-hidden border-[1px] border-solid border-[#4a4a4a] divide-y-[1px] divide-solid divide-[#4a4a4a]">
      <SizeCompareRow
        label="文件体积"
        before={formatFileSize(beforeSize)}
        after={hasAfterSize ? formatFileSize(afterSize) : undefined}
        percent={hasAfterSize ? calcReducedPercent(beforeSize, afterSize) : undefined}
      />
      {hasMemory && (
        <SizeCompareRow
          label="解码内存"
          before={formatMemory(beforeMemory.totalBytes)}
          after={afterMemory ? formatMemory(afterMemory.totalBytes) : undefined}
          percent={afterMemory ? calcReducedPercent(beforeMemory.totalBytes, afterMemory.totalBytes) : undefined}
          emphasize
          riskColor={MEMORY_RISK_META[beforeMemory.risk].bar}
          tip="播放时全部内嵌图会被解码成 RGBA 位图常驻内存，每像素 4 字节"
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 内存风险卡片 */

export interface MemoryCardProps {
  memory?: DecodeMemoryInfo;
  optimizedMemory?: DecodeMemoryInfo;
  threshold: { safe: number; danger: number };
  budget: number;
  advice?: MemoryAdvice | null;
  adviceLoading?: boolean;
  onRequestAdvice?: () => void;
  onApplyAdvice?: () => void;
}

/** 解码内存风险卡片：大数字 + 阈值标尺 + 纹理构成 + 可执行建议 */
export function MemoryCard(props: MemoryCardProps) {
  const { memory, optimizedMemory, threshold, budget, advice, adviceLoading, onRequestAdvice, onApplyAdvice } = props;
  if (!memory) return null;

  // 有压缩结果时以压缩后的内存作为当前结论
  const current = optimizedMemory || memory;
  const meta = MEMORY_RISK_META[current.risk as MemoryRisk];
  const position = memoryRiskPosition(current.totalBytes, threshold.safe, threshold.danger);
  const safe = threshold.safe || 1;
  const danger = threshold.danger > safe ? threshold.danger : safe * 2.6;
  const max = danger * 2.2;
  const safeWidth = (safe / max) * 100;
  const cautionWidth = ((danger - safe) / max) * 100;

  const maxTexture = current.maxTexture;

  return (
    <div className="rounded-[6px] border-[1px] border-solid border-[#4a4a4a] bg-[#333333] px-[12px] py-[10px]">
      <div className="flex items-center gap-[7px]">
        <span className="w-[8px] h-[8px] rounded-full inline-block" style={{ background: meta.bar }}></span>
        <span className={`text-[12px] font-medium ${meta.color}`}>{meta.label}</span>
        {optimizedMemory && (
          <span className="ml-auto text-[11px] text-[#8a8a8a]">压缩后</span>
        )}
      </div>

      <div className="flex items-baseline gap-[6px] mt-[6px]">
        <span className={`text-[24px] leading-none font-semibold ${meta.color}`}>{formatMemory(current.totalBytes)}</span>
        {optimizedMemory && (
          <span className="text-[11px] text-[#8a8a8a]">原 {formatMemory(memory.totalBytes)}</span>
        )}
      </div>

      <div className="mt-[8px] h-[4px] rounded-[2px] overflow-hidden flex relative" style={{ background: "#4a4a4a" }}>
        <div style={{ width: `${safeWidth}%`, background: "#4ade80" }}></div>
        <div style={{ width: `${cautionWidth}%`, background: "#fbbf24" }}></div>
        <div style={{ flex: 1, background: "#f87171" }}></div>
        <div
          className="absolute top-[-2px] w-[2px] h-[8px] bg-white rounded-[1px]"
          style={{ left: `calc(${position}% - 1px)` }}
        ></div>
      </div>
      <div className="flex justify-between text-[11px] text-[#7a7a7a] mt-[4px]">
        <span>{Math.round(safe / 1024 / 1024)} MB</span>
        <span>{Math.round(danger / 1024 / 1024)} MB</span>
      </div>

      <div className="mt-[10px] pt-[9px] border-t-[1px] border-solid border-[#4a4a4a] text-[11px] text-[#b5b5b5] leading-[1.7]">
        <div>
          {current.textureCount} 张纹理
          {maxTexture && maxTexture.width > 0 && (
            <span>
              {" · "}最大 {maxTexture.width}×{maxTexture.height}
            </span>
          )}
        </div>
        {maxTexture && maxTexture.bytes > 0 && <div>单张最大占用 {formatMemory(maxTexture.bytes)}</div>}
        <div className="text-[#8a8a8a]">{meta.hint}</div>
      </div>

      {advice ? (
        <div className="mt-[10px] rounded-[6px] bg-[#2b2b2b] px-[9px] py-[7px] text-[11px] leading-[1.6]">
          <div className="text-[#d4d4d4]">{advice.message}</div>
          {advice.available && onApplyAdvice && (
            <button
              className="mt-[6px] w-full text-[11px] py-[4px] rounded-[4px] cursor-pointer border-[1px] border-solid border-[#5a5a5a] bg-[#3d3d3d] text-white hover:bg-[#4a4a4a]"
              onClick={onApplyAdvice}
            >
              按此建议重压（纹理 {Math.round(advice.suggestedTextureRatio * 100)}%）
            </button>
          )}
        </div>
      ) : (
        onRequestAdvice && (
          <button
            className="mt-[10px] w-full text-[11px] py-[4px] rounded-[4px] cursor-pointer border-[1px] border-solid border-[#5a5a5a] bg-transparent text-[#d4d4d4] hover:bg-[#3d3d3d] disabled:opacity-50"
            disabled={adviceLoading}
            onClick={onRequestAdvice}
          >
            {adviceLoading ? "计算中..." : `想让内存降到 ${Math.round(budget / 1024 / 1024)} MB 以内？`}
          </button>
        )
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 已应用参数回显 */

export interface AppliedPlanPanelProps {
  plan?: SvgaAppliedPlan;
}

/** 回显本次实际生效的参数，避免"压完了不知道用了什么" */
export function AppliedPlanPanel(props: AppliedPlanPanelProps) {
  const { plan } = props;
  if (!plan) return null;

  const parts: string[] = [];
  if (plan.frameStep > 1) {
    parts.push(`fps ${plan.originFps} → ${plan.fps}（丢帧保时长）`);
  } else if (plan.fps !== plan.originFps) {
    parts.push(`fps ${plan.originFps} → ${plan.fps}（改速）`);
  }
  if (plan.textureScale < 1) {
    parts.push(`纹理 ${Math.round(plan.textureScale * 100)}%`);
  }
  if (plan.canvasScale < 1) {
    parts.push(`画布 ${Math.round(plan.canvasScale * 100)}%`);
  }

  return (
    <div className="text-[11px] text-[#9d9d9d] leading-[1.8]">
      <div>{parts.length ? `已应用：${parts.join(" · ")}` : "已应用：仅重编码，未改尺寸与帧率"}</div>
      <div>
        帧数 {plan.originFrames} → {plan.frames} · 画布 {plan.viewBoxWidth}×{plan.viewBoxHeight} · 时长 {plan.duration}s
      </div>
    </div>
  );
}
