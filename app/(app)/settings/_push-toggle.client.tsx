"use client";

import { useEffect, useState } from "react";
import {
  savePushSubscriptionAction,
  removePushSubscriptionAction,
} from "./push-actions";

/**
 * Web Push device subscription toggle (MP Wave R4).
 *
 * Manages the BROWSER subscription for THIS device (separate from the per-
 * category push preference in the grid below, which decides which categories
 * push once a device is subscribed). Flow:
 *   * checks Notification permission + serviceWorker + PushManager support;
 *   * on enable: requests permission, subscribes via the existing /sw.js
 *     registration using the server-provided VAPID public key, persists the
 *     subscription server-side;
 *   * on disable: unsubscribes locally and removes the row server-side.
 *
 * Rendered only when the channel is configured (VAPID set). Degrades gracefully
 * where Web Push is unsupported (e.g. iOS Safari outside an installed PWA).
 */

/** Convert the base64url VAPID public key to the Uint8Array subscribe() wants. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function keyToBase64Url(sub: PushSubscription, name: "p256dh" | "auth"): string {
  const key = sub.getKey(name);
  if (!key) return "";
  const bytes = new Uint8Array(key);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Status = "loading" | "unsupported" | "denied" | "on" | "off" | "busy";

export function PushDeviceToggle({ publicKey }: { publicKey: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (
        typeof window === "undefined" ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        if (!cancelled) setStatus("unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setStatus("denied");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (!cancelled) setStatus(existing ? "on" : "off");
      } catch {
        if (!cancelled) setStatus("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setError(null);
    setStatus("busy");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const res = await savePushSubscriptionAction({
        endpoint: sub.endpoint,
        p256dh: keyToBase64Url(sub, "p256dh"),
        auth: keyToBase64Url(sub, "auth"),
        userAgent: navigator.userAgent,
      });
      if (!res.ok) {
        setError("Couldn't save this device. Please try again.");
        setStatus("off");
        return;
      }
      setStatus("on");
    } catch {
      setError("Couldn't enable push on this device.");
      setStatus("off");
    }
  }

  async function disable() {
    setError(null);
    setStatus("busy");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await removePushSubscriptionAction(sub.endpoint);
        await sub.unsubscribe();
      }
      setStatus("off");
    } catch {
      setError("Couldn't disable push on this device.");
      setStatus("on");
    }
  }

  return (
    <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-900">
            Push notifications on this device
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            {status === "unsupported"
              ? "This browser doesn't support push notifications. On iPhone, add CrewFlow to your Home Screen first."
              : status === "denied"
                ? "Notifications are blocked in your browser settings. Re-enable them there to turn push on."
                : "Get alerts even when CrewFlow isn't open. Choose which categories push in the table below."}
          </p>
        </div>
        {status === "on" ? (
          <button
            type="button"
            onClick={disable}
            className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            Turn off
          </button>
        ) : status === "off" ? (
          <button
            type="button"
            onClick={enable}
            className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Enable
          </button>
        ) : status === "busy" || status === "loading" ? (
          <span className="shrink-0 text-xs text-slate-400">Working…</span>
        ) : null}
      </div>
      {status === "on" ? (
        <p className="mt-2 text-xs font-medium text-emerald-700">
          Push is enabled on this device.
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs font-medium text-red-600">{error}</p>
      ) : null}
    </div>
  );
}
