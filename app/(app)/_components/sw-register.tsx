"use client";

import { useEffect, useRef, useState } from "react";
import { shouldReloadOnControllerChange } from "@/lib/pwa/sw-lifecycle";

/**
 * Service-worker registration + safe update prompt (Programme F). Registers
 * /sw.js on load. A NEW worker installs but WAITS (the worker never skipWaiting's
 * itself), so users are never swapped mid-drawing/mid-form. When an update is
 * waiting we show a non-blocking, accessible "New version — Refresh" bar; on the
 * user's click we post SKIP_WAITING and reload once the new worker takes control.
 *
 * FIRST INSTALL IS SILENT: it installs, activates and claims this page (so future
 * navigations are SW-controlled and the offline shell works), but it MUST NOT
 * reload — the page already runs the latest code, and a reload would flash a
 * navigation out from under a first-time visitor mid-form and lose unsaved input.
 * Both the first-install claim and the post-SKIP_WAITING claim dispatch the SAME
 * `controllerchange` event, indistinguishable from the event alone, so the reload
 * is gated on `userAcceptedUpdate` — a ref armed ONLY by the user's Refresh click
 * (see lib/pwa/sw-lifecycle.ts shouldReloadOnControllerChange).
 */

export function SwRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  // Armed ONLY by the user's Refresh click. The first-install clients.claim()
  // fires controllerchange with this still false → no reload. A ref (not state)
  // because the Refresh button lives in render scope while the listener lives in
  // effect scope; they must share one mutable cell (state would give the listener
  // a stale closure).
  const userAcceptedUpdate = useRef(false);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    let reloaded = false;

    const onControllerChange = () => {
      if (!shouldReloadOnControllerChange(userAcceptedUpdate.current, reloaded)) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    navigator.serviceWorker.register("/sw.js").then((r) => {
      if (r.waiting && navigator.serviceWorker.controller) setWaiting(r.waiting);
      r.addEventListener("updatefound", () => {
        const nw = r.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          // installed + an existing controller = a genuine update (not first install)
          if (nw.state === "installed" && navigator.serviceWorker.controller) setWaiting(nw);
        });
      });
    }).catch(() => { /* SW unsupported / blocked — app works online exactly as before */ });

    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, []);

  if (!waiting) return null;
  return (
    <div role="status" aria-live="polite" className="fixed inset-x-0 bottom-0 z-[60] flex items-center justify-center gap-3 border-t border-slate-700 bg-slate-900 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-white">
      <span className="text-sm">A new version of CrewFlow is available.</span>
      <button
        type="button"
        onClick={() => {
          // Arm BEFORE asking the SW to activate, so the resulting controllerchange
          // is recognised as user-initiated and the (only) reload fires.
          userAcceptedUpdate.current = true;
          waiting.postMessage({ type: "SKIP_WAITING" });
        }}
        className="min-h-[36px] rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-slate-100"
      >
        Refresh
      </button>
    </div>
  );
}
