import { test, expect, type Page } from "@playwright/test";

/**
 * OFFLINE WRITE QUEUE — the real-offline journey, no mocks.
 *
 * Proves the sentence the feature exists to make true: a foreman with NO signal can
 * write today's diary entry, it is held on the device, and when signal returns it
 * reaches CrewFlow EXACTLY ONCE.
 *
 * ── Why this spec does NOT enable the service worker ─────────────────────────
 * e2e/pwa-offline.spec.ts opts into `serviceWorkers: "allow"` because it tests a
 * COLD, no-network launch, which only the worker can serve. This feature does not
 * depend on the worker at all: the page is already loaded and hydrated when signal
 * is lost (van → basement), the form writes to IndexedDB, and the outbox posts when
 * the network returns. Enabling the worker here would only import its one-time
 * claim-and-reload race (documented in playwright.config.ts) into a spec that gains
 * nothing from it. Cold-launch offline AUTHORING is deliberately not built — see
 * docs/offline-write-queue.md.
 *
 * ── Going genuinely offline ──────────────────────────────────────────────────
 * The lesson from the PWA work still applies: `context.setOffline(true)` alone cuts
 * the page thread but leaves other threads reaching the network, so both are used —
 * `setOffline(true)` (which also flips `navigator.onLine`, the signal the form reads)
 * PLUS `context.route("**\/*", abort)` so nothing can be fetched at all.
 *
 * Every wait below is on a deterministic condition the app asserts about itself
 * (`[data-offline-notice]`, `[data-offline-queued]`, `[data-outbox-synced]`), never a
 * sleep: the notice appearing is simultaneous proof that React has hydrated AND that
 * the client believes it is offline.
 */

const OUTBOX_DB = "crewflow-offline-writes";

/** Cut BOTH threads. Returns the un-route handle so the caller can restore it. */
async function goOffline(page: Page) {
  const kill = (r: import("@playwright/test").Route) =>
    r.abort("internetdisconnected");
  await page.context().setOffline(true);
  await page.context().route("**/*", kill);
  return async () => {
    await page.context().unroute("**/*", kill);
    await page.context().setOffline(false);
  };
}

/** How many items the outbox is holding on this device, read from IndexedDB itself. */
function queueCount(page: Page): Promise<number> {
  return page.evaluate(async (name) => {
    const dbs = await indexedDB.databases?.();
    if (dbs && !dbs.some((d) => d.name === name)) return 0;
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const n = await new Promise<number>((res) => {
      const c = db.transaction("outbox").objectStore("outbox").count();
      c.onsuccess = () => res(c.result);
      c.onerror = () => res(0);
    });
    db.close();
    return n;
  }, OUTBOX_DB);
}

/** The one stored item, so a replay can be reconstructed byte-for-byte. */
function readQueue(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(async (name) => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise<Record<string, unknown>[]>((res) => {
      const g = db.transaction("outbox").objectStore("outbox").getAll();
      g.onsuccess = () => res(g.result as Record<string, unknown>[]);
      g.onerror = () => res([]);
    });
    db.close();
    return rows;
  }, OUTBOX_DB);
}

/**
 * Block ONLY the queue's sync request, leaving every other request (including the
 * sign-out POST) working. Server actions post to the current route, so they cannot be
 * told apart by URL — but the sync request is the one carrying the diary text, so the
 * marker in its body identifies it precisely. This lets a test hold an entry in the
 * "written but not yet accepted" state without sleeping or racing the flush.
 */
async function blockSyncOf(page: Page, marker: string) {
  const block = (route: import("@playwright/test").Route) => {
    const req = route.request();
    if (req.method() === "POST" && (req.postData() ?? "").includes(marker)) {
      return route.abort("internetdisconnected");
    }
    return route.continue();
  };
  await page.context().route("**/*", block);
  return async () => {
    await page.context().unroute("**/*", block);
  };
}

async function fillDiary(page: Page, summary: string) {
  await page.locator("#entry_date").fill("2026-07-30");
  await page.locator("#weather").fill("Dry am, heavy rain pm");
  await page.locator("#labour_count").fill("4");
  await page.locator("#work_summary").fill(summary);
}

