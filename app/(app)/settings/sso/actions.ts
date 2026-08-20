"use server";

import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import { isEnterpriseSsoEnabled } from "@/lib/enterprise-sso/flag";
import {
  mintScimToken,
  setScimEnabled,
  setSsoEnabled,
  upsertOidcConfig,
  upsertSamlConfig,
} from "@/lib/enterprise-sso/admin";

/**
 * /settings/sso admin server actions — the ACTIVATION surface for enterprise
 * SSO + SCIM.
 *
 * DARK: every action refuses while FEATURE_ENTERPRISE_SSO is off. Every action
 * requires an owner/admin of the ACTIVE org; writes are pinned to that org via
 * the service-role writers in lib/enterprise-sso/admin.ts (there is no
 * tenant-writable RLS policy). Configs are created DISABLED — a deliberate
 * second step flips the per-org dark switch after the admin verifies metadata.
 */

const FEATURE_OFF = "Enterprise SSO isn't available yet.";
const NOT_ADMIN = "Only owners and admins can manage SSO.";

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

async function adminGate() {
  if (!isEnterpriseSsoEnabled()) return { error: FEATURE_OFF };
  const { user, ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) return { error: NOT_ADMIN };
  return { orgId: ctx.membership.org_id, userId: user.id };
}

const samlSchema = z.object({
  idpEntityId: z.string().trim().min(1).max(1024),
  idpSsoUrl: z.string().trim().url().startsWith("https://").max(2048),
  idpX509Cert: z.string().trim().min(1).max(20000),
  nameIdFormat: z.string().trim().max(256).optional().or(z.literal("")),
  spEntityId: z.string().trim().max(1024).optional().or(z.literal("")),
});

export async function saveSamlConfigAction(
  input: z.infer<typeof samlSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const gate = await adminGate();
  if ("error" in gate) return { ok: false, error: gate.error };
  const parsed = samlSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid SAML configuration." };
  const v = parsed.data;
  return upsertSamlConfig(gate.orgId, gate.userId, {
    idpEntityId: v.idpEntityId,
    idpSsoUrl: v.idpSsoUrl,
    idpX509Cert: v.idpX509Cert,
    nameIdFormat: v.nameIdFormat || null,
    spEntityId: v.spEntityId || null,
  });
}

const oidcSchema = z.object({
  issuer: z.string().trim().url().startsWith("https://").max(2048),
  clientId: z.string().trim().min(1).max(1024),
  clientSecret: z.string().trim().min(1).max(4096),
  discoveryUrl: z.string().trim().url().startsWith("https://").max(2048).optional().or(z.literal("")),
});

export async function saveOidcConfigAction(
  input: z.infer<typeof oidcSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const gate = await adminGate();
  if ("error" in gate) return { ok: false, error: gate.error };
  const parsed = oidcSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid OIDC configuration." };
  const v = parsed.data;
  return upsertOidcConfig(gate.orgId, gate.userId, {
    issuer: v.issuer,
    clientId: v.clientId,
    clientSecret: v.clientSecret,
    discoveryUrl: v.discoveryUrl || null,
  });
}

export async function setSsoEnabledAction(
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const gate = await adminGate();
  if ("error" in gate) return { ok: false, error: gate.error };
  return setSsoEnabled(gate.orgId, enabled);
}

export async function mintScimTokenAction(): Promise<{
  ok: boolean;
  token?: string;
  error?: string;
}> {
  const gate = await adminGate();
  if ("error" in gate) return { ok: false, error: gate.error };
  return mintScimToken(gate.orgId, gate.userId);
}

export async function setScimEnabledAction(
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const gate = await adminGate();
  if ("error" in gate) return { ok: false, error: gate.error };
  return setScimEnabled(gate.orgId, enabled);
}
