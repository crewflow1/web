import { afterAll, beforeAll, expect, it } from "vitest";
import {
  describeIntegration,
  serviceClient,
} from "../_harness";

/**
 * CALENDAR SYNC — the cron/webhook write mechanics against real Postgres
 * (20261138 tables), exercising the REAL token-store writers the sync tick and
 * the webhook→pull path use:
 *
 *   1. upsertPulledEvents is IDEMPOTENT on (connection, external event id): a
 *      re-pull of the same provider event UPDATES the one row (never a
 *      duplicate), so a watch notification and the periodic reconciliation can
 *      both deliver the same event safely.
 *   2. upsertWatchChannel keeps ONE channel row per connection: a watch RENEWAL
 *      (re-registration under a fresh channel id) replaces the row in place —
 *      the claim the cron's renewal loop relies on.
 *   3. updateWatchSyncState advances the incremental cursor without touching
 *      the verification secret.
 *
 * Uses the service-role writers directly (they are service-role by design: the
 * webhook and the cron have no user session). Fixtures torn down via org cascade.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Ins;
  single(): PromiseLike<Res<Row>>;
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-calsync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// The token-store encrypts the watch verification secret before write.
process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString("base64");

describeIntegration("calendar sync · pulled-event + watch-channel idempotency", () => {
  let orgId = "";
  let connectionId = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    const org = await svc
      .from("organizations")
      .insert({ name: "CalSync", slug: `${TOKEN}-org` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id ?? "");

    const conn = await svc
      .from("calendar_connections")
      .insert({
        org_id: orgId,
        provider: "google",
        status: "connected",
        external_account_id: "boss@acme.test",
      })
      .select("id")
      .single();
    expect(conn.error, conn.error?.message).toBeNull();
    connectionId = String(conn.data?.id ?? "");
    if (!orgId || !connectionId) throw new Error("fixture setup failed");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgId) await svc.from("organizations").delete().eq("id", orgId);
  });

  const EVENT = {
    externalEventId: "evt-idem-1",
    icalUid: null,
    summary: "Dentist",
    location: null,
    startsAt: "2026-09-01T09:00:00Z",
    endsAt: "2026-09-01T10:00:00Z",
    isAllDay: false,
    status: "confirmed",
    isBusy: true,
    etag: "e1",
    providerUpdatedAt: "2026-08-30T00:00:00Z",
    isCrewflowOrigin: false,
  };

  it("re-pulling the SAME external event UPDATES one row — never a duplicate", async () => {
    const { upsertPulledEvents } = await import("@/lib/integrations/calendar/token-store");

    await upsertPulledEvents(orgId, connectionId, [EVENT]);
    // Second delivery of the same event (e.g. webhook + periodic reconciliation)
    // with changed content.
    await upsertPulledEvents(orgId, connectionId, [
      { ...EVENT, summary: "Dentist (moved)", etag: "e2" },
    ]);

    const rows = await db(serviceClient())
      .from("calendar_pulled_events")
      .select("external_event_id, summary, etag")
      .eq("connection_id", connectionId)
      .eq("external_event_id", EVENT.externalEventId);
    expect(rows.error, rows.error?.message).toBeNull();
    expect(rows.data).toHaveLength(1);
    expect(rows.data?.[0]?.summary).toBe("Dentist (moved)");
    expect(rows.data?.[0]?.etag).toBe("e2");
  });

  it("watch RENEWAL keeps one channel row per connection (replaced in place)", async () => {
    const { upsertWatchChannel, readWatchChannel } = await import(
      "@/lib/integrations/calendar/token-store"
    );

    await upsertWatchChannel({
      orgId,
      connectionId,
      provider: "google",
      channelId: `${TOKEN}-chan-1`,
      resourceId: "res-1",
      verificationToken: "secret-1",
      expiration: "2026-09-03T00:00:00Z",
      syncToken: "cursor-1",
    });
    // The renewal: a FRESH channel id + secret for the same connection.
    await upsertWatchChannel({
      orgId,
      connectionId,
      provider: "google",
      channelId: `${TOKEN}-chan-2`,
      resourceId: "res-2",
      verificationToken: "secret-2",
      expiration: "2026-09-06T00:00:00Z",
    });

    const rows = await db(serviceClient())
      .from("calendar_watch_channels")
      .select("channel_id, expiration, sync_token")
      .eq("connection_id", connectionId);
    expect(rows.error, rows.error?.message).toBeNull();
    expect(rows.data).toHaveLength(1);
    expect(rows.data?.[0]?.channel_id).toBe(`${TOKEN}-chan-2`);

    // And the stored row resolves through the same reader the composer uses.
    const watch = await readWatchChannel(orgId, connectionId);
    expect(watch?.channelId).toBe(`${TOKEN}-chan-2`);
  });

  it("the incremental cursor advances without touching the verification secret", async () => {
    const { updateWatchSyncState, readWatchChannel } = await import(
      "@/lib/integrations/calendar/token-store"
    );
    const before = await readWatchChannel(orgId, connectionId);
    expect(before).not.toBeNull();

    await updateWatchSyncState(orgId, connectionId, { syncToken: "cursor-9", status: "active" });

    const after = await readWatchChannel(orgId, connectionId);
    expect(after?.syncToken).toBe("cursor-9");
    expect(after?.verificationToken).toBe(before?.verificationToken);
  });
});