test.describe("offline diary queue — author with no signal, sync exactly once", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test("offline → queued on device → back online → synced ONCE", async ({ page }) => {
    const marker = `OFFLINE-QUEUE-${Date.now()}`;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      // The test genuinely cuts the network, so Chromium logs load failures for
      // whatever Next had in flight. Those are the point, not a defect.
      if (/ERR_FAILED|ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch/.test(t))
        return;
      errors.push(t);
    });

    // 1. Load the form WITH a connection (the van), and start from a clean device.
    await page.goto("/diary/new");
    await expect(page.getByRole("heading", { name: "New diary entry" })).toBeVisible();
    expect(await queueCount(page), "device starts with an empty outbox").toBe(0);

    // 2. Lose signal (the basement). The form's own notice appearing proves React is
    //    hydrated AND that the client has noticed — no sleep, no guess.
    const restore = await goOffline(page);
    await expect(page.locator("[data-offline-notice]")).toBeVisible();
    await expect(page.locator("[data-offline-notice]")).toContainText("No signal");

    // 3. Write the day and save. The button says what will actually happen.
    await fillDiary(page, marker);
    await expect(
      page.getByRole("button", { name: "Save on this device" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save on this device" }).click();

    // 4. HONEST STATE: "Saved on this device" — never a bare tick.
    const queued = page.locator("[data-offline-queued]");
    await expect(queued).toBeVisible();
    await expect(queued).toContainText("Saved on this device");
    await expect(queued).toContainText("Not sent yet");

    // 5. It really is in IndexedDB, with an idempotency key, not just a UI flag.
    expect(await queueCount(page), "one item held on the device").toBe(1);
    const [stored] = await readQueue(page);
    expect(String(stored?.clientKey ?? ""), "a client-generated key is persisted")
      .toMatch(/^[0-9a-f-]{36}$/);
    expect(stored?.status).toBe("pending");
    expect(JSON.stringify(stored)).toContain(marker);

    // 6. The whole-app outbox strip says the same thing on every page.
    await expect(page.locator("[data-outbox]")).toHaveAttribute(
      "data-outbox-pending",
      "1",
    );

    // 7. Signal returns. The outbox drains itself — no user action required.
    await restore();
    await expect(page.locator("[data-outbox-synced]")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-outbox-synced]")).toContainText("synced");
    expect(await queueCount(page), "the device holds nothing once accepted").toBe(0);

    // 8. EXACTLY ONCE. The register shows one entry, not two.
    await page.goto("/diary");
    await expect(page.getByText(marker)).toHaveCount(1);

    expect(errors, `unexpected errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("a REPLAYED queued item still yields exactly one row (DB idempotency, in a browser)", async ({
    page,
  }) => {
    const marker = `OFFLINE-REPLAY-${Date.now()}`;

    // Author one entry offline and let it sync.
    await page.goto("/diary/new");
    const restore = await goOffline(page);
    await expect(page.locator("[data-offline-notice]")).toBeVisible();
    await fillDiary(page, marker);
    await page.getByRole("button", { name: "Save on this device" }).click();
    await expect(page.locator("[data-offline-queued]")).toBeVisible();
    const [original] = await readQueue(page);
    await restore();
    await expect(page.locator("[data-outbox-synced]")).toBeVisible({ timeout: 20_000 });
    await page.goto("/diary");
    await expect(page.getByText(marker)).toHaveCount(1);

    /**
     * Now do what a reinstalled service worker, a restored browser profile or a
     * second tab does: put the SAME item — same clientKey — back in the outbox and
     * let it flush again. Only the database's unique index can stop this becoming a
     * second diary entry; there is no JS state left that remembers the first send.
     */
    await page.evaluate(
      async ([name, item]) => {
        const db: IDBDatabase = await new Promise((res, rej) => {
          const r = indexedDB.open(name as string);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        await new Promise<void>((res, rej) => {
          const tx = db.transaction("outbox", "readwrite");
          tx.objectStore("outbox").put(item);
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
        db.close();
      },
      [OUTBOX_DB, original] as const,
    );
    expect(await queueCount(page), "the replay is staged").toBe(1);

    // A reload remounts the outbox, which drains on mount.
    await page.reload();
    await expect
      .poll(() => queueCount(page), { timeout: 20_000 })
      .toBe(0); // reported "duplicate", so the item is done — not retried forever

    // THE ASSERTION: still ONE row. The replay was absorbed, not written.
    await page.goto("/diary");
    await expect(page.getByText(marker)).toHaveCount(1);
  });

  test("glove-usable at 375px: the offline form and outbox fit and are tappable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const marker = `OFFLINE-MOBILE-${Date.now()}`;
    await page.goto("/diary/new");
    const restore = await goOffline(page);
    await expect(page.locator("[data-offline-notice]")).toBeVisible();

    // No horizontal overflow on a phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the offline form must not scroll sideways at 375px").toBeLessThanOrEqual(1);

    const save = page.getByRole("button", { name: "Save on this device" });
    const box = await save.boundingBox();
    expect(box?.height ?? 0, "44px minimum touch target").toBeGreaterThanOrEqual(44);

    await fillDiary(page, marker);
    await save.click();
    await expect(page.locator("[data-offline-queued]")).toBeVisible();

    // The outbox controls are tappable too.
    for (const name of ["Show", "Sync now"]) {
      const b = page.locator("[data-outbox]").getByRole("button", { name });
      const bb = await b.boundingBox();
      expect(bb?.height ?? 0, `${name} touch target`).toBeGreaterThanOrEqual(44);
    }
    await restore();
    await expect(page.locator("[data-outbox-synced]")).toBeVisible({ timeout: 20_000 });
  });

  test("cancelling the sign-out warning keeps the user signed in and the entry intact", async ({
    page,
  }) => {
    const marker = `OFFLINE-KEEP-${Date.now()}`;
    await page.goto("/diary/new");
    const restore = await goOffline(page);
    await expect(page.locator("[data-offline-notice]")).toBeVisible();
    await fillDiary(page, marker);
    await page.getByRole("button", { name: "Save on this device" }).click();
    await expect(page.locator("[data-offline-queued]")).toBeVisible();

    // Come back online but keep this entry UNSENT, so the sign-out warning is reached
    // deterministically instead of racing the automatic flush. Only the sync POST is
    // blocked; the sign-out POST goes through normally.
    const unblockSync = await blockSyncOf(page, marker);
    await restore();
    await expect(page.locator("[data-outbox]")).toHaveAttribute(
      "data-outbox-pending",
      "1",
    );

    page.on("dialog", (d) => d.dismiss()); // "Cancel — let it sync first"
    await page.getByRole("button", { name: /Sign out/ }).click();

    // Still signed in, and the entry is still on the device: cancelling must neither
    // sign the user out nor purge their work.
    await expect(page).not.toHaveURL(/\/login/);
    expect(await queueCount(page), "cancel must not purge the entry").toBe(1);

    // Let it through — the entry the user chose to keep does reach CrewFlow, once.
    await unblockSync();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.locator("[data-outbox-synced]")).toBeVisible({ timeout: 20_000 });
    await page.goto("/diary");
    await expect(page.getByText(marker)).toHaveCount(1);
  });
});

test.describe("offline diary queue — shared-device gate (isolated session)", () => {
  // A SEPARATE seeded member, exactly as the blueprint logout-purge spec does:
  // signing THIS session out revokes only its own token, so the shared owner
  // session the other specs depend on survives.
  test.use({ storageState: "e2e/.auth/second.json" });

  test("Sign out WARNS about unsent work, then purges it from the device", async ({
    page,
  }) => {
    const marker = `OFFLINE-LOGOUT-${Date.now()}`;
    await page.goto("/diary/new");
    const restore = await goOffline(page);
    await expect(page.locator("[data-offline-notice]")).toBeVisible();
    await fillDiary(page, marker);
    await page.getByRole("button", { name: "Save on this device" }).click();
    await expect(page.locator("[data-offline-queued]")).toBeVisible();
    expect(await queueCount(page), "queued before logout").toBe(1);

    // The sign-out POST needs the network, but the entry must still be UNSENT when it
    // happens — that is the whole data-loss-versus-leak moment. So block only the sync
    // request, restore everything else, and hold until the outbox itself confirms the
    // item is still pending. Deterministic: no sleep, no racing the flush.
    await blockSyncOf(page, marker);
    await restore();
    await expect(page.locator("[data-outbox]")).toHaveAttribute(
      "data-outbox-pending",
      "1",
    );

    let warning = "";
    page.on("dialog", async (d) => {
      warning = d.message();
      await d.accept(); // the user chooses to sign out and lose it
    });
    await page.getByRole("button", { name: /Sign out/ }).click();
    await expect(page).toHaveURL(/\/login/);

    // The user was TOLD, with a number, before anything was destroyed.
    expect(warning, "sign-out must warn about unsent entries").toMatch(/not been sent/i);
    expect(warning).toMatch(/1 entry/);

    // And user A's unsent words are gone — the next person on this shared tablet
    // inherits nothing.
    expect(await queueCount(page), "outbox purged on logout").toBe(0);
  });

});
