import type { ReactNode } from "react";
import type { SvgaCompressOptions } from "@typing";
import { computeActualFps } from "@components/svga-panel";

/**
 * 顶部横向参数条。
 *
 * 与原右侧纵向面板的区别不只是方向：横条把「帧率 / 纹理 / 画布 / 编码」四组并排，
 * 每组自带一行说明，参数改动后能立刻看到对体积与内存的影响，
 * 不必在参数和结果之间来回切视线。
 */

function EffectTag(props: { size?: boolean; memory?: boolean }) {
  const { size, memory } = props;
  if (!size && !memory) return null;
  return (
    <span className="inline-flex gap-[3px] ml-[4px] align-middle">
      {size && <span className="text-[10px] leading-[14px] px-[3px] rounded-[2px] bg-[#26402f] text-emerald-400">体积</span>}
      {memory && <span className="text-[10px] leading-[14px] px-[3px] rounded-[2px] bg-[#2b3a4d] text-sky-400">内存</span>}
    </span>
  );
}

function Switch(props: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const { checked, onChange, disabled } = props;
  return (
    <div
      className={`w-[26px] h-[15px] rounded-full flex-shrink-0 relative transition-colors ${
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
      }`}
      style={{ background: checked && !disabled ? "#0e639c" : "#5a5a5a" }}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span
        className="w-[11px] h-[11px] rounded-full bg-white absolute top-[2px] transition-all"
        style={{ left: checked ? "13px" : "2px" }}
      ></span>
    </div>
  );
}

/** 参数条分组：一行标题 + 一行控件 + 可选一行说明 */
function Group(props: { label: ReactNode; children: ReactNode; hint?: ReactNode; wide?: boolean }) {
  const { label, children, hint, wide } = props;
  return (
    <div className={`flex flex-col gap-[5px] flex-shrink-0 ${wide ? "min-w-[250px]" : ""}`}>
      <div className="flex items-center text-[11px] leading-[14px] text-[#8a8a8a] h-[14px] whitespace-nowrap">{label}</div>
      <div className="flex items-center gap-[7px] min-h-[22px]">{children}</div>
      {hint ? <div className="text-[10px] leading-[13px] text-[#7a7a7a] whitespace-nowrap">{hint}</div> : null}
    </div>
  );
}

function Divider() {
  return <div className="w-[1px] self-stretch bg-[#4a4a4a] my-[2px] flex-shrink-0"></div>;
}

