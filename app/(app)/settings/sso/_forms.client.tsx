"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  mintScimTokenAction,
  saveOidcConfigAction,
  saveSamlConfigAction,
  setScimEnabledAction,
  setSsoEnabledAction,
} from "./actions";

/**
 * /settings/sso client forms — the exact surface the existing admin server
 * actions expect (app/(app)/settings/sso/actions.ts). Every mutation calls one
 * of those actions and surfaces its {ok,error} result inline; the actions
 * themselves re-enforce the feature flag + owner/admin gate, so these forms
 * carry no authority of their own.
 *
 * Two deliberate UX consequences of the backend's design:
 *   • Saving a SAML/OIDC config always lands DISABLED — enabling is a separate,
 *     explicit second step (the per-org dark switch) once metadata is verified.
 *   • The SCIM token is shown EXACTLY ONCE after minting (it is stored hashed);
 *     the OIDC client secret is never echoed back into the form.
 */

const inputCls =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-300";
const labelCls = "mb-1 block text-xs font-medium text-slate-600";
const buttonCls =
  "rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";
const primaryButtonCls =
  "rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60";

function ResultNote({ result }: { result: { ok: boolean; error?: string } | null }) {
  if (!result) return null;
  return result.ok ? (
    <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
      Saved. The configuration is stored <strong>disabled</strong> — enable SSO
      below once you have verified the identity-provider details.
    </p>
  ) : (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      {result.error ?? "Something went wrong."}
    </p>
  );
}

// ── SAML ─────────────────────────────────────────────────────────────────────

