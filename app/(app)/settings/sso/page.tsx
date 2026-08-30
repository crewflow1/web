import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { env } from "@/lib/env";
import { isEnterpriseSsoEnabled } from "@/lib/enterprise-sso/flag";
import { loadScimConfig, loadSsoConfig } from "@/lib/enterprise-sso/config";
import { acsUrl, oidcRedirectUri, spEntityId } from "@/lib/enterprise-sso/urls";
import { OidcConfigForm, SamlConfigForm, ScimPanel, SsoEnableToggle } from "./_forms.client";

/**
 * Settings → Single sign-on (SSO) — the ACTIVATION surface for the built-dark
 * enterprise SSO + SCIM capability. This page existed only as a directory of
 * server actions (actions.ts) with no page rendering them; this is that page.
 *
 * DARK STATE: while FEATURE_ENTERPRISE_SSO is off the page renders an HONEST
 * "not enabled" panel (matching the integrations page's dark-panel posture) —
 * it explains what the capability is and does NOT render config forms or
 * pretend anything is connectable. The server actions independently refuse
 * while dark, so nothing here can activate a provider.
 *
 * LIT STATE (flag on): owners/admins see connection status, the SAML/OIDC
 * config forms the actions expect, the per-org enable switch (configs are
 * created DISABLED — enabling is a deliberate second step), and SCIM token
 * management (token shown once, stored hashed). Non-admins get a read-only
 * note — the actions enforce the same gate server-side.
 */

export const dynamic = "force-dynamic";

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export default async function SsoSettingsPage() {
  const { ctx } = await requireOrgContext();
  const isAdmin = isAdminRole(ctx.membership.role);
  const featureOn = isEnterpriseSsoEnabled();

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-8">
      <header>
        <div className="flex items-center gap-3">
          <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-700">
            ← Settings
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Single sign-on (SSO)</h1>
        <p className="mt-1 text-sm text-slate-600">
          Let your team sign in through your company identity provider (SAML or
          OIDC), and provision accounts automatically with SCIM. Sign-in only
          ever maps to existing memberships by verified email — SSO never
          creates accounts by itself.
        </p>
      </header>

      {!featureOn ? (
        // ── HONEST DARK STATE ─────────────────────────────────────────────
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            Enterprise SSO isn&apos;t enabled for this workspace
          </h2>
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Enterprise SSO and SCIM provisioning activate only once the feature
            is switched on for your deployment — it is not switched on yet.
          </p>
          <div className="mt-4 space-y-2 text-sm text-slate-600">
            <p>When enabled, this page lets owners and admins:</p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
              <li>Connect a SAML 2.0 or OpenID Connect identity provider (Okta, Entra ID, Google Workspace…)</li>
              <li>Turn SSO on for this organisation once the metadata is verified</li>
              <li>Mint a SCIM bearer token so the identity provider can manage which existing members keep access</li>
            </ul>
            <p className="text-xs text-slate-500">
              Interested in enterprise SSO?{" "}
              <Link href="/support" className="font-medium text-slate-700 underline">
                Contact support
              </Link>{" "}
              and we&apos;ll help set it up.
            </p>
          </div>
        </section>
      ) : !isAdmin ? (
        <section className="rounded-md bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
          Only owners and admins can manage single sign-on. Ask an owner or
          admin to configure it.
        </section>
      ) : (
        <LitAdminSurface orgId={ctx.org.id} />
      )}
    </div>
  );
}

async function LitAdminSurface({ orgId }: { orgId: string }) {
  const [sso, scim] = await Promise.all([loadSsoConfig(orgId), loadScimConfig(orgId)]);
  const origin = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");

  return (
    <>
      {/* Status ---------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Connection status</h2>
        <p className="mt-2 text-sm">
          {sso ? (
            sso.enabled ? (
              <span className="inline-flex rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
                SSO enabled · {sso.protocol.toUpperCase()}
              </span>
            ) : (
              <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
                {sso.protocol.toUpperCase()} configured · not yet enabled
              </span>
            )
          ) : (
            <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
              Not configured
            </span>
          )}
        </p>
        {sso ? (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <SsoEnableToggle enabled={sso.enabled} />
            <p className="mt-2 text-[11px] text-slate-500">
              Configurations are saved disabled. Enabling switches sign-in
              enforcement on for this organisation — verify your identity
              provider details first.
            </p>
          </div>
        ) : null}
      </section>

      {/* Service-provider endpoints -------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">
          Your CrewFlow endpoints
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Paste these into your identity provider when it asks for the service
          provider / relying party details.
        </p>
        <dl className="mt-4 space-y-3 text-xs">
          <div>
            <dt className="font-medium text-slate-600">SAML SP entity ID / metadata</dt>
            <dd className="mt-0.5 overflow-x-auto rounded bg-slate-50 px-2 py-1.5 font-mono text-slate-800">
              {spEntityId(origin, orgId)}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-slate-600">SAML ACS (reply) URL</dt>
            <dd className="mt-0.5 overflow-x-auto rounded bg-slate-50 px-2 py-1.5 font-mono text-slate-800">
              {acsUrl(origin, orgId)}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-slate-600">OIDC redirect URI</dt>
            <dd className="mt-0.5 overflow-x-auto rounded bg-slate-50 px-2 py-1.5 font-mono text-slate-800">
              {oidcRedirectUri(origin, orgId)}
            </dd>
          </div>
        </dl>
      </section>

      {/* SAML ------------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">SAML 2.0</h2>
        <p className="mt-1 text-xs text-slate-500">
          Saving a SAML configuration replaces any OIDC configuration — one
          protocol is live per organisation.
        </p>
        <div className="mt-4">
          <SamlConfigForm
            initial={
              sso?.protocol === "saml"
                ? {
                    idpEntityId: sso.samlIdpEntityId ?? "",
                    idpSsoUrl: sso.samlIdpSsoUrl ?? "",
                    idpX509Cert: sso.samlIdpX509Cert ?? "",
                    nameIdFormat: sso.samlNameIdFormat ?? "",
                    spEntityId: sso.spEntityId ?? "",
                  }
                : null
            }
          />
        </div>
      </section>

      {/* OIDC ------------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">OpenID Connect</h2>
        <p className="mt-1 text-xs text-slate-500">
          Saving an OIDC configuration replaces any SAML configuration — one
          protocol is live per organisation.
        </p>
        <div className="mt-4">
          <OidcConfigForm
            initial={
              sso?.protocol === "oidc"
                ? {
                    issuer: sso.oidcIssuer ?? "",
                    clientId: sso.oidcClientId ?? "",
                    discoveryUrl: sso.oidcDiscoveryUrl ?? "",
                  }
                : null
            }
          />
        </div>
      </section>

      {/* SCIM ------------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">
          SCIM provisioning
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Give your identity provider a bearer token so it can manage access
          for existing members. SCIM never creates CrewFlow accounts — an
          unmatched user is simply denied.
        </p>
        <div className="mt-4">
          <ScimPanel
            hasToken={scim != null}
            tokenPrefix={scim?.tokenPrefix ?? null}
            enabled={scim?.enabled ?? false}
          />
        </div>
      </section>
    </>
  );
}
