"use client";

import { useState } from "react";
import Link from "next/link";
import type { AiResponse } from "@/lib/ai/safety";

/**
 * AI Site Manager — job-scoped question box.
 *
 * Operator (owner, admin, or an assigned staff member) asks a site-level
 * question about THIS job → POSTs to /api/ai/site-manager with the jobId →
 * renders the grounded `AiResponse` (answer + confidence + deep-link sources).
 *
 * Read-only: the Site Manager never changes records or sends messages. The
 * server picks the permission-gated tool from the question's intent, so what
 * comes back is always scoped to what this member is allowed to see — a staff
 * member never gets another member's job, and commercial figures are gated to
 * owner/admin.
 */

const CONFIDENCE_PILL = {
  high: "bg-emerald-100 text-emerald-800 border-emerald-200",
  medium: "bg-amber-100 text-amber-900 border-amber-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
} as const;

const SAMPLE_QUESTIONS = [
  "What's the latest on this job?",
  "Any open snags?",
  "What materials are outstanding?",
  "What's in the site diary?",
] as const;

export function SiteManagerPanel({ jobId }: { jobId: string }) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<AiResponse | null>(null);

  async function submit(q: string) {
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const res = await fetch("/api/ai/site-manager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, jobId }),
      });
      const json = (await res.json()) as
        | { ok: true; response: AiResponse }
        | { ok: false; error: string };
      if (!json.ok) {
        setError(json.error);
        return;
      }
      setResponse(json.response);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach the Site Manager.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">AI Site Manager</h2>
        <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600">
          Read-only
        </span>
      </header>

      <p className="mt-1 text-xs text-slate-500">
        Ask about this job&apos;s progress, snags, materials or diary. Answers are
        grounded in your records and never change anything.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim().length >= 3) submit(question.trim());
        }}
        className="mt-3 flex flex-wrap items-stretch gap-2"
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Any open snags on this job?"
          minLength={3}
          maxLength={500}
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
        <button
          type="submit"
          disabled={loading || question.trim().length < 3}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {SAMPLE_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => {
              setQuestion(q);
              submit(q);
            }}
            disabled={loading}
            className="rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {error}
        </div>
      ) : null}

      {response ? (
        <article className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm text-slate-900">{response.answer}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 font-medium ${CONFIDENCE_PILL[response.confidence]}`}
            >
              confidence: {response.confidence}
            </span>
            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600">
              via {response.generated_by}
            </span>
            {response.sources.map((s, i) =>
              s.href ? (
                <Link
                  key={i}
                  href={s.href}
                  className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-700 underline-offset-2 hover:underline"
                >
                  {s.label}
                </Link>
              ) : (
                <span
                  key={i}
                  className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600"
                >
                  {s.label}
                </span>
              ),
            )}
          </div>
        </article>
      ) : null}
    </section>
  );
}
