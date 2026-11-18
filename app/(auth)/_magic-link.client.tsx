"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { signInWithMagicLink } from "./actions";

/**
 * Magic-link sign-in without the email address ever appearing in a URL.
 *
 * DATA MINIMISATION (privacy finding G-10 / M-7). The confirmation page used to
 * be `/check-email?email=<address>`, so every magic-link sign-in wrote the
 * address into hosting request logs, browser history and — after analytics
 * consent — analytics page-view URLs. Now the address travels only in the form
 * POST body, and the confirmation page learns it from `sessionStorage`, written
 * here in the browser immediately before the form submits:
 *
 *   - per tab, never sent to the server, never read by analytics;
 *   - removed as soon as the confirmation page has read it; from then on it is
 *     held only in memory (React state + a module variable, so a re-render after
 *     "Resend the link" keeps it) and is gone on reload;
 *   - strictly necessary: it exists only to complete the sign-in the person
 *     asked for, so it needs no consent and is not a cookie.
 * If it is missing (page reloaded, link opened in a new tab) the page says
 * "the email address you entered" and offers "Try again" instead of a resend.
 *
 * Pinned by __tests__/security/auth-urls-no-email.test.ts and the magic-link
 * test in e2e/auth-recovery-and-signup.spec.ts.
 */
export const MAGIC_LINK_EMAIL_KEY = "cf_magic_link_email";

// In-memory copy after the hand-off is consumed: survives a client re-render or
// remount (e.g. the resend round-trip), never persisted, gone on a full reload.
let handedOff: string | null = null;

function remember(email: string): void {
  const value = email.trim();
  if (!value) return;
  try {
    window.sessionStorage.setItem(MAGIC_LINK_EMAIL_KEY, value);
  } catch {
    // Storage blocked (private mode / policy): the confirmation page falls back
    // to its generic wording. Sign-in itself is unaffected.
  }
}

function takeRemembered(): string | null {
  try {
    const value = window.sessionStorage.getItem(MAGIC_LINK_EMAIL_KEY);
    if (value !== null) window.sessionStorage.removeItem(MAGIC_LINK_EMAIL_KEY);
    return value && value.includes("@") ? value : null;
  } catch {
    return null;
  }
}

function rememberFromForm(e: FormEvent<HTMLFormElement>): void {
  const field = e.currentTarget.elements.namedItem("email");
  if (field instanceof HTMLInputElement) remember(field.value);
}

/** The /login magic-link form. Same server action and markup as before. */
export function MagicLinkForm({ recoverable }: { recoverable: boolean }) {
  return (
    <form
      action={signInWithMagicLink}
      onSubmit={rememberFromForm}
      className="space-y-3"
      data-testid="magic-link-form"
      aria-label="Sign in with a magic link"
    >
      <label htmlFor="email" className="block text-sm font-medium text-slate-700">
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        autoFocus={recoverable}
        placeholder="you@yourcompany.co.uk"
        className="block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
      <button
        type="submit"
        className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
      >
        {recoverable ? "Send me a fresh magic link" : "Email me a magic link"}
      </button>
      <p className="text-center text-[11px] text-slate-500">
        The link can take a minute to arrive and may land in your spam or
        junk folder.
      </p>
    </form>
  );
}

/**
 * The address line + resend control on /check-email. Server-renders the
 * generic wording; after hydration shows the address the person typed (from
 * this tab's sessionStorage) and the one-click resend.
 */
export function CheckEmailDetails() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    // Only ever SET: under React strict mode the effect runs twice and the
    // second storage read finds the key already removed (memory copy covers it).
    const value = takeRemembered() ?? handedOff;
    if (value) {
      handedOff = value;
      setEmail(value);
    }
  }, []);

  return (
    <>
      <p className="text-sm text-slate-600">
        We&apos;ve sent a magic sign-in link to{" "}
        <strong className="text-slate-900" data-testid="check-email-address">
          {email ?? "the email address you entered"}
        </strong>
        . Click the link in the email to sign in.
      </p>
      <p className="text-xs text-slate-500">
        The link expires in 15 minutes. Most arrive within a minute.
      </p>
      <div className="mx-auto max-w-sm rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs text-amber-900">
        Don&apos;t see it? Check your <strong>spam or junk</strong> folder. If
        it&apos;s there, mark it &ldquo;not spam&rdquo; so future sign-in links
        land in your inbox.
      </div>

      {email ? (
        <form action={signInWithMagicLink} className="flex flex-col items-center gap-2 pt-2">
          <input type="hidden" name="email" value={email} />
          <button
            type="submit"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            Resend the link
          </button>
          <p className="text-[11px] text-slate-500">
            Or{" "}
            <Link href="/login" className="font-medium text-slate-900 underline">
              use a different email
            </Link>
            .
          </p>
        </form>
      ) : (
        <p className="text-xs text-slate-500">
          <Link href="/login" className="font-medium text-slate-900 underline">
            Try again
          </Link>
        </p>
      )}
    </>
  );
}
