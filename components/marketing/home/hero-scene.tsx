"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hero self-running product demo — the lifecycle performing itself.
 *
 * A lightweight DOM/SVG recreation of the CrewFlow product UI that plays one
 * real job end-to-end on a gentle loop: a lead arrives, a quote goes
 * Draft → Accepted, the job lands on the schedule, an invoice is sent and then
 * marked Paid — with the live dashboard tiles reacting as it happens.
 *
 * Hard constraints (see LANDING-MOTION-SPEC + product-truth):
 *  - NO animation library. CSS transitions/keyframes + IntersectionObserver + a
 *    single timer. Transform/opacity/stroke-dashoffset only.
 *  - This component only EVER mounts behind the gate in hero-showcase.tsx
 *    (>=768px, motion allowed, IO supported). The static dashboard screenshot
 *    underneath is the no-JS / reduced-motion / mobile fallback and the LCP.
 *  - The scene sits in the same fixed aspect-ratio box as the screenshot, so it
 *    contributes zero CLS. It fades in over the still image after mount.
 *  - PRODUCT TRUTH: only live, deterministic capability is shown. Payment is
 *    tracked / "marked Paid" via bank transfer (never a card "Pay now"), and the
 *    "keeps watch" line is a rule-based flag, never framed as AI.
 *  - aria-hidden: the real <Image> alt beneath carries the accessible content.
 */

const BEAT_MS = 2000;
const RESET_HOLD_MS = 2600;
const TOTAL_BEATS = 6; // 1 lead · 2 quote · 3 accepted · 4 job · 5 invoice · 6 paid

const QUOTE_TOTAL = 12480; // net £10,400 + VAT £2,080
const AWAITING_BASE = 42960;
const PAID_BASE = 18600;

function gbp(n: number): string {
  return "£" + Math.round(n).toLocaleString("en-GB");
}

/** NumberRoll — tabular count-up between values via rAF. */
function NumberRoll({ value, format }: { value: number; format: (n: number) => string }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    const dur = 650;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      setDisplay(from + (to - from) * ease(t));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      fromRef.current = to;
    };
  }, [value]);

  return <span className="cfhs-num">{format(display)}</span>;
}

type ChipState = "draft" | "sent" | "accepted" | "paid" | "idle";

