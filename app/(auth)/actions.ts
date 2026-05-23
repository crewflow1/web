"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

function getOrigin(headerList: Headers): string {
  const fromHeader = headerList.get("origin") ?? headerList.get("referer");
  if (fromHeader) {
    try {
      return new URL(fromHeader).origin;
    } catch {
      // fall through to env
    }
  }
  return env.NEXT_PUBLIC_APP_URL;
}

/**
 * Begin a Google OAuth flow.
 *
 * Returns a redirect to Google's consent screen. After the user accepts,
 * Google bounces back to Supabase, which bounces back to our /auth/callback.
 */
export async function signInWithGoogle() {
  const supabase = await createClient();
  const origin = getOrigin(await headers());

  // No hardcoded `?next=` — the auth callback already picks the
  // correct landing per role (super-admins → /admin/organizations,
  // everyone else → /dashboard). A hardcoded next pointing at the
  // contractor dashboard would override the super-admin fallback
  // and silently route the CEO into a tenant workspace.
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback`,
      queryParams: {
        prompt: "select_account",
      },
    },
  });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  if (data?.url) {
    redirect(data.url);
  }

  // Defensive: Supabase returned neither an error nor a URL. Don't leave the
  // form silently broken — surface it so the user can retry.
  redirect("/login?error=oauth_no_url");
}

const magicLinkSchema = z.object({
  email: z.string().email().max(254),
});

/**
 * Send a magic-link sign-in email.
 *
 * Supabase generates a one-time code, emails it to the user, and on click
 * redirects to /auth/callback?code=... which exchanges for a session.
 */
export async function signInWithMagicLink(formData: FormData) {
  const parsed = magicLinkSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    redirect("/login?error=invalid_email");
  }

  const supabase = await createClient();
  const origin = getOrigin(await headers());

  // No hardcoded `?next=` — see signInWithGoogle above.
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      shouldCreateUser: true,
    },
  });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  redirect(`/check-email?email=${encodeURIComponent(parsed.data.email)}`);
}

/**
 * Sign the user out, clear session cookies, and bounce to /login.
 */
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
