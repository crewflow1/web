"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import {
  enrollTotp,
  verifyTotpEnrollment,
  unenrollFactor,
  linkGoogleIdentity,
  linkMicrosoftIdentity,
  type EnrollResult,
} from "./actions";

export type FactorView = {
  id: string;
  friendlyName: string | null;
  status: string;
};

export type IdentityView = { provider: string };

function Pending({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return <>{pending ? busy : idle}</>;
}

// ---------------------------------------------------------------------------
// TOTP enrolment
// ---------------------------------------------------------------------------

export function MfaSection({
  factors,
  loadError = false,
}: {
  factors: FactorView[];
  loadError?: boolean;
}) {
  const router = useRouter();
  const [enroll, setEnroll] = useState<EnrollResult | null>(null);
  const [starting, startEnroll] = useTransition();

  const [verifyState, verifyAction] = useActionState(
    verifyTotpEnrollment,
    INITIAL_FORM_STATE,
  );

  useEffect(() => {
    if (verifyState.ok) {
      setEnroll(null);
      router.refresh();
    }
  }, [verifyState.ok, verifyState.submittedAt, router]);

  const verified = factors.filter((f) => f.status === "verified");

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-slate-900">
        Two-factor authentication
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Add a time-based one-time code (TOTP) from an authenticator app for an
        extra layer of security. Optional — your existing sign-in still works.
      </p>

      {loadError ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          We couldn&apos;t load your current authenticators just now. Reload the
          page — your existing security settings are unchanged.
        </div>
      ) : null}

      {verified.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {verified.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm"
            >
              <span className="text-slate-800">
                {f.friendlyName || "Authenticator app"}
                <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-800">
                  active
                </span>
              </span>
              <UnenrollButton factorId={f.id} onDone={() => router.refresh()} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-slate-500">No authenticator set up yet.</p>
      )}

      {enroll && enroll.ok ? (
        <div className="mt-5 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-800">
            Scan this QR code with your authenticator app
          </p>
          {/* qr_code is an SVG data URI returned by Supabase. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={enroll.qrCode}
            alt="TOTP QR code"
            className="h-44 w-44 rounded bg-white p-2"
          />
          <p className="text-xs text-slate-600">
            Or enter this code manually:{" "}
            <code className="rounded bg-white px-1.5 py-0.5 font-mono text-slate-800">
              {enroll.secret}
            </code>
          </p>

          <form action={verifyAction} noValidate className="space-y-2">
            <input type="hidden" name="factorId" value={enroll.factorId} />
            {verifyState.error ? (
              <p className="text-sm text-red-600" role="alert">
                {verifyState.error}
              </p>
            ) : null}
            <label
              htmlFor="enroll-code"
              className="block text-sm font-medium text-slate-700"
            >
              Enter the 6-digit code to confirm
            </label>
            <input
              id="enroll-code"
              name="code"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              placeholder="123456"
              className="block w-40 rounded-md border border-slate-300 px-3 py-2 text-center tracking-[0.3em] focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
            {verifyState.fieldErrors?.code ? (
              <p className="text-xs text-red-600">{verifyState.fieldErrors.code}</p>
            ) : null}
            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                <Pending idle="Confirm" busy="Confirming…" />
              </button>
              <button
                type="button"
                onClick={() => setEnroll(null)}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="mt-4">
          {enroll && !enroll.ok ? (
            <p className="mb-2 text-sm text-red-600" role="alert">
              {enroll.error}
            </p>
          ) : null}
          <button
            type="button"
            disabled={starting}
            onClick={() =>
              startEnroll(async () => {
                const res = await enrollTotp();
                setEnroll(res);
              })
            }
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50 disabled:opacity-60"
          >
            {starting ? "Starting…" : "Set up authenticator app"}
          </button>
        </div>
      )}
    </section>
  );
}

function UnenrollButton({
  factorId,
  onDone,
}: {
  factorId: string;
  onDone: () => void;
}) {
  const [state, action] = useActionState(unenrollFactor, INITIAL_FORM_STATE);
  useEffect(() => {
    if (state.ok) onDone();
  }, [state.ok, state.submittedAt, onDone]);
  return (
    <form action={action}>
      <input type="hidden" name="factorId" value={factorId} />
      <button
        type="submit"
        className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
      >
        <Pending idle="Remove" busy="Removing…" />
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// OAuth identity linking (config-gated)
// ---------------------------------------------------------------------------

export function LinkingSection({
  identities,
  googleEnabled,
  microsoftEnabled,
}: {
  identities: IdentityView[];
  googleEnabled: boolean;
  microsoftEnabled: boolean;
}) {
  const linked = new Set(identities.map((i) => i.provider));
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-slate-900">Linked sign-in methods</h2>
      <p className="mt-1 text-sm text-slate-600">
        Connect another provider so you can sign in with it too.
      </p>

      <ul className="mt-4 space-y-2 text-sm">
        {["email", "google", "azure"].map((p) => (
          <li
            key={p}
            className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2"
          >
            <span className="capitalize text-slate-800">
              {p === "azure" ? "Microsoft" : p}
            </span>
            {linked.has(p) ? (
              <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                connected
              </span>
            ) : p === "google" && googleEnabled ? (
              <form action={linkGoogleIdentity}>
                <button className="text-xs font-medium text-slate-700 underline">
                  Link Google
                </button>
              </form>
            ) : p === "azure" && microsoftEnabled ? (
              <form action={linkMicrosoftIdentity}>
                <button className="text-xs font-medium text-slate-700 underline">
                  Link Microsoft
                </button>
              </form>
            ) : (
              <span className="text-xs text-slate-400">not connected</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
