"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser } from "lucide-react";

/**
 * A drawn signature.
 *
 * Pointer events rather than touch or mouse events, because the same code has to
 * work under a finger on a tablet, a stylus, and a mouse on the machine an
 * operator tests it with.
 *
 * The canvas is sized in CSS pixels but backed at devicePixelRatio, otherwise a
 * signature captured on a retina tablet is stored at half resolution and looks
 * like a fax of itself when a DPO opens it three years later as evidence.
 */
export function SignaturePad({
  canvasRef,
  onInkChange,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onInkChange: (hasInk: boolean) => void;
}) {
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    // White, not transparent: this is stored as a PNG and read back as evidence,
    // and a transparent signature is invisible on a dark background.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#14181f";
  }, [canvasRef]);

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    const { x, y } = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasInk) {
      setHasInk(true);
      onInkChange(true);
    }
  }

  function end() {
    drawing.current = false;
  }

  function clear() {
    resize();
    setHasInk(false);
    onInkChange(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        // touch-none stops the browser scrolling the page instead of drawing.
        className="h-48 w-full touch-none rounded-md border border-line bg-white"
        aria-label="Signature area"
      />
      <button
        type="button"
        onClick={clear}
        className="inline-flex min-h-11 w-fit items-center gap-2 rounded-md border border-line px-4 py-2 text-sm text-muted hover:text-ink"
      >
        <Eraser size={15} aria-hidden />
        Clear and start again
      </button>
    </div>
  );
}

/** The signature as a PNG, or null if nothing was drawn. */
export function signatureBlob(canvas: HTMLCanvasElement | null): Promise<Blob | null> {
  if (!canvas) return Promise.resolve(null);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}
