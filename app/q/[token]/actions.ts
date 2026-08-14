"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  acceptQuoteByToken,
  declineQuoteByToken,
} from "@/app/(app)/quotes/actions";
import { publicAcceptSchema, publicDeclineSchema } from "@/lib/quotes/schema";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { hashIp, getIpFromHeaders } from "@/lib/security/ip-hash";

/**
 * Public-portal accept / decline server actions.
 *
 * The caller is anonymous — we identify the quote by its public_token
 * (which is the URL slug). The downstream helpers in (app)/quotes/actions
 * use the service-role admin client to bypass RLS, so this layer is just
 * input validation + IP hashing (see lib/security/ip-hash) + dispatch.
 */

export async function publicAcceptQuote(token: string, formData: FormData) {
  const parsed = publicAcceptSchema.safeParse({
    signer_name: formData.get("signer_name") ?? "",
    comment: formData.get("comment") ?? "",
    signature_data_url: formData.get("signature_data_url") ?? undefined,
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid input";
    redirect(`/q/${token}?error=${encodeURIComponent(msg)}`);
  }

  const h = await headers();
  const ip = getIpFromHeaders(h) ?? "anonymous";
  const rl = await consume("quote_action", ip, DEFAULT_LIMITS.quote_action);
  if (!rl.allowed) {
    redirect(
      `/q/${token}?error=${encodeURIComponent("Too many attempts. Please wait a few minutes and try again.")}`,
    );
  }
  const ipHash = hashIp(getIpFromHeaders(h));
  const userAgent = h.get("user-agent");

  const res = await acceptQuoteByToken(
    token,
    parsed.data.signer_name,
    ipHash,
    parsed.data.comment ?? null,
    userAgent,
    parsed.data.signature_data_url ?? null,
  );
  if (!res.ok) {
    redirect(`/q/${token}?error=${encodeURIComponent(res.error)}`);
  }
  redirect(`/q/${token}?saved=accepted`);
}

export async function publicDeclineQuote(token: string, formData: FormData) {
  const ip = getIpFromHeaders(await headers()) ?? "anonymous";
  const rl = await consume("quote_action", ip, DEFAULT_LIMITS.quote_action);
  if (!rl.allowed) {
    redirect(
      `/q/${token}?error=${encodeURIComponent("Too many attempts. Please wait a few minutes and try again.")}`,
    );
  }
  const parsed = publicDeclineSchema.safeParse({
    reason: formData.get("reason") ?? "",
    comment: formData.get("comment") ?? "",
  });
  const reason = parsed.success ? parsed.data.reason ?? null : null;
  const comment = parsed.success ? parsed.data.comment ?? null : null;

  const res = await declineQuoteByToken(token, reason, comment);
  if (!res.ok) {
    redirect(`/q/${token}?error=${encodeURIComponent(res.error)}`);
  }
  redirect(`/q/${token}?saved=declined`);
}
