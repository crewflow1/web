"use client";

import { useState } from "react";
import { googleMapsUrl, appleMapsUrl } from "@/lib/maps";
import type { Address } from "@/lib/address";
import { formatAddressOneLine } from "@/lib/address";

/**
 * Navigation controls for an address: Open in Google Maps / Apple Maps /
 * Copy address. Renders nothing when there's no address. Used on the owner
 * dashboard, job detail and the staff/mobile portal.
 */
export function MapActions({
  address,
  className = "",
}: {
  address: Address | string | null | undefined;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const oneLine =
    typeof address === "string" ? address : formatAddressOneLine(address);
  const google = googleMapsUrl(address);
  const apple = appleMapsUrl(address);

  if (!oneLine) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(oneLine);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — ignore
    }
  }

  const btn =
    "inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-50";

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {google ? (
        <a href={google} target="_blank" rel="noopener noreferrer" className={btn}>
          📍 Google Maps
        </a>
      ) : null}
      {apple ? (
        <a href={apple} target="_blank" rel="noopener noreferrer" className={btn}>
           Apple Maps
        </a>
      ) : null}
      <button type="button" onClick={copy} className={btn}>
        {copied ? "✓ Copied" : "Copy address"}
      </button>
    </div>
  );
}
