"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Global search palette — opens on Cmd/Ctrl+K or by clicking the
 * header "Search" pill. Hits the /api/search endpoint with a 200ms
 * debounce.
 */

type Hit = {
  type: "customer" | "job" | "quote" | "invoice" | "lead" | "staff" | "risk_assessment" | "permit";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
};

const TYPE_LABELS: Record<Hit["type"], string> = {
  customer: "Customer",
  job: "Job",
  quote: "Quote",
  invoice: "Invoice",
  lead: "Lead",
  staff: "Staff",
  risk_assessment: "RAMS",
  permit: "Permit",
};

const TYPE_ICONS: Record<Hit["type"], string> = {
  customer: "👤",
  job: "🔧",
  quote: "📝",
  invoice: "💷",
  lead: "🎯",
  staff: "👷",
  risk_assessment: "🦺",
  permit: "📋",
};

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Global Cmd/Ctrl+K binding.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus input when opening.
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 10);
    } else {
      setQ("");
      setHits([]);
      setActive(0);
    }
  }, [open]);

  // Debounced fetch.
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (r.ok) {
          const j = (await r.json()) as { hits: Hit[] };
          setHits(j.hits ?? []);
          setActive(0);
        }
      } catch {
        // ignore aborts
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, hits.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        const h = hits[active];
        if (h) {
          setOpen(false);
          router.push(h.href);
        }
      }
    },
    [hits, active, router],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search (⌘K)"
        className="hidden items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 sm:inline-flex"
      >
        <span aria-hidden>🔎</span>
        <span>Search</span>
        <kbd className="ml-2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-mono text-slate-500">
          ⌘K
        </kbd>
      </button>
      {/* Mobile: icon-only trigger */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search"
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50 sm:hidden"
      >
        🔎
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 px-4 pt-24"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
              <span aria-hidden className="text-slate-400">🔎</span>
              <input
                ref={inputRef}
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search by address, postcode, customer, job, invoice…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
              />
              {loading ? <span className="text-xs text-slate-400">…</span> : null}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-xs text-slate-500 hover:text-slate-900"
                aria-label="Close"
              >
                Esc
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {q.trim().length < 2 ? (
                <p className="px-3 py-6 text-center text-xs text-slate-500">
                  Type at least 2 characters. Search by address, postcode, site
                  or customer — spans customers, jobs, quotes, invoices, leads,
                  staff + invoice numbers.
                </p>
              ) : hits.length === 0 && !loading ? (
                <p className="px-3 py-6 text-center text-xs text-slate-500">
                  No results for &ldquo;{q}&rdquo;.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {hits.map((h, i) => (
                    <li key={`${h.type}-${h.id}`}>
                      <Link
                        href={h.href}
                        onClick={() => setOpen(false)}
                        className={
                          i === active
                            ? "flex items-center gap-3 bg-slate-100 px-3 py-2"
                            : "flex items-center gap-3 px-3 py-2 hover:bg-slate-50"
                        }
                      >
                        <span aria-hidden className="text-base">{TYPE_ICONS[h.type]}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-900">
                            {h.title}
                          </span>
                          {h.subtitle ? (
                            <span className="block truncate text-xs text-slate-500">
                              {h.subtitle}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                          {TYPE_LABELS[h.type]}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400">
              ↑↓ to navigate · ⏎ to open · Esc to close
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
