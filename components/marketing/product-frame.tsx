import type { ReactNode } from "react";

/**
 * PRODUCT-PROOF FRAME — honest, TEMPORARY placeholder.
 *
 * The real CrewFlow app is a LIGHT UI; showing it inside the dark marketing
 * shell (browser-framed, light surface) is the intentional premium contrast.
 *
 * This is NOT a fake dashboard with invented metrics/customers. When no real
 * screenshot is supplied it renders a neutral, structured *schematic* of a
 * CrewFlow app screen (real app shape — sidebar, topbar, tiles, table — with
 * ZERO fabricated data/numbers/names) plus a visible "Product preview" tag.
 * Every instance is marked `data-proof="placeholder"` so QA can grep the build
 * and confirm none ships pretending to be real. Drop a real seeded <Image> in
 * as `children` to replace the schematic before CEO review.
 */
export function ProductFrame({
  screen,
  url,
  children,
  className = "",
}: {
  screen: string;
  url: string;
  children?: ReactNode;
  className?: string;
}) {
  const isPlaceholder = !children;
  return (
    <figure
      className={`overflow-hidden rounded-cf border border-white/10 bg-navy-850 shadow-cf ring-1 ring-inset ring-white/[0.04] ${className}`}
      {...(isPlaceholder ? { "data-proof": "placeholder" } : {})}
    >
      {/* Browser chrome */}
      <div
        aria-hidden="true"
        className="flex items-center gap-2 border-b border-white/10 bg-navy-800 px-3.5 py-2.5"
      >
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        </span>
        <span className="ml-2 truncate rounded-md bg-navy-950/60 px-2.5 py-1 font-mono text-[11px] text-ink-dim">
          {url}
        </span>
      </div>

      {children ? (
        // Real seeded screenshot goes here (light UI).
        <div className="bg-[#F7F9FC]">{children}</div>
      ) : (
        // Neutral structured schematic of a light CrewFlow screen (no data).
        <div aria-hidden="true" className="flex bg-[#F7F9FC]">
          {/* Sidebar */}
          <div className="hidden w-44 shrink-0 border-r border-slate-200 bg-white p-3 sm:block">
            <div className="flex items-center gap-2">
              <span className="h-5 w-5 rounded bg-slate-900" />
              <span className="h-2.5 w-16 rounded bg-slate-200" />
            </div>
            <div className="mt-5 space-y-1.5">
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${i === 1 ? "bg-slate-100" : ""}`}
                >
                  <span className="h-3 w-3 rounded bg-slate-300" />
                  <span className={`h-2 rounded bg-slate-200 ${i === 1 ? "w-20" : "w-16"}`} />
                </div>
              ))}
            </div>
          </div>
          {/* Main */}
          <div className="min-w-0 flex-1 p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="text-[13px] font-semibold text-slate-800">{screen}</span>
              </div>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                Product preview
              </span>
            </div>
            {/* Stat tiles */}
            <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="h-2 w-10 rounded bg-slate-200" />
                  <div className="mt-2.5 h-4 w-16 rounded bg-slate-300" />
                </div>
              ))}
            </div>
            {/* Table */}
            <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-3.5 py-2">
                <span className="h-2 w-24 rounded bg-slate-300" />
                <span className="ml-auto h-2 w-12 rounded bg-slate-200" />
                <span className="h-2 w-10 rounded bg-slate-200" />
              </div>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 border-b border-slate-100 px-3.5 py-2.5 last:border-0">
                  <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
                  <span className="h-2 flex-1 rounded bg-slate-100" />
                  <span className="h-2 w-12 rounded bg-slate-200" />
                  <span className="h-4 w-14 rounded-full bg-slate-100" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <figcaption className="sr-only">
        CrewFlow {screen} — product preview{isPlaceholder ? " (placeholder schematic; real screenshot to follow)" : ""}.
      </figcaption>
    </figure>
  );
}
