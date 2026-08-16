"use client";

import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormErrorBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { formatQuantity } from "@/lib/stock/movements";
import { recordStocktakeCount, resolveScannedItem } from "../../stocktake-actions";

/**
 * The counting surface — MOBILE FIRST, because this is used standing in a
 * container. Two ways in:
 *
 *   1. SCAN. The device camera decodes a product barcode via the native
 *      BarcodeDetector (Chrome/Android). The decoded string is resolved to a
 *      catalogue item SERVER-SIDE (resolveScannedItem, org-pinned + loud) — the
 *      scanned value is never trusted beyond being matched. On a hit the item is
 *      selected and the quantity field focused; scan the box, type how many.
 *   2. PICK. A plain <select> of the items on this count, for anything without a
 *      barcode or when the camera is unavailable (iOS Safari has no
 *      BarcodeDetector — the manual path is always present, the AssetScanner
 *      degradation pattern).
 *
 * Each saved count HARD-NAVIGATES back to the session (window.location.assign),
 * the stock surface's documented Next 15.5 posture — the count lands, the sheet
 * re-reads fresh, and the next scan starts clean.
 */

type Line = {
  stockItemId: string;
  name: string;
  unit: string;
  sku: string | null;
  barcode: string | null;
  expected: number;
  counted: number | null;
};

type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = { new (options?: { formats?: string[] }): BarcodeDetectorLike };

const BARCODE_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "codabar",
  "itf",
  "qr_code",
];

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

type CameraState = "idle" | "starting" | "scanning" | "unsupported" | "error";

export function CountPanel({ sessionId, lines }: { sessionId: string; lines: Line[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    recordStocktakeCount.bind(null, sessionId),
    INITIAL_FORM_STATE,
  );

  const [selectedId, setSelectedId] = useState<string>(lines[0]?.stockItemId ?? "");
  const [qty, setQty] = useState<string>("");
  const [scanNote, setScanNote] = useState<string | null>(null);
  const qtyRef = useRef<HTMLInputElement | null>(null);

  const byId = useMemo(() => new Map(lines.map((l) => [l.stockItemId, l])), [lines]);
  const selected = selectedId ? byId.get(selectedId) : undefined;

  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  // ── camera scanning ─────────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const [camera, setCamera] = useState<CameraState>("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);

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
    setCamera("idle");
  }, []);

  const onScanned = useCallback(
    async (raw: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setScanNote("Looking up…");
      try {
        const res = await resolveScannedItem(raw);
        if (res.ok && res.itemId && byId.has(res.itemId)) {
          setSelectedId(res.itemId);
          setQty("");
          setScanNote(`Found ${res.name}. Enter how many.`);
          stopCamera();
          setTimeout(() => qtyRef.current?.focus(), 50);
        } else if (res.ok && res.itemId) {
          setScanNote(`${res.name} isn't on this stocktake.`);
        } else {
          setScanNote(res.message ?? "No match.");
        }
      } catch {
        setScanNote("Couldn't look that up.");
      } finally {
        // brief debounce so one barcode does not fire a burst of lookups
        setTimeout(() => {
          busyRef.current = false;
        }, 1200);
      }
    },
    [byId, stopCamera],
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
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch {
      setCamera("error");
      setCameraError("Camera access was blocked. Allow the camera, or pick the item below.");
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
    const detector = new Ctor({ formats: BARCODE_FORMATS });
    setCamera("scanning");

    const tick = async () => {
      const v = videoRef.current;
      if (v && v.readyState >= 2 && !busyRef.current) {
        try {
          const codes = await detector.detect(v);
          const first = codes[0]?.rawValue;
          if (first) void onScanned(first);
        } catch {
          /* transient decode errors between frames */
        }
      }
      rafRef.current = requestAnimationFrame(() => void tick());
    };
    rafRef.current = requestAnimationFrame(() => void tick());
  }, [onScanned, stopCamera]);

  useEffect(() => stopCamera, [stopCamera]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Count</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Scan a barcode or pick the item, then enter how many you count.
        </p>
      </div>

      {/* Scanner */}
      <div className="border-b border-slate-100 p-4">
        <div className="aspect-video w-full overflow-hidden rounded-md bg-slate-900/90">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
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
              {camera === "starting" ? "Starting…" : "Scan a barcode"}
            </button>
          )}
          {camera === "scanning" ? <span className="text-xs font-medium text-emerald-700">Scanning…</span> : null}
          {scanNote ? <span className="text-xs text-slate-600">{scanNote}</span> : null}
        </div>
        {camera === "unsupported" ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This browser can&apos;t scan in-app. Pick the item below instead.
          </p>
        ) : null}
        {cameraError ? (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {cameraError}
          </p>
        ) : null}
      </div>

      {/* Count entry */}
      <form action={formAction} className="space-y-4 p-4" noValidate>
        <FormErrorBanner error={state.error} />
        <input type="hidden" name="stock_item_id" value={selectedId} />

        <div>
          <label htmlFor="count-item" className="block text-sm font-medium text-slate-800">
            Item
          </label>
          <select
            id="count-item"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
          >
            {lines.map((l) => (
              <option key={l.stockItemId} value={l.stockItemId}>
                {l.name}
                {l.counted !== null ? ` — counted ${formatQuantity(l.counted)}` : ""}
              </option>
            ))}
          </select>
        </div>

        {selected ? (
          <p className="text-xs text-slate-500">
            Expected <span className="font-medium tabular-nums text-slate-700">{formatQuantity(selected.expected)}</span>{" "}
            {selected.unit}
            {selected.counted !== null
              ? ` · currently counted ${formatQuantity(selected.counted)}`
              : " · not counted yet"}
          </p>
        ) : null}

        <div>
          <label htmlFor="counted_qty" className="block text-sm font-medium text-slate-800">
            Counted<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            ref={qtyRef}
            id="counted_qty"
            name="counted_qty"
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="0"
            className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">
            How many are physically here. Leave blank and save to clear a count.
          </p>
        </div>

        <SubmitButton pending={pending}>Save count</SubmitButton>
      </form>
    </div>
  );
}
