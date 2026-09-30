import type { ReactNode } from "react";
import type { DecodeMemoryInfo, MemoryRisk, WorkspaceNode } from "@typing";
import { MEMORY_RISK_META, calcReducedPercent, formatBytes, formatMemory } from "@utils";

/**
 * 右侧「动画信息」面板。
 *
 * 只回答两个问题：这个动画是什么，以及播放它要多少内存。
 *
 * 「解码内存」单独做成一块，是因为它是本插件唯一真正的性能指标，
 * 别的行都是它的解释。这块只给两个数字：原文件 → 压缩后，
 * 不再叠加阈值标尺、风险话术和「降到 X MB 以内」这类与文件本身无关的提示。
 *
 * 「画布尺寸」与「纹理尺寸」拆成两行是刻意的：这是两个完全不同的量，混在一行必然被误读。
 *
 *   画布尺寸（viewBox）= 动画的「舞台坐标系」，所有 sprite 按这个坐标摆放。
 *     它本身**不占任何维度上的内存**——内存只算纹理像素，见下。
 *
 *   纹理尺寸 = 图片池里图片的真实像素宽高，**这是解码内存的唯一来源**
 *     （解码内存 = Σ 宽 × 高 × 4 字节）。
 *
 *   ⚠️ 判「超采样」的对照物**不是画布**，而是「实际显示尺寸」
 *     （= 帧的 layout 尺寸 × transform 缩放，见播放器 painter.dart）。
 *     画布只说明舞台多大，不代表某个元素被画了多大；用画布当基数是常见误读。
 * * ⚠️ 注意：本插件里开「画布缩放」会**连带等比缩纹理**（见 utils/svga.ts 的
 * `resolveTextureScale`：`scale *= canvas.ratio`），所以它确实会降内存。
 * 不要写成「缩画布不省内存」——那是概念上的错觉，不是本实现的行为。
 * 之所以要让纹理跟着缩，是为了避免「画布缩了、纹理没缩」这种白占内存的组合。
 */

function KV(props: { k: string; children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-[6px] leading-[1.85]">
      <span className="text-[#8a8a8a] flex-shrink-0">• {props.k}：</span>
      <span className="text-[#d4d4d4] min-w-0 break-all">{props.children}</span>
    </li>
  );
}

/** 前后对照：压缩前 → 压缩后 */
function Pair(props: { before: ReactNode; after?: ReactNode; note?: string; delta?: number }) {
  const { before, after, note, delta } = props;
  return (
    <>
      <span>{before}</span>
      {after !== undefined && (
        <>
          <span className="mx-[5px] text-[#7a7a7a]">→</span>
          <span className="text-white font-semibold">{after}</span>
        </>
      )}
      {note ? <span className="ml-[6px] text-[#9d9d9d] text-[11px]">{note}</span> : null}
      {delta !== undefined && delta !== 0 && (
        <span className="ml-[6px] font-semibold text-[#4ade80]">−{Math.abs(delta)}%</span>
      )}
    </>
  );
}

export interface AnimationInfoProps {
  file: WorkspaceNode | null;
}

