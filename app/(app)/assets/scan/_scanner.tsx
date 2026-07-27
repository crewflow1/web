"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { scanPath, tokenFromScan } from "@/lib/assets/qr";

/**
 * In-app QR scanner entry — a client surface for scanning an asset label from a
 * phone/tablet inside CrewFlow (a kiosk/handset already signed in), with a
 * manual-code fallback for every other browser.
 *
 * The camera path uses the native `BarcodeDetector` where the browser exposes
 * it (Chrome/Android today); everywhere else (notably iOS Safari) it degrades
 * gracefully to the always-present manual entry — the same box that accepts a
 * pasted label URL or the code printed under the QR.
 *
 * Whatever the source, the value is run through `tokenFromScan` (host ignored,
 * `/a/<token>` path only) and we navigate INTERNALLY via `scanPath`. The token
 * is still resolved behind auth + RLS by the `/a/[token]` route — this surface
 * never trusts the scanned string beyond its shape.
 */

// Minimal structural types for the Barcode Detection API (not in lib.dom yet).
type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

type CameraState = "idle" | "starting" | "scanning" | "unsupported" | "error";

export function AssetScanner() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const doneRef = useRef(false);

  const [camera, setCamera] = useState<CameraState>("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Resolve a scanned/typed value to a token and navigate, or report a miss.
  const resolve = useCallback(
    (raw: string): boolean => {
      const token = tokenFromScan(raw);
      if (!token) return false;
      doneRef.current = true;
      stopCamera();
      router.push(scanPath(token));
      return true;
    },
    [router, stopCamera],
  );

  const startCamera = useCallback(async () => {
    setCameraError(null);
    const Ctor = getBarcodeDetectorCtor();
    if (!Ctor) {
      setCamera("unsupported");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCamera("unsupported");
      return;
    }

    setCamera("starting");
    doneRef.current = false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch {
      setCamera("error");
      setCameraError("Camera access was blocked. Allow the camera, or enter the code below.");
      return;
    }
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      stopCamera();
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      /* autoplay policies vary; the frame loop still reads pixels */
    }

    const detector = new Ctor({ formats: ["qr_code"] });
    setCamera("scanning");

    const tick = async () => {
      if (doneRef.current) return;
      const v = videoRef.current;
      if (v && v.readyState >= 2) {
        try {
          const codes = await detector.detect(v);
          for (const code of codes) {
            if (resolve(code.rawValue)) return;
          }
        } catch {
          /* transient decode errors are expected between frames */
        }
      }
      rafRef.current = requestAnimationFrame(() => void tick());
    };
    rafRef.current = requestAnimationFrame(() => void tick());
  }, [resolve, stopCamera]);

  // Always release the camera on unmount.
  useEffect(() => stopCamera, [stopCamera]);

  const onManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setManualError(null);
    if (!resolve(manual)) {
      setManualError("That doesn't look like a CrewFlow asset code. Check the code under the QR and try again.");
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">Scan with the camera</h2>
        <p className="mt-1 text-sm text-slate-600">
          Point the camera at the QR on an asset label. Works on Chrome and Android;
          on other devices use the code entry below.
        </p>

        <div className="mt-3 aspect-video w-full overflow-hidden rounded-md bg-slate-900/90">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        </div>

        <div className="mt-3 flex items-center gap-3">
          {camera === "scanning" ? (
            <button
              type="button"
              onClick={stopCamera}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Stop camera
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void startCamera()}
              disabled={camera === "starting"}
              className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {camera === "starting" ? "Starting…" : "Start camera"}
            </button>
          )}
          {camera === "scanning" ? (
            <span className="text-xs font-medium text-emerald-700">Scanning…</span>
          ) : null}
        </div>

        {camera === "unsupported" ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This browser can&apos;t scan in-app. Open the printed label with your
            phone&apos;s camera, or enter the code below.
          </p>
        ) : null}
        {cameraError ? (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {cameraError}
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">Enter the code</h2>
        <p className="mt-1 text-sm text-slate-600">
          Type or paste the code printed under the QR, or the full label link.
        </p>
        <form onSubmit={onManualSubmit} className="mt-3 flex flex-wrap items-start gap-2">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="e.g. 3xAmpL3-t0k3n or https://crewflow.uk/a/…"
            aria-label="Asset code or label link"
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Open asset
          </button>
        </form>
        {manualError ? (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {manualError}
          </p>
        ) : null}
      </section>
    </div>
  );
}