export function SamlConfigForm({
  initial,
}: {
  initial: {
    idpEntityId: string;
    idpSsoUrl: string;
    idpX509Cert: string;
    nameIdFormat: string;
    spEntityId: string;
  } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const str = (k: string) => String(fd.get(k) ?? "").trim();
    startTransition(async () => {
      const res = await saveSamlConfigAction({
        idpEntityId: str("idpEntityId"),
        idpSsoUrl: str("idpSsoUrl"),
        idpX509Cert: str("idpX509Cert"),
        nameIdFormat: str("nameIdFormat"),
        spEntityId: str("spEntityId"),
      });
      setResult(res);
      if (res.ok) router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={labelCls}>IdP entity ID</span>
          <input
            name="idpEntityId"
            type="text"
            required
            defaultValue={initial?.idpEntityId ?? ""}
            placeholder="https://idp.example.com/metadata"
            className={inputCls}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className={labelCls}>IdP single sign-on URL (https)</span>
          <input
            name="idpSsoUrl"
            type="url"
            required
            defaultValue={initial?.idpSsoUrl ?? ""}
            placeholder="https://idp.example.com/sso/saml"
            className={inputCls}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className={labelCls}>IdP X.509 signing certificate (PEM)</span>
          <textarea
            name="idpX509Cert"
            required
            rows={5}
            defaultValue={initial?.idpX509Cert ?? ""}
            placeholder="-----BEGIN CERTIFICATE-----"
            className={`${inputCls} font-mono text-xs`}
          />
        </label>
        <label className="block">
          <span className={labelCls}>NameID format (optional)</span>
          <input
            name="nameIdFormat"
            type="text"
            defaultValue={initial?.nameIdFormat ?? ""}
            placeholder="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className={labelCls}>SP entity ID override (optional)</span>
          <input
            name="spEntityId"
            type="text"
            defaultValue={initial?.spEntityId ?? ""}
            placeholder="Leave blank to use the default shown above"
            className={inputCls}
          />
        </label>
      </div>
      <ResultNote result={result} />
      <button type="submit" disabled={pending} className={primaryButtonCls}>
        {pending ? "Saving…" : "Save SAML configuration"}
      </button>
    </form>
  );
}

// ── OIDC ─────────────────────────────────────────────────────────────────────

export function OidcConfigForm({
  initial,
}: {
  initial: { issuer: string; clientId: string; discoveryUrl: string } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const str = (k: string) => String(fd.get(k) ?? "").trim();
    startTransition(async () => {
      const res = await saveOidcConfigAction({
        issuer: str("issuer"),
        clientId: str("clientId"),
        clientSecret: str("clientSecret"),
        discoveryUrl: str("discoveryUrl"),
      });
      setResult(res);
      if (res.ok) router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelCls}>Issuer URL (https)</span>
          <input
            name="issuer"
            type="url"
            required
            defaultValue={initial?.issuer ?? ""}
            placeholder="https://login.example.com"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className={labelCls}>Client ID</span>
          <input
            name="clientId"
            type="text"
            required
            defaultValue={initial?.clientId ?? ""}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className={labelCls}>Client secret</span>
          <input
            name="clientSecret"
            type="password"
            required
            autoComplete="off"
            placeholder={initial ? "Enter again to update (never shown back)" : ""}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className={labelCls}>Discovery URL (optional)</span>
          <input
            name="discoveryUrl"
            type="url"
            defaultValue={initial?.discoveryUrl ?? ""}
            placeholder="https://login.example.com/.well-known/openid-configuration"
            className={inputCls}
          />
        </label>
      </div>
      <p className="text-[11px] text-slate-500">
        The client secret is encrypted before it is stored and is never shown
        back. Saving replaces the whole OIDC configuration.
      </p>
      <ResultNote result={result} />
      <button type="submit" disabled={pending} className={primaryButtonCls}>
        {pending ? "Saving…" : "Save OIDC configuration"}
      </button>
    </form>
  );
}

// ── Enable / disable SSO (the per-org dark switch) ───────────────────────────

export function SsoEnableToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(next: boolean) {
    startTransition(async () => {
      const res = await setSsoEnabledAction(next);
      setError(res.ok ? null : (res.error ?? "Could not update SSO."));
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {enabled ? (
        <button type="button" disabled={pending} onClick={() => toggle(false)} className={buttonCls}>
          {pending ? "Working…" : "Disable SSO"}
        </button>
      ) : (
        <button type="button" disabled={pending} onClick={() => toggle(true)} className={primaryButtonCls}>
          {pending ? "Working…" : "Enable SSO for this organisation"}
        </button>
      )}
      {error ? (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      ) : null}
    </div>
  );
}

// ── SCIM token + enable/disable ──────────────────────────────────────────────

export function ScimPanel({
  hasToken,
  tokenPrefix,
  enabled,
}: {
  hasToken: boolean;
  tokenPrefix: string | null;
  enabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mintedToken, setMintedToken] = useState<string | null>(null);

  function mint() {
    startTransition(async () => {
      const res = await mintScimTokenAction();
      if (res.ok && res.token) {
        setMintedToken(res.token);
        setError(null);
        router.refresh();
      } else {
        setError(res.error ?? "Could not mint a SCIM token.");
      }
    });
  }

  function toggle(next: boolean) {
    startTransition(async () => {
      const res = await setScimEnabledAction(next);
      setError(res.ok ? null : (res.error ?? "Could not update SCIM."));
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        {hasToken ? (
          <>
            Token minted{tokenPrefix ? <> · prefix <code className="text-slate-700">{tokenPrefix}…</code></> : null} ·
            provisioning is <strong>{enabled ? "enabled" : "disabled"}</strong>.
          </>
        ) : (
          "No SCIM token minted yet. Mint one, store it in your identity provider, then enable provisioning."
        )}
      </p>

      {mintedToken ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-semibold text-amber-900">
            Copy this token now — it is shown once and stored only as a hash.
          </p>
          <code className="mt-2 block overflow-x-auto rounded bg-white px-2 py-1.5 text-xs text-slate-900">
            {mintedToken}
          </code>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={pending} onClick={mint} className={buttonCls}>
          {pending ? "Working…" : hasToken ? "Rotate SCIM token" : "Mint SCIM token"}
        </button>
        {hasToken ? (
          enabled ? (
            <button type="button" disabled={pending} onClick={() => toggle(false)} className={buttonCls}>
              Disable provisioning
            </button>
          ) : (
            <button type="button" disabled={pending} onClick={() => toggle(true)} className={primaryButtonCls}>
              Enable provisioning
            </button>
          )
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