export default function AnimationInfo(props: AnimationInfoProps) {
  const { file } = props;

  if (!file) {
    return (
      <div className="h-full flex items-center justify-center px-[16px] text-center text-[11px] text-[#7a7a7a] leading-[1.8]">
        在左侧选择一个文件
        <br />
        选择 .svga 后可查看解码内存
      </div>
    );
  }

  const dims = file.dimensions || ({} as WorkspaceNode["dimensions"]);
  const plan = file.appliedPlan;
  const rawMem: DecodeMemoryInfo | undefined = file.memory;
  const optMem: DecodeMemoryInfo | undefined = file.optimizedMemory;

  const sizeDelta = file.optimizedSize ? calcReducedPercent(file.size, file.optimizedSize) : undefined;

  /* 帧率 / 帧数 / 时长 */
  const framesBefore = dims.frames || 0;
  const fpsBefore = dims.fps || 0;
  const durBefore = fpsBefore > 0 ? Math.round((framesBefore / fpsBefore) * 100) / 100 : 0;
  const framesAfter = plan?.frames ?? framesBefore;
  const fpsAfter = plan?.fps ?? fpsBefore;
  const durAfter = plan?.duration ?? durBefore;
  const step = plan?.frameStep ?? 1;
  const durChanged = Math.abs(durAfter - durBefore) > 0.15;

  /* 纹理尺寸：取面积最大的那张作为代表 */
  const texScale = plan && plan.textureScale > 0 ? plan.textureScale : 1;
  const texW = rawMem?.maxTexture?.width || dims.width || 0;
  const texH = rawMem?.maxTexture?.height || dims.height || 0;
  const texWAfter = Math.max(1, Math.round(texW * texScale));
  const texHAfter = Math.max(1, Math.round(texH * texScale));

  /* 内存：有压缩结果时以压缩后为准 */
  const memCurrent = optMem || rawMem;
  const memColor = memCurrent ? MEMORY_RISK_META[memCurrent.risk as MemoryRisk]?.bar : undefined;

  /**
   * 图像资源那一行的注解。
   *
   * 这段文字是这一行里唯一会被误读的地方，所以按“到底发生了什么”分开写：
   *   开了回收且删到了  → 说清删了几张
   *   开了回收但没删到  → 这个文件本来就没有闲置图片
   *   没开回收但还有闲置 → 告诉用户还能省多少（可执行）
   *   没开回收也没闲置   → 别吓唬用户，这文件本来就干净
   */
  const reclaimNote = (() => {
    if (!optMem || !rawMem) return undefined;
    const report = file.reclaimReport;
    if (report?.enabled) {
      return report.reclaimedCount > 0 ? `已回收 ${report.reclaimedCount} 张孤儿纹理` : "无孤儿纹理";
    }
    const orphans = report?.orphanCount ?? 0;
    if (orphans > 0) return `还有 ${orphans} 张闲置图片未回收`;
    return "无孤儿纹理";
  })();

  return (
    <div className="h-full overflow-auto px-[12px] py-[10px] bg-[#2b2b2b]">
      <div className="text-[12px] font-semibold text-white mb-[8px]">动画信息</div>

      <ul className="text-[12px]">
        {dims.version && <KV k="SVGA 版本">{dims.version}</KV>}
        <KV k="文件名">{file.name || file.title}</KV>

        <KV k="文件大小">
          <Pair before={formatBytes(file.size || 0)} after={file.optimizedSize ? formatBytes(file.optimizedSize) : undefined} delta={sizeDelta} />
        </KV>

        <KV k="画布尺寸">
          {dims.viewBoxWidth || dims.width || 0} × {dims.viewBoxHeight || dims.height || 0}
        </KV>

        <KV k="纹理尺寸">
          {texW > 0 ? (
            <Pair
              before={`${texW} × ${texH}`}
              after={texScale < 1 ? `${texWAfter} × ${texHAfter}` : undefined}
              note={texScale < 1 ? undefined : "未缩放"}
            />
          ) : (
            "—"
          )}
        </KV>

        {framesBefore > 0 && (
          <>
            <KV k="总帧数（frames）">
              <Pair
                before={framesBefore}
                after={framesAfter !== framesBefore ? framesAfter : undefined}
                note={step > 1 ? `每 ${Math.round(step * 100) / 100} 帧取 1` : "未抽帧"}
              />
            </KV>
            <KV k="帧率（FPS）">
              <Pair
                before={fpsBefore}
                after={fpsAfter !== fpsBefore ? fpsAfter : undefined}
                note={fpsAfter === fpsBefore ? "未变" : plan?.frameStep && plan.frameStep > 1 ? "丢帧保时长" : "改速"}
              />
            </KV>
            <KV k="时长">
              <Pair
                before={`${durBefore} 秒`}
                after={durChanged ? `${durAfter} 秒` : undefined}
                note={durChanged ? (durAfter > durBefore ? "变长" : "变短") : "基本不变"}
              />
            </KV>
          </>
        )}

        {rawMem && (
          <KV k="图像资源">
            <Pair
              before={`${rawMem.textureCount} 个`}
              after={optMem ? `${optMem.textureCount} 个` : undefined}
              note={reclaimNote}
            />
          </KV>
        )}
      </ul>

      {/* 解码内存：本插件唯一真正的性能指标，单独给一块，只对比前后两个数 */}
      {rawMem && (
        <div className="mt-[10px] rounded-[6px] border-[1px] border-solid border-[#4a4a4a] bg-[#333333] px-[10px] py-[9px]">
          <div className="flex items-baseline gap-[6px] text-[11px] text-[#8a8a8a]">
            <span>解码内存</span>
            {optMem && <span className="ml-auto">压缩后</span>}
          </div>

          <div className="flex items-baseline gap-[7px] mt-[6px]">
            {optMem ? (
              <>
                <span className="text-[13px] font-mono text-[#9d9d9d]">{formatMemory(rawMem!.totalBytes)}</span>
                <span className="text-[13px] text-[#7a7a7a]">→</span>
                <span className="text-[24px] leading-none font-semibold" style={{ color: memColor }}>
                  {formatMemory(optMem.totalBytes)}
                </span>
              </>
            ) : (
              <span className="text-[24px] leading-none font-semibold" style={{ color: memColor }}>
                {formatMemory(rawMem!.totalBytes)}
              </span>
            )}
          </div>

          <div className="mt-[6px] text-[10.5px] text-[#7a7a7a]">
            播放时内嵌图按 RGBA 常驻内存，共 {memCurrent.textureCount} 张
          </div>
        </div>
      )}

      {/* 已应用参数回显：压完不看参数，等于不知道压了什么 */}
      {plan && (
        <div className="mt-[10px] text-[10.5px] text-[#9d9d9d] leading-[1.8] border-t-[1px] border-solid border-[#414141] pt-[8px]">
          <div className="text-[#b5b5b5]">
            已应用：
            {[
              plan.frameStep > 1 ? `fps ${plan.originFps} → ${plan.fps}（丢帧保时长）` : plan.fps !== plan.originFps ? `fps ${plan.originFps} → ${plan.fps}（改速）` : null,
              plan.textureScale < 1 ? `纹理 ${Math.round(plan.textureScale * 100)}%` : null,
              plan.canvasScale < 1 ? `画布 ${Math.round(plan.canvasScale * 100)}%` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "仅重编码，未改帧率与尺寸"}
          </div>
          <div>
            帧数 {plan.originFrames} → {plan.frames} · 画布 {plan.viewBoxWidth}×{plan.viewBoxHeight} · 时长 {plan.duration}s
          </div>
        </div>
      )}
    </div>
  );
}