function StatusChip({ state, label }: { state: ChipState; label: string }) {
  return (
    <span className="cfhs-chip" data-state={state}>
      {state === "accepted" || state === "paid" ? (
        <svg className="cfhs-check" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span className="cfhs-dot" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

export function HeroScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [beat, setBeat] = useState(0);
  const [ready, setReady] = useState(false);

  // Fade the scene in once mounted (it covers the still image beneath).
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // One timer, IO-gated: run the loop only while >=40% in view; pause otherwise.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;

    const step = () => {
      setBeat((b) => {
        const next = b >= TOTAL_BEATS ? 0 : b + 1;
        timer = setTimeout(step, next === 0 ? RESET_HOLD_MS : BEAT_MS);
        return next;
      });
    };
    const start = () => {
      if (running) return;
      running = true;
      timer = setTimeout(step, BEAT_MS);
    };
    const stop = () => {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (e && e.isIntersecting) start();
        else stop();
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      stop();
    };
  }, []);

  // Derived, deterministic scene state.
  const leadIn = beat >= 1;
  const quoteIn = beat >= 2;
  const quoteState: ChipState = beat >= 3 ? "accepted" : beat >= 2 ? "draft" : "idle";
  const jobIn = beat >= 4;
  const invoiceIn = beat >= 5;
  const invoiceState: ChipState = beat >= 6 ? "paid" : beat >= 5 ? "sent" : "idle";

  const liveJobs = beat >= 4 ? 15 : 14;
  const awaiting = beat === 5 ? AWAITING_BASE + QUOTE_TOTAL : AWAITING_BASE;
  const paidWeek = beat >= 6 ? PAID_BASE + QUOTE_TOTAL : PAID_BASE;

  return (
    <div ref={rootRef} className="cfhs" data-ready={ready ? "true" : "false"} aria-hidden="true">
      {/* Header: brand + deterministic watch flag */}
      <div className="cfhs-head">
        <div>
          <div className="cfhs-brand">Brightwork Construction</div>
          <div className="cfhs-sub">Monday morning brief</div>
        </div>
        <div className="cfhs-watch">
          <span className="cfhs-flag" aria-hidden="true">⚑</span>
          CrewFlow keeps watch · 3 invoices chasing
        </div>
      </div>

      {/* Live dashboard tiles */}
      <div className="cfhs-tiles">
        <div className="cfhs-tile">
          <div className="cfhs-tile-l">Live jobs</div>
          <div className="cfhs-tile-v"><NumberRoll value={liveJobs} format={(n) => String(Math.round(n))} /></div>
        </div>
        <div className="cfhs-tile">
          <div className="cfhs-tile-l">Awaiting payment</div>
          <div className="cfhs-tile-v"><NumberRoll value={awaiting} format={gbp} /></div>
        </div>
        <div className="cfhs-tile cfhs-tile-pos">
          <div className="cfhs-tile-l">Paid this week</div>
          <div className="cfhs-tile-v"><NumberRoll value={paidWeek} format={gbp} /></div>
        </div>
      </div>

      {/* Body: pipeline + the job moving through quote → schedule → invoice */}
      <div className="cfhs-body">
        <div className="cfhs-panel cfhs-pipeline">
          <div className="cfhs-panel-h">Pipeline</div>
          <div className="cfhs-lead" data-in={leadIn ? "true" : "false"}>
            <div className="cfhs-lead-top">
              <span className="cfhs-newdot" aria-hidden="true" />
              <span className="cfhs-lead-name">Oakfield Road — loft conversion</span>
            </div>
            <div className="cfhs-lead-meta">
              <span>Website enquiry</span>
              <span className="cfhs-lead-val">{gbp(QUOTE_TOTAL)} est.</span>
            </div>
          </div>
          <div className="cfhs-lead cfhs-lead-ghost">
            <div className="cfhs-lead-top"><span className="cfhs-lead-name">Dale Street — roof repair</span></div>
            <div className="cfhs-lead-meta"><span>Referral</span><span className="cfhs-lead-val">£3,900 est.</span></div>
          </div>
          <div className="cfhs-lead cfhs-lead-ghost">
            <div className="cfhs-lead-top"><span className="cfhs-lead-name">Mill Lane — extension</span></div>
            <div className="cfhs-lead-meta"><span>Phone</span><span className="cfhs-lead-val">£28,500 est.</span></div>
          </div>
        </div>

        <div className="cfhs-panel cfhs-work">
          <div className="cfhs-panel-h">Oakfield Road</div>

          {/* Quote */}
          <div className="cfhs-row" data-in={quoteIn ? "true" : "false"}>
            <div className="cfhs-row-main">
              <span className="cfhs-row-id">Quote #1042</span>
              <span className="cfhs-row-amt"><NumberRoll value={quoteIn ? QUOTE_TOTAL : 0} format={gbp} /> <em>inc. VAT</em></span>
            </div>
            <StatusChip state={quoteState} label={quoteState === "accepted" ? "Accepted" : "Draft"} />
          </div>

          {/* Schedule lane */}
          <div className="cfhs-cal" data-in={jobIn ? "true" : "false"}>
            {["M", "T", "W", "T", "F"].map((d, i) => (
              <div key={i} className="cfhs-cal-day">
                <span className="cfhs-cal-d">{d}</span>
                {(i === 2 || i === 3) && <span className="cfhs-cal-block" data-lead={i === 2 ? "true" : "false"} />}
              </div>
            ))}
            <span className="cfhs-cal-tag">Scheduled · Wed–Thu</span>
          </div>

          {/* Invoice */}
          <div className="cfhs-row" data-in={invoiceIn ? "true" : "false"}>
            <div className="cfhs-row-main">
              <span className="cfhs-row-id">Invoice INV-1042</span>
              <span className="cfhs-row-amt">{gbp(QUOTE_TOTAL)}</span>
            </div>
            <StatusChip state={invoiceState} label={invoiceState === "paid" ? "Paid" : "Sent"} />
          </div>
          <div className="cfhs-reminder" data-in={invoiceIn ? "true" : "false"}>
            Auto-chase: day 3 · 7 · 14 · 21
          </div>
        </div>
      </div>

      {/* Progress rail — which beat is live */}
      <div className="cfhs-rail">
        {Array.from({ length: TOTAL_BEATS }).map((_, i) => (
          <span key={i} className="cfhs-seg" data-on={beat >= i + 1 ? "true" : "false"} />
        ))}
      </div>
    </div>
  );
}

export default HeroScene;
