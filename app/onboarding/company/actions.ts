"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { createOrgWithOwner } from "@/server/services/bootstrap-account";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnCustomerSignup } from "@/lib/notifications/events";
import { createAdminClient } from "@/lib/supabase/admin";

// Loose UK postcode regex — accepts most real UK formats with or without spaces.
const UK_POSTCODE = /^[A-Z]{1,2}[0-9R][0-9A-Z]?\s?[0-9][A-Z]{2}$/i;

const schema = z.object({
  name: z.string().trim().min(2, "Company name is too short").max(100),
  first_name: z.string().trim().min(1, "First name is required").max(50),
  phone: z.string().trim().min(7, "Mobile number looks too short").max(20),
  postcode: z
    .string()
    .trim()
    .regex(UK_POSTCODE, "Doesn't look like a UK postcode")
    .max(8),
  vat_number: z
    .string()
    .trim()
    .max(20)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

/**
 * Slug = lowercased name with non-alphanumerics replaced + a short random
 * suffix so two "Murphy Roofing" companies don't collide.
 */
function makeSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base || "crew"}-${suffix}`;
}

export async function createOrg(formData: FormData) {
  const user = await requireUser();

  const parsed = schema.safeParse({
    name: formData.get("name"),
    first_name: formData.get("first_name"),
    phone: formData.get("phone"),
    postcode: formData.get("postcode"),
    vat_number: formData.get("vat_number") ?? "",
  });

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]?.message ?? "Invalid input";
    redirect(`/onboarding/company?error=${encodeURIComponent(firstIssue)}`);
  }

  const { name, first_name, phone, postcode, vat_number } = parsed.data;

  try {
    const result = await createOrgWithOwner({
      userId: user.id,
      userEmail: user.email ?? null,
      name,
      slug: makeSlug(name),
      phone,
      vatNumber: vat_number ?? null,
      postcode,
    });

    // Patch the public.users row with their first name for UI greetings.
    const admin = createAdminClient();
    await admin
      .from("users")
      .update({ full_name: first_name })
      .eq("id", user.id);

    // Loud HQ notification: a new company just signed up.
    await emitNotifications(
      notifyOnCustomerSignup({
        org_id: result.orgId,
        org_name: name,
        owner_email: user.email ?? null,
      }),
    );
  } catch (e) {
    console.error("[onboarding/company] createOrg failed", e);
    redirect("/onboarding/company?error=create_failed");
  }

  revalidatePath("/dashboard", "layout");
  // First Impression Experience: send a brand-new org into the GUIDED setup (the existing
  // stepper) rather than a cold, empty dashboard — paired with the sample data seeded at org
  // creation, the first screen is a guided path through a populated, working product.
  redirect("/onboarding/setup");
}
