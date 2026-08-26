import { useEffect, useRef } from "react";
import { applyEasing, drawTransitionPair } from "../player/useCompositor";
import type { TransitionType, InterpolationType } from "../../types/project";

/**
 * TransitionSample renders a small, looping, animated preview of one
 * transition type by compositing two synthetic demo clips (an outgoing
 * "A" clip and an incoming "B" clip) through the exact same drawing
 * routine the live preview compositor uses (drawTransitionPair from
 * useCompositor.ts). Because the sample reuses the production drawing
 * function rather than approximating it, what you see here is precisely
 * what the transition will look like once applied and played back.
 *
 * The animation loops forward (0 -> 1) then backwards (1 -> 0) so small
 * preview tiles read clearly as a continuous motion without any hard
 * "jump" back to the start.
 */
interface TransitionSampleProps {
  type: TransitionType;
  direction?: string;      // meaningful for wipe/slide/push
  easing?: InterpolationType;
  width?: number;
  height?: number;
  className?: string;
}

const CYCLE_S = 3.2; // full forward+backward loop duration

// Fixed demo frame size for the "A"/"B" artwork canvases; the sample
// tile scales this down via containRect exactly like real video would be.
const FRAME_W = 240;
const FRAME_H = 150;

/** Paints one synthetic "clip" artwork used as a transition source. */
function paintClipCanvas(
  canvas: HTMLCanvasElement,
  label: string,
  c1: [number, number, number],
  c2: [number, number, number]
) {
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Diagonal gradient background.
  const g = ctx.createLinearGradient(0, 0, FRAME_W, FRAME_H);
  g.addColorStop(0, `rgb(${c1.join(",")})`);
  g.addColorStop(1, `rgb(${c2.join(",")})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);

  // A few soft "landscape" bands to give motion a reference.
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.moveTo(0, FRAME_H * 0.62);
  ctx.lineTo(FRAME_W * 0.3, FRAME_H * 0.45);
  ctx.lineTo(FRAME_W * 0.65, FRAME_H * 0.66);
  ctx.lineTo(FRAME_W, FRAME_H * 0.5);
  ctx.lineTo(FRAME_W, FRAME_H);
  ctx.lineTo(0, FRAME_H);
  ctx.closePath();
  ctx.fill();

  // Bold letter marker (A or B).
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "bold 64px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, FRAME_W / 2, FRAME_H / 2 - 6);

  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, FRAME_W - 8, FRAME_H - 8);
}

export function TransitionSample({ type, easing = "linear", direction = "left", width = 200, height = 120, className }: TransitionSampleProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const outCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const inCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Build the demo artwork once.
  useEffect(() => {
    const out = outCanvasRef.current ?? document.createElement("canvas");
    const inn = inCanvasRef.current ?? document.createElement("canvas");
    paintClipCanvas(out, "A", [45, 90, 220], [110, 50, 190]); // blue -> purple (outgoing)
    paintClipCanvas(inn, "B", [20, 160, 140], [230, 120, 60]); // teal -> orange (incoming)
    outCanvasRef.current = out;
    inCanvasRef.current = inn;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const out = outCanvasRef.current;
    const inn = inCanvasRef.current;
    if (!canvas || !out || !inn) return;

    const draw = (now: number) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Reset the 2d transform to identity each frame.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Map elapsed time onto a forward -> hold -> backward cycle.
      const t = (now / 1000) % CYCLE_S;
      const half = CYCLE_S / 2;
      const progress = t < half ? t / half : 1 - (t - half) / half;

      drawTransitionPair(
        ctx,
        { source: out, srcW: out.width, srcH: out.height, filter: "none", baseAlpha: 1 },
        { source: inn, srcW: inn.width, srcH: inn.height, filter: "none", baseAlpha: 1 },
        applyEasing(progress, easing),
        type,
        direction,
        canvas.width,
        canvas.height
      );

      rafHandle = requestAnimationFrame(draw);
    };

    let rafHandle = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafHandle);
  }, [type, easing, direction]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={className}
      style={{ width, height, borderRadius: 8, background: "#000" }}
    />
  );
}