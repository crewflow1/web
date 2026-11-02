import { z } from "zod";
import { DEMO_LIFECYCLE_STATUSES } from "@/lib/hq/demo-lifecycle";

/**
 * Form contract for demo status transitions (kanban drag + detail-panel buttons).
 *
 * Kept OUT of the `"use server"` actions module so the pure parse is unit-testable
 * (a server-action file may only export async functions). Regression coverage:
 * `__tests__/admin/demo-move-form.test.ts`.
 */
export const moveSchema = z.object({
  demo_id: z.string().uuid(),
  status: z.enum(DEMO_LIFECYCLE_STATUSES),
  reason: z.string().trim().max(2000).optional(),
  // Explicit confirmation token for the one irreversible/outbound transition:
  // moving to active_onboarding provisions a REAL auth user + org + membership
  // and emails a magic-link invite. The UI must send confirm="ONBOARD"; without
  // it we show a confirm interstitial and provision nothing. This makes a stray
  // kanban drag or a direct POST unable to create a customer by accident.
  confirm: z.string().optional(),
});

/** The typed token the onboarding confirm interstitial must submit. */
export const ONBOARD_CONFIRM_TOKEN = "ONBOARD";

/**
 * Map the move-demo form fields onto {@link moveSchema}.
 *
 * The onboarding confirm interstitial (`_detail-panel.tsx`) submits a hidden
 * `confirm="ONBOARD"`, and this MUST read it — otherwise the provisioning gate in
 * `moveDemoToStatus` can never be satisfied from the detail panel and a confirmed
 * demo bounces to the interstitial forever, never provisioning a workspace.
 */
export function parseMoveDemoFormData(formData: FormData) {
  return moveSchema.safeParse({
    demo_id: formData.get("demo_id"),
    status: formData.get("status"),
    reason: formData.get("reason") ?? "",
    confirm: formData.get("confirm") ?? undefined,
  });
}