function Seg<T extends string>(props: {
  value: T;
  items: Array<{ v: T; t: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const { value, items, onChange, disabled } = props;
  return (
    <div className={`flex rounded-[3px] overflow-hidden border-[1px] border-solid border-[#5a5a5a] ${disabled ? "opacity-40" : ""}`}>
      {items.map((item) => (
        <button
          key={item.v}
          className={`text-[11px] leading-[18px] px-[7px] border-none ${
            value === item.v ? "bg-[#0e639c] text-white" : "bg-transparent text-[#b5b5b5] hover:bg-[#3d3d3d]"
          } ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
          disabled={disabled}
          onClick={() => !disabled && onChange(item.v)}
        >
          {item.t}
        </button>
      ))}
    </div>
  );
}

function Slider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  width?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const { value, min, max, step = 1, width = 96, disabled, onChange } = props;
  return (
    <input
      type="range"
      className={`h-[16px] ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
      style={{ width, accentColor: "#0e639c" }}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

const numberInputCls =
  "w-[54px] bg-[#2b2b2b] border-[1px] border-solid border-[#5a5a5a] rounded-[3px] text-[11px] text-white px-[5px] py-[2px] outline-none focus:border-[#0e639c]";
const valCls = "text-[12px] text-white font-semibold tabular-nums";
const dimTxtCls = "text-[11px] text-[#7a7a7a]";

export interface CompressBarProps {
  options: SvgaCompressOptions;
  scope: "global" | "file";
  selectedCount: number;
  /** 源文件帧率，决定 fps 滑块上限 */
  originFps: number;
  originFrames: number;
  onScopeChange: (scope: "global" | "file") => void;
  onChange: (patch: Partial<SvgaCompressOptions>) => void;
  onApplyToSelected: () => void;
  onResetFile: () => void;
}

export default function CompressBar(props: CompressBarProps) {
  const {
    options,
    scope,
    selectedCount,
    originFps,
    originFrames,
    onScopeChange,
    onChange,
    onApplyToSelected,
    onResetFile,
  } = props;
  const { fps, texture, canvas, encode, reclaim } = options;

  // 目标 fps 缺省时给一个「源帧率的一半」，避免刚打开开关时滑块停在 0
  const defaultTarget = originFps > 1 ? Math.max(1, Math.floor(originFps / 2)) : 0;
  const fpsTarget = fps.target > 0 ? fps.target : defaultTarget;
  const actualFps = computeActualFps(originFps, fpsTarget, fps.keepDuration);
  const frameStep = fps.keepDuration && actualFps > 0 ? Math.max(1, Math.round(originFps / actualFps)) : 1;
  const actualFrames = frameStep > 1 ? Math.ceil(originFrames / frameStep) : originFrames;
  const duration = actualFps > 0 ? Math.round((actualFrames / actualFps) * 10) / 10 : 0;
  const fpsActive = fps.enabled && fpsTarget > 0 && originFps > 0 && fpsTarget < originFps;

  const texturePct = Math.round((texture.mode === "ratio" ? texture.ratio : 1) * 100);
  const maxEdgeValue = texture.maxEdge > 0 ? texture.maxEdge : 512;

  return (
    <div className="flex-shrink-0 border-b-[1px] border-solid border-[#414141] bg-[#2b2b2b]">
      {/* 顶行：作用域与批量动作 */}
      <div className="flex items-center gap-[10px] px-[12px] h-[30px] border-b-[1px] border-solid border-[#383838]">
        <span className="text-[11px] text-[#8a8a8a] whitespace-nowrap">参数作用域</span>
        <Seg
          value={scope}
          items={[
            { v: "global", t: "全局默认" },
            { v: "file", t: "仅当前文件" },
          ]}
          onChange={onScopeChange}
        />
        <div className="flex-1"></div>
        {scope === "file" && (
          <button
            className="text-[11px] px-[8px] py-[2px] rounded-[3px] border-[1px] border-solid border-[#5a5a5a] bg-transparent text-[#b5b5b5] cursor-pointer hover:bg-[#3d3d3d]"
            onClick={onResetFile}
          >
            恢复为全局参数
          </button>
        )}
        <button
          className="text-[11px] px-[9px] py-[2px] rounded-[3px] border-[1px] border-solid border-[#0e639c] bg-[#0e639c] text-white cursor-pointer hover:bg-[#1177bb] disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={!selectedCount}
          onClick={onApplyToSelected}
        >
          {selectedCount ? `应用到选中 ${selectedCount} 个` : "先勾选文件"}
        </button>
      </div>

      {/* 参数区：四组并排，窗口变窄时自动换行 */}
      <div className="flex flex-wrap items-start gap-x-[16px] gap-y-[8px] px-[12px] py-[9px]">
        {/* 帧率 */}
        <Group
          label={
            <>
              帧率
              <EffectTag size />
            </>
          }
          wide
          hint={
            fpsActive
              ? fps.keepDuration
                ? `实际 ${actualFps} fps · 帧 ${originFrames} → ${actualFrames} · 时长 ${duration}s 不变`
                : `只改数值 · 帧数不变 · 时长变 ${duration}s`
              : "关：不动帧，体积几乎不变"
          }
        >
          <Switch
            checked={fps.enabled}
            onChange={(v) => onChange({ fps: { ...fps, enabled: v, target: v && fps.target <= 0 ? defaultTarget : fps.target } })}
          />
          <Slider
            value={Math.min(fpsTarget, originFps || 60)}
            min={1}
            max={originFps || 60}
            width={92}
            disabled={!fps.enabled || !originFps}
            onChange={(v) => onChange({ fps: { ...fps, target: v, enabled: true } })}
          />
          <span className={valCls}>{fpsTarget || "-"}</span>
          <span className={dimTxtCls}>fps{originFps ? ` / 原 ${originFps}` : ""}</span>
          <Seg
            value={fps.keepDuration ? "keep" : "speed"}
            items={[
              { v: "keep", t: "丢帧保时长" },
              { v: "speed", t: "改速" },
            ]}
            onChange={(v) => onChange({ fps: { ...fps, keepDuration: v === "keep" } })}
            disabled={!fps.enabled}
          />
        </Group>

        <Divider />

        {/* 无引用纹理回收 */}
        <Group
          label={
            <>
              无引用纹理
              <EffectTag size memory />
            </>
          }
          hint={reclaim.enabled ? "删掉没被任何 sprite 引用的图" : "关：闲置图片会一直占解码内存"}
        >
          <Switch checked={reclaim.enabled} onChange={(v) => onChange({ reclaim: { enabled: v } })} />
          <span className={dimTxtCls}>回收无引用纹理</span>
        </Group>

        <Divider />

        {/* 纹理分辨率 */}
        <Group
          label={
            <>
              纹理分辨率
              <EffectTag size memory />
            </>
          }
          wide
          hint={
            texture.mode === "none"
              ? "唯一能降低解码内存的参数"
              : `面积降至约 ${Math.round((texture.mode === "ratio" ? texture.ratio : 1) ** 2 * 100)}%，内存同比例下降`
          }
        >
          <Seg
            value={texture.mode}
            items={[
              { v: "none", t: "不缩放" },
              { v: "ratio", t: "按比例" },
              { v: "maxEdge", t: "限最长边" },
            ]}
            onChange={(v) =>
              onChange({
                texture: {
                  ...texture,
                  mode: v,
                  ratio: v === "ratio" && texture.ratio >= 1 ? 0.8 : texture.ratio,
                  maxEdge: v === "maxEdge" && texture.maxEdge <= 0 ? 512 : texture.maxEdge,
                },
              })
            }
          />
          {texture.mode === "ratio" && (
            <>
              <Slider
                value={Math.round(texture.ratio * 100)}
                min={10}
                max={100}
                width={86}
                onChange={(v) => onChange({ texture: { ...texture, ratio: v / 100 } })}
              />
              <span className={valCls}>{texturePct}%</span>
            </>
          )}
          {texture.mode === "maxEdge" && (
            <>
              <input
                type="number"
                className={numberInputCls}
                value={maxEdgeValue}
                min={16}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onChange({ texture: { ...texture, maxEdge: Number.isFinite(v) ? v : 0 } });
                }}
              />
              <span className={dimTxtCls}>px</span>
            </>
          )}
        </Group>

        <Divider />

        {/* 画布 */}
        <Group
          label={
            <>
              画布与布局
              <EffectTag size />
            </>
          }
          hint={canvas.enabled ? "会改变播放尺寸，前端需同步调整" : "关闭：播放尺寸与原文件一致"}
        >
          <Switch checked={canvas.enabled} onChange={(v) => onChange({ canvas: { ...canvas, enabled: v } })} />
          <Slider
            value={Math.round(canvas.ratio * 100)}
            min={10}
            max={100}
            width={86}
            disabled={!canvas.enabled}
            onChange={(v) => onChange({ canvas: { ...canvas, ratio: v / 100 } })}
          />
          <span className={valCls}>{Math.round(canvas.ratio * 100)}%</span>
        </Group>

        <Divider />

        {/* 编码 */}
        <Group
          label={
            <>
              图片编码
              <EffectTag size />
            </>
          }
          hint={encode.keepFormat ? "保持原格式，避免二次压缩损失" : "转码只压体积，不降内存"}
        >
          <Switch checked={encode.keepFormat} onChange={(v) => onChange({ encode: { ...encode, keepFormat: v } })} />
          <span className={dimTxtCls}>保持原格式</span>
          <Seg
            value={encode.format}
            items={[
              { v: "png", t: "PNG" },
              { v: "jpeg", t: "JPEG" },
              { v: "webp", t: "WebP" },
            ]}
            onChange={(v) => onChange({ encode: { ...encode, format: v } })}
            disabled={encode.keepFormat}
          />
          <Slider
            value={encode.quality}
            min={1}
            max={100}
            width={70}
            disabled={encode.keepFormat}
            onChange={(v) => onChange({ encode: { ...encode, quality: v } })}
          />
          <span className={valCls}>{encode.quality}</span>
          <Seg
            value={encode.palette ? "on" : "off"}
            items={[
              { v: "on", t: "调色板" },
              { v: "off", t: "不量化" },
            ]}
            onChange={(v) => onChange({ encode: { ...encode, palette: v === "on" } })}
            disabled={!encode.keepFormat && encode.format !== "png"}
          />
        </Group>
      </div>
    </div>
  );
}
