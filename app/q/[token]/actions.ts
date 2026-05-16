"use server";

import crypto from "node:crypto";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  acceptQuoteByToken,
  declineQuoteByToken,
} from "@/app/(app)/quotes/actions";
import { publicAcceptSchema, publicDeclineSchema } from "@/lib/quotes/schema";

/**
 * Public-portal accept / decline server actions.
 *
 * The caller is anonymous — we identify the quote by its public_token
 * (which is the URL slug). The downstream helpers in (app)/quotes/actions
 * use the service-role admin client to bypass RLS, so this layer is just
 * input validation + IP hashing + dispatch.
 *
 * IP hashing: simple SHA-256 with a salt sourced from SUPABASE_SERVICE_ROLE_KEY
 * (already a high-entropy secret on the server, never reaches the client).
 * The salted hash means leaking the DB can't reverse-engineer IPs, while
 * still letting us deduplicate signers if abuse becomes a concern later.
 */

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  const salt = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "fallback-salt";
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

function getIpFromHeaders(h: Headers): string | null {
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() ?? null;
  return h.get("x-real-ip") ?? null;
}

export async function publicAcceptQuote(token: string, formData: FormData) {
  const parsed = publicAcceptSchema.safeParse({
    signer_name: formData.get("signer_name") ?? "",
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid input";
    redirect(`/q/${token}?error=${encodeURIComponent(msg)}`);
  }

  const h = await headers();
  const ipHash = hashIp(getIpFromHeaders(h));

  const res = await acceptQuoteByToken(token, parsed.data.signer_name, ipHash);
  if (!res.ok) {
    redirect(`/q/${token}?error=${encodeURIComponent(res.error)}`);
  }
  redirect(`/q/${token}?saved=accepted`);
}

export async function publicDeclineQuote(token: string, formData: FormData) {
  const parsed = publicDeclineSchema.safeParse({
    reason: formData.get("reason") ?? "",
  });
  const reason = parsed.success ? parsed.data.reason ?? null : null;

  const res = await declineQuoteByToken(token, reason);
  if (!res.ok) {
    redirect(`/q/${token}?error=${encodeURIComponent(res.error)}`);
  }
  redirect(`/q/${token}?saved=declined`);
}
