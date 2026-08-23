"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Reusable drawn-signature capture.
 *
 * A finger/mouse/stylus canvas that serialises to a PNG data-URL held in a
 * hidden <input>, so it drops straight into any plain server-action <form>
 * (public quote acceptance, H&S sign-off) with no client-side submit wiring.
 * The drawn signature is OPTIONAL by default, a blank pad submits an empty
 * value and the server keeps the typed-name record unchanged.
 *
 * Pointer Events cover mouse + touch + stylus with one code path; the canvas
 * is backed at devicePixelRatio for crisp strokes on retina/mobile.
 */
export function SignaturePad({
  name,
  label = "Draw your signature",
  hint,
  heightPx = 180,
}: {
  name: string;
  label?: string;
  hint?: string;
  heightPx?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);

  // Size the backing store to the CSS box × devicePixelRatio so strokes are
  // crisp and coordinates map 1:1. Re-runs on resize.
  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a"; // slate-900
  }, []);

  useEffect(() => {
    setup();
    window.addEventListener("resize", setup);
    return () => window.removeEventListener("resize", setup);
  }, [setup]);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const commit = useCallback(() => {
    const canvas = canvasRef.current;
    const input = inputRef.current;
    if (!canvas || !input) return;
    input.value = isEmpty ? "" : canvas.toDataURL("image/png");
  }, [isEmpty]);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pointFromEvent(e);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !last.current) return;
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (isEmpty) setIsEmpty(false);
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    // Write the latest bytes into the hidden input for form submit.
    const canvas = canvasRef.current;
    const input = inputRef.current;
    if (canvas && input) input.value = canvas.toDataURL("image/png");
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setIsEmpty(true);
    if (inputRef.current) inputRef.current.value = "";
  };

  // Keep the hidden input in sync whenever emptiness flips (e.g. after clear).
  useEffect(() => {
    commit();
  }, [commit]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-800">{label}</span>
        <button
          type="button"
          onClick={clear}
          className="text-xs font-medium text-slate-500 underline underline-offset-2 hover:text-slate-900"
        >
          Clear
        </button>
      </div>
      <div className="relative rounded-md border border-slate-300 bg-white">
        <canvas
          ref={canvasRef}
          style={{ height: heightPx, touchAction: "none" }}
          className="block w-full cursor-crosshair rounded-md"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
          aria-label={label}
          role="img"
        />
        {isEmpty ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-400">
            Sign here with your finger, stylus or mouse
          </span>
        ) : null}
      </div>
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
      <input ref={inputRef} type="hidden" name={name} defaultValue="" />
    </div>
  );
}
