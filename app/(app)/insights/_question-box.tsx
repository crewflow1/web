"use client";

import { useState } from "react";
import type { AiResponse } from "@/lib/ai/safety";

/**
 * Phase 5 — AI question box.
 *
 * Operator types a question → POSTs to /api/ai/question →
 * the AI handler returns an `AiResponse` → we render answer +
 * confidence + sources. Always shows the read-only disclosure.
 */

const SAMPLE_QUESTIONS = [
  "What should I focus on this week?",
  "Which customers owe me money?",
  "Where am I losing profit?",
  "Summarise this month.",
] as const;

const CONFIDENCE_PILL = {
  high: "bg-emerald-100 text-emerald-800 border-emerald-200",
  medium: "bg-amber-100 text-amber-900 border-amber-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
} as const;

export function QuestionBox({ aiConfigured }: { aiConfigured: boolean }) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<AiResponse | null>(null);

  async function submit(q: string) {
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const res = await fetch("/api/ai/question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
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
      setError(
        e instanceof Error ? e.message : "Couldn't reach the AI service.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">
          Ask CrewFlow Insights
        </h2>
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            aiConfigured
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
          title={
            aiConfigured
              ? "Anthropic / OpenAI key detected — answers use the LLM with deterministic fallback."
              : "No AI key configured — answers fall back to deterministic helpers."
          }
        >
          {aiConfigured ? "AI active" : "Deterministic only"}
        </span>
      </header>

      <p className="mt-1 text-xs text-slate-500">
        Read-only — answers never change your records or send messages.
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
          placeholder="e.g. What should I focus on this week?"
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
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-sm text-slate-900">{response.answer}</p>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 font-medium ${CONFIDENCE_PILL[response.confidence]}`}
            >
              confidence: {response.confidence}
            </span>
            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600">
              via {response.generated_by}
            </span>
            {response.sources.map((s, i) => (
              <span
                key={i}
                className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600"
              >
                {s.label}
              </span>
            ))}
          </div>
        </article>
      ) : null}
    </section>
  );
}
