/* eslint-disable @typescript-eslint/no-explicit-any -- read-back through a loose cast */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Regression: a tenant can raise a support ticket from /support/new.
 *
 * Found by the UI action exerciser (docs/programme/ui-coverage/): the create
 * action inserted a `body` key into `support_tickets`, a column that does not
 * exist. PostgREST rejects an unknown column (PGRST204), so EVERY ticket
 * creation failed and bounced back to the form with ?error=create_failed. The
 * opening text belongs in the first `support_messages` row, which is written
 * next — this spec asserts both rows.
 */
const SUBJECT = `E2E support ticket ${Date.now()}`;
const BODY = "E2E: the opening message must be stored as the first thread message.";

test.describe("raise a support ticket", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  const db = (): { from: (t: string) => any } => {
    assertLocalE2eTarget("support-ticket-create.spec.ts");
    return createClient(assertLocalE2eTarget("support-ticket-create.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as { from: (t: string) => any };
  };

  test.afterAll(async () => {
    const d = db();
    const t = (await d.from("support_tickets").select("id").eq("subject", SUBJECT)).data as { id: string }[] | null;
    for (const row of t ?? []) {
      await d.from("support_messages").delete().eq("ticket_id", row.id);
      await d.from("support_tickets").delete().eq("id", row.id);
    }
  });

  test("the ticket and its opening message are persisted, and the thread opens", async ({ page }) => {
    await page.goto("/support/new");
    await page.locator('[name="subject"]').fill(SUBJECT);
    await page.locator('[name="body"]').fill(BODY);
    await page.getByRole("button", { name: /submit ticket/i }).click();
    // success lands on the ticket thread, never back on the form with an error
    await expect(page).toHaveURL(/\/support\/[0-9a-f-]{36}/);
    await expect(page.getByText(BODY)).toBeVisible();

    const d = db();
    const ticket = (await d.from("support_tickets").select("id, status, subject").eq("subject", SUBJECT).maybeSingle()).data;
    expect(ticket, "support_tickets row").toBeTruthy();
    expect(ticket.status).toBe("open");
    const msgs = (await d.from("support_messages").select("body").eq("ticket_id", ticket.id)).data as { body: string }[];
    expect(msgs.map((m) => m.body)).toContain(BODY);
  });
});
