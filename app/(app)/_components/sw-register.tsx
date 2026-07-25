"use client";

import { useEffect, useState } from "react";

/**
 * Service-worker registration + safe update prompt (Programme F). Registers
 * /sw.js on load. A NEW worker installs but WAITS (the worker never skipWaiting's
 * itself), so users are never swapped mid-drawing/mid-form. When an update is
 * waiting we show a non-blocking, accessible "New version — Refresh" bar; on the
 * user's click we post SKIP_WAITING and reload once the new worker takes control.
 * First install activates + claims immediately (no waiting worker → no prompt).
 */
export function SwRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    let reloaded = false;
    // Only a GENUINE UPDATE — a new worker replacing an EXISTING controller — may
    // reload. The FIRST install claims this page with no prior controller, so the
    // page is already running the latest code: reloading then is pointless, flashes
    // a reload out from under a first-time visitor mid-form, and races any in-flight
    // page.evaluate (e.g. an axe a11y scan). Capture whether a controller was present
    // at load and gate the reload on it. Matches this component's stated intent that
    // first install is seamless (no prompt, no swap).
    const hadControllerAtLoad = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded || !hadControllerAtLoad) return;
      reloaded = true;
      window.location.reload();
    });

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
  }, []);

  if (!waiting) return null;
  return (
    <div role="status" aria-live="polite" className="fixed inset-x-0 bottom-0 z-[60] flex items-center justify-center gap-3 border-t border-slate-700 bg-slate-900 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-white">
      <span className="text-sm">A new version of CrewFlow is available.</span>
      <button
        type="button"
        onClick={() => { waiting.postMessage({ type: "SKIP_WAITING" }); }}
        className="min-h-[36px] rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-slate-100"
      >
        Refresh
      </button>
    </div>
  );
}
