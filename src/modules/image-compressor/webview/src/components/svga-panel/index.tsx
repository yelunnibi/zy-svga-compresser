import type { ReactNode } from "react";
import type { SvgaCompressOptions } from "@typing";

/** 参数项标签：明确标出这一项到底能治哪个指标 */
function EffectTag(props: { size?: boolean; memory?: boolean }) {
  const { size, memory } = props;
  if (!size && !memory) return null;
  return (
    <span className="inline-flex gap-[3px] ml-[5px] align-middle">
      {size && (
        <span className="text-[10px] leading-[14px] px-[3px] rounded-[2px] bg-[#26402f] text-emerald-400">体积</span>
      )}
      {memory && (
        <span className="text-[10px] leading-[14px] px-[3px] rounded-[2px] bg-[#2b3a4d] text-sky-400">内存</span>
      )}
    </span>
  );
}

function SectionTitle(props: { children: ReactNode }) {
  return <div className="text-[11px] text-[#8a8a8a] mt-[12px] mb-[5px] first:mt-0">{props.children}</div>;
}

function Switch(props: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const { checked, onChange, disabled } = props;
  return (
    <div
      className={`w-[26px] h-[15px] rounded-full flex-shrink-0 relative cursor-pointer transition-colors ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
      style={{ background: checked ? "#0e639c" : "#5a5a5a" }}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span
        className="w-[11px] h-[11px] rounded-full bg-white absolute top-[2px] transition-all"
        style={{ left: checked ? "13px" : "2px" }}
      ></span>
    </div>
  );
}

function Row(props: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-[6px] text-[12px] text-[#d4d4d4] mb-[6px]">
      <span className="flex items-center min-w-0">{props.label}</span>
      <div className="flex-1"></div>
      {props.children}
    </div>
  );
}

const numberInputCls =
  "w-[52px] bg-[#2b2b2b] border-[1px] border-solid border-[#5a5a5a] rounded-[3px] text-[12px] text-white px-[5px] py-[2px] outline-none focus:border-[#0e639c]";

const radioDotCls = (active: boolean) =>
  `w-[11px] h-[11px] rounded-full border-[1px] border-solid flex-shrink-0 inline-block ${
    active ? "border-[4px] border-[#0e639c]" : "border-[#5a5a5a]"
  }`;

/** 计算丢帧后的实际 fps：抽帧只能按整数倍，实际值常与目标值不同 */
export function computeActualFps(originFps: number, targetFps: number, keepDuration: boolean): number {
  if (!originFps || !targetFps || targetFps >= originFps) return originFps;
  if (!keepDuration) return targetFps;
  const step = Math.max(1, Math.round(originFps / targetFps));
  return Math.round((originFps / step) * 100) / 100;
}

export interface SvgaPanelProps {
  options: SvgaCompressOptions;
  scope: "global" | "file";
  hasFile: boolean;
  selectedCount: number;
  originFps?: number;
  originFrames?: number;
  disabled?: boolean;
  onScopeChange: (scope: "global" | "file") => void;
  onChange: (patch: Partial<SvgaCompressOptions>) => void;
  onApplyToSelected: () => void;
  onResetFile?: () => void;
}

export default function SvgaPanel(props: SvgaPanelProps) {
  const { options, scope, hasFile, selectedCount, originFps = 0, originFrames = 0, disabled, onScopeChange, onChange, onApplyToSelected, onResetFile } = props;
  const { fps, texture, canvas, encode } = options;

  const actualFps = computeActualFps(originFps, fps.target, fps.keepDuration);
  const fpsActive = fps.enabled && fps.target > 0 && originFps > 0 && fps.target < originFps;
  const step = fpsActive && fps.keepDuration ? Math.max(1, Math.round(originFps / fps.target)) : 1;
  const actualFrames = step > 1 ? Math.ceil(originFrames / step) : originFrames;
  const duration = actualFps > 0 ? Math.round((actualFrames / actualFps) * 10) / 10 : 0;

  return (
    <div className={`h-full overflow-auto px-[12px] py-[10px] bg-[#2b2b2b] ${disabled ? "opacity-60 pointer-events-none" : ""}`}>
      <div className="flex items-center mb-[10px]">
        <span className="text-[12px] font-semibold text-white">SVGA 参数</span>
      </div>

      {/* 作用域 */}
      <div className="flex gap-[4px] mb-[10px]">
        {(["global", "file"] as const).map((item) => (
          <button
            key={item}
            className={`flex-1 text-[11px] py-[3px] rounded-[4px] border-[1px] border-solid cursor-pointer ${
              scope === item ? "bg-[#0e639c] border-[#0e639c] text-white" : "bg-transparent border-[#5a5a5a] text-[#b5b5b5]"
            } ${item === "file" && !hasFile ? "opacity-40 cursor-not-allowed" : ""}`}
            disabled={item === "file" && !hasFile}
            onClick={() => onScopeChange(item)}
          >
            {item === "global" ? "全局默认" : "仅当前文件"}
          </button>
        ))}
      </div>

      {/* 帧率 */}
      <SectionTitle>
        帧率
        <EffectTag size />
      </SectionTitle>
      <Row label="目标 fps">
        <input
          type="number"
          className={numberInputCls}
          value={fps.target || ""}
          min={1}
          max={120}
          placeholder={originFps ? String(originFps) : "-"}
          onChange={(e) => {
            const value = Number(e.target.value);
            onChange({ fps: { ...fps, target: Number.isFinite(value) ? value : 0, enabled: value > 0 } });
          }}
        />
        {originFps > 0 && <span className="text-[11px] text-[#7a7a7a]">原 {originFps}</span>}
      </Row>
      <Row label={<span>保持原时长</span>}>
        <Switch checked={fps.keepDuration} onChange={(v) => onChange({ fps: { ...fps, keepDuration: v } })} />
      </Row>
      <div className="text-[10px] text-[#7a7a7a] leading-[1.6] mb-[6px]">
        {fps.keepDuration
          ? "开：抽掉多余帧，时长不变，体积真降（动画略卡）"
          : "关：只改 fps 数值，动画变快/变慢，体积几乎不变"}
      </div>
      {fpsActive && (
        <div className="text-[10px] text-sky-400 leading-[1.6] mb-[6px]">
          {fps.keepDuration
            ? `实际生效 ${actualFps} fps · 帧数 ${originFrames} → ${actualFrames} · 时长 ${duration}s`
            : `实际生效 ${fps.target} fps · 帧数不变 · 时长变为 ${duration}s`}
        </div>
      )}

      {/* 纹理分辨率 */}
      <SectionTitle>
        纹理分辨率
        <EffectTag size memory />
      </SectionTitle>
      <div
        className="flex items-center gap-[6px] text-[12px] text-[#d4d4d4] mb-[6px] cursor-pointer"
        onClick={() => onChange({ texture: { ...texture, mode: "none" } })}
      >
        <span className={radioDotCls(texture.mode === "none")}></span>
        <span>不缩放</span>
      </div>
      <div
        className="flex items-center gap-[6px] text-[12px] text-[#d4d4d4] mb-[4px] cursor-pointer"
        onClick={() => onChange({ texture: { ...texture, mode: "ratio", ratio: texture.ratio < 1 ? texture.ratio : 0.8 } })}
      >
        <span className={radioDotCls(texture.mode === "ratio")}></span>
        <span>等比缩放</span>
        <div className="flex-1"></div>
        <span className="text-white font-semibold">{Math.round(texture.ratio * 100)}%</span>
      </div>
      {texture.mode === "ratio" && (
        <input
          type="range"
          min={10}
          max={100}
          value={Math.round(texture.ratio * 100)}
          className="w-full mb-[6px]"
          onChange={(e) => onChange({ texture: { ...texture, ratio: Number(e.target.value) / 100 } })}
        />
      )}
      <div
        className="flex items-center gap-[6px] text-[12px] text-[#d4d4d4] mb-[4px] cursor-pointer"
        onClick={() => onChange({ texture: { ...texture, mode: "maxEdge", maxEdge: texture.maxEdge > 0 ? texture.maxEdge : 512 } })}
      >
        <span className={radioDotCls(texture.mode === "maxEdge")}></span>
        <span>最长边不超过</span>
        <div className="flex-1"></div>
        <input
          type="number"
          className={numberInputCls}
          value={texture.maxEdge || ""}
          min={16}
          placeholder="512"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const value = Number(e.target.value);
            onChange({ texture: { ...texture, mode: "maxEdge", maxEdge: Number.isFinite(value) ? value : 0 } });
          }}
        />
        <span className="text-[11px] text-[#7a7a7a]">px</span>
      </div>
      <div className="text-[10px] text-[#7a7a7a] leading-[1.6] mb-[6px]">只有缩放分辨率才能降低解码内存</div>

      {/* 画布与布局 */}
      <SectionTitle>
        画布与布局
        <EffectTag size memory />
      </SectionTitle>
      <Row label={<span>同步缩放布局坐标</span>}>
        <Switch checked={canvas.enabled} onChange={(v) => onChange({ canvas: { ...canvas, enabled: v } })} />
      </Row>
      {canvas.enabled && (
        <>
          <Row label="画布比例">
            <span className="text-white font-semibold">{Math.round(canvas.ratio * 100)}%</span>
          </Row>
          <input
            type="range"
            min={10}
            max={100}
            value={Math.round(canvas.ratio * 100)}
            className="w-full mb-[6px]"
            onChange={(e) => onChange({ canvas: { ...canvas, ratio: Number(e.target.value) / 100 } })}
          />
        </>
      )}
      <div className="text-[10px] text-amber-400 leading-[1.6] mb-[6px]">会改变播放尺寸，前端需要同步调整</div>

      {/* 图片编码 */}
      <SectionTitle>
        图片编码
        <EffectTag size />
      </SectionTitle>
      <Row label={<span>保持原格式</span>}>
        <Switch checked={encode.keepFormat} onChange={(v) => onChange({ encode: { ...encode, keepFormat: v } })} />
      </Row>
      {!encode.keepFormat && (
        <div className="flex gap-[4px] mb-[6px]">
          {(["png", "jpeg", "webp"] as const).map((format) => (
            <button
              key={format}
              className={`flex-1 text-[11px] py-[2px] rounded-[3px] border-[1px] border-solid cursor-pointer uppercase ${
                encode.format === format ? "bg-[#0e639c] border-[#0e639c] text-white" : "bg-transparent border-[#5a5a5a] text-[#b5b5b5]"
              }`}
              onClick={() => onChange({ encode: { ...encode, format } })}
            >
              {format}
            </button>
          ))}
        </div>
      )}
      <Row label="编码质量">
        <span className="text-white font-semibold">{encode.quality}</span>
      </Row>
      <input
        type="range"
        min={1}
        max={100}
        value={encode.quality}
        className="w-full mb-[6px]"
        onChange={(e) => onChange({ encode: { ...encode, quality: Number(e.target.value) } })}
      />
      <Row label={<span>PNG 调色板量化</span>}>
        <Switch checked={encode.palette} onChange={(v) => onChange({ encode: { ...encode, palette: v } })} disabled={!encode.keepFormat && encode.format !== "png"} />
      </Row>
      <div className="text-[10px] text-[#7a7a7a] leading-[1.6] mb-[12px]">调质量只压体积，不降内存</div>

      <button
        className="w-full text-[11px] py-[5px] rounded-[4px] border-[1px] border-solid border-[#0e639c] bg-[#0e639c] text-white cursor-pointer hover:bg-[#1177bb] disabled:opacity-40 disabled:cursor-not-allowed"
        disabled={!selectedCount}
        onClick={onApplyToSelected}
      >
        {selectedCount ? `应用到选中 ${selectedCount} 个文件` : "先勾选文件"}
      </button>
      {scope === "file" && onResetFile && (
        <button
          className="w-full text-[11px] py-[4px] mt-[6px] rounded-[4px] border-[1px] border-solid border-[#5a5a5a] bg-transparent text-[#b5b5b5] cursor-pointer hover:bg-[#3d3d3d]"
          onClick={onResetFile}
        >
          恢复为全局参数
        </button>
      )}
    </div>
  );
}
