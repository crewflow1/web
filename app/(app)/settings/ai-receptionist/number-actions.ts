"use server";

import { revalidatePath } from "next/cache";
import { env } from "@/lib/env";
import { requireOrgContext } from "@/server/auth/session";
import { type FormState, formError, formSuccess } from "@/lib/forms/state";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  getNumberPricing,
  provisionNumber,
  searchAvailableNumbers,
  type AvailableNumber,
  type NumberPricing,
  type UkNumberType,
} from "@/lib/telephony/provisioning";

/**
 * Number ONBOARDING server actions (Twilio receptionist PR 5).
 *
 * The owner/admin-facing wrapper around the PR 4 provisioning service:
 *   - searchNumbersAction  — read-only UK inventory search + live pricing.
 *   - requestNewNumberAction — Option B: buy a new Twilio number (approval-gated
 *     in the service; dark without credentials → an honest "noted" state).
 *   - setupForwardingAction  — Option A: keep your number, provision a dedicated
 *     Twilio RECEIVING number you forward to.
 *
 * Every action is org-pinned via ctx.org.id (never a client-supplied org) and
 * owner/admin-only, mirroring saveAiReceptionistSetup in the same folder. The
 * provisioning service itself refuses a real purchase unless Twilio credentials
 * are resolvable, so until a founder connects Twilio these actions capture the
 * intent honestly and never imply a number was bought.
 */

type Values = Record<string, unknown>;

/** Strict E.164 — the only number shape we accept / forward to. */
const E164 = /^\+[1-9]\d{6,14}$/;
function toE164(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[\s()\-.]/g, "").trim();
  return E164.test(cleaned) ? cleaned : null;
}

function asType(v: FormDataEntryValue | null): UkNumberType {
  const s = (v ?? "").toString();
  return s === "national" || s === "mobile" || s === "tollfree" ? s : "local";
}

async function requireAdmin() {
  const { ctx, user } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  return { ctx, user, isAdmin };
}

export type NumberSearchResult = {
  ok: boolean;
  error?: string;
  numbers: AvailableNumber[];
  pricing: NumberPricing | null;
};

/** Read-only: search the UK inventory + live pricing. Safe + non-billable. */
export async function searchNumbersAction(formData: FormData): Promise<NumberSearchResult> {
  const { isAdmin } = await requireAdmin();
  if (!isAdmin) {
    return { ok: false, error: "Only owners and admins can manage phone numbers.", numbers: [], pricing: null };
  }
  const type = asType(formData.get("type"));
  const areaCode = (formData.get("area_code") ?? "").toString().trim() || undefined;
  const contains = (formData.get("contains") ?? "").toString().trim() || undefined;

  const [numbers, pricing] = await Promise.all([
    searchAvailableNumbers({ country: "GB", type, areaCode, contains, limit: 10 }),
    getNumberPricing("GB"),
  ]);
  return { ok: true, numbers, pricing };
}

/**
 * Option B — request/buy a new Twilio number. The service is approval-gated and
 * credential-gated; without Twilio connected it returns `no_credentials`, which
 * we surface as an honest "noted, pending activation" state rather than a buy.
 */
export async function requestNewNumberAction(
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user, isAdmin } = await requireAdmin();
  if (!isAdmin) return formError("Only owners and admins can manage phone numbers.");

  const e164 = toE164(formData.get("e164")?.toString());
  if (!e164) return formError("Pick a number to request.");
  const type = asType(formData.get("type"));
  const monthlyCostPence = (() => {
    const n = Number.parseInt((formData.get("monthly_cost_pence") ?? "").toString(), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  })();

  const result = await provisionNumber({
    orgId: ctx.org.id,
    e164,
    type,
    appBaseUrl: env.NEXT_PUBLIC_APP_URL,
    approved: true,
    monthlyCostPence,
    createdBy: user.id,
    label: `CrewFlow receptionist (${type})`,
  });

  if (!result.ok) {
    if (result.reason === "no_credentials") {
      return formError(
        "Twilio isn't connected yet — your request for this number is noted. We'll provision it as soon as Twilio is activated.",
        { e164, type },
      );
    }
    return formError(result.error || "Couldn't request that number. Try again.", { e164, type });
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "ai_receptionist.number_provisioned",
    targetTable: "phone_numbers",
    targetId: result.phoneNumberId,
    metadata: { org_id: ctx.org.id, e164: result.e164, type, onboarding_mode: "new_number" },
  });

  revalidatePath("/settings/ai-receptionist");
  return formSuccess({
    successMessage: `${result.e164} is now yours and wired to the AI receptionist.`,
  });
}

/**
 * Option A — keep your existing number. We provision a dedicated Twilio RECEIVING
 * number (so forwarded calls reliably identify your org) and record your original
 * number as the forwarding source. The customer then forwards their line to the
 * receiving number (instructions shown in the UI). Credential-gated like Option B.
 */
export async function setupForwardingAction(
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user, isAdmin } = await requireAdmin();
  if (!isAdmin) return formError("Only owners and admins can manage phone numbers.");

  const forwardingFrom = toE164(formData.get("forwarding_from")?.toString());
  if (!forwardingFrom) {
    return formError(
      "Enter your current business number in international format, e.g. +447700900123.",
      { forwarding_from: formData.get("forwarding_from")?.toString() ?? "" },
    );
  }

  // A receiving number must be provisioned for forwarding to land in this org.
  // Search one (read-only); without Twilio credentials the inventory is empty.
  const candidates = await searchAvailableNumbers({ country: "GB", type: "local", limit: 1 });
  const receiver = candidates[0];
  if (!receiver) {
    return formError(
      "Twilio isn't connected yet — your forwarding setup is noted. We'll provision a receiving number and send you the forwarding code once Twilio is activated.",
      { forwarding_from: forwardingFrom },
    );
  }

  const result = await provisionNumber({
    orgId: ctx.org.id,
    e164: receiver.e164,
    type: "local",
    appBaseUrl: env.NEXT_PUBLIC_APP_URL,
    approved: true,
    onboardingMode: "existing_number_forward",
    forwardingFrom,
    createdBy: user.id,
    label: `CrewFlow forwarding receiver for ${forwardingFrom}`,
  });

  if (!result.ok) {
    if (result.reason === "no_credentials") {
      return formError(
        "Twilio isn't connected yet — your forwarding setup is noted. We'll provision a receiving number once Twilio is activated.",
        { forwarding_from: forwardingFrom },
      );
    }
    return formError(result.error || "Couldn't set up forwarding. Try again.", {
      forwarding_from: forwardingFrom,
    });
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "ai_receptionist.forwarding_configured",
    targetTable: "phone_numbers",
    targetId: result.phoneNumberId,
    metadata: {
      org_id: ctx.org.id,
      receiver: result.e164,
      forwarding_from: forwardingFrom,
      onboarding_mode: "existing_number_forward",
    },
  });

  revalidatePath("/settings/ai-receptionist");
  return formSuccess({
    successMessage: `Your receiving number is ${result.e164}. Forward your line to it to go live.`,
    values: { receiver: result.e164 },
  });
}
