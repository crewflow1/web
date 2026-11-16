/**
 * Find-or-create a conversation by its natural key (org, channel, contact_ref).
 *
 * WHY NOT `upsert(..., { onConflict: "org_id,channel,contact_ref" })`: the only
 * unique index on that key is PARTIAL (`WHERE contact_ref IS NOT NULL`).
 * Postgres can only infer a partial index for ON CONFLICT when the statement
 * repeats the predicate, which PostgREST cannot express — so the upsert failed
 * with 42P10 on EVERY call and no conversation could ever be started (inbox
 * "new conversation" and customer-portal chat).
 *
 * Race safety: two concurrent starts both miss the SELECT; one INSERT wins, the
 * other violates the partial unique index (23505) and re-selects the winner. So
 * exactly one conversation exists per key and both callers get its id.
 */
type Row = { id: string };
type Err = { message: string; code?: string } | null;
type Chain = {
  select: (cols: string) => Chain;
  eq: (k: string, v: unknown) => Chain;
  maybeSingle: () => Promise<{ data: Row | null; error: Err }>;
  single: () => Promise<{ data: Row | null; error: Err }>;
  insert: (row: unknown) => Chain;
  update: (row: unknown) => Chain & PromiseLike<{ error: Err }>;
};
export type ConversationClient = { from: (table: string) => unknown };
export type ConversationKey = { org_id: string; channel: string; contact_ref: string };

export async function findOrCreateConversation(
  client: ConversationClient,
  key: ConversationKey,
  /** non-key columns: written on create, and refreshed on an existing thread (what the old upsert did). */
  fields: Record<string, unknown>,
): Promise<{ id: string; created: boolean } | { error: { message: string; code?: string } }> {
  const table = (): Chain => client.from("conversations") as Chain;
  const find = (): Promise<{ data: Row | null; error: Err }> =>
    table().select("id").eq("org_id", key.org_id).eq("channel", key.channel).eq("contact_ref", key.contact_ref).maybeSingle();

  const existing = await find();
  if (existing.error) return { error: existing.error };
  let id = existing.data?.id ?? null;
  let created = false;
  if (!id) {
    const ins = await table().insert({ ...key, ...fields }).select("id").single();
    if (ins.data?.id) {
      id = ins.data.id;
      created = true;
    } else if (ins.error?.code === "23505") {
      const again = await find(); // lost the race: the winner's row is the thread
      if (again.error || !again.data) return { error: again.error ?? { message: "conversation vanished after a unique violation" } };
      id = again.data.id;
    } else return { error: ins.error ?? { message: "conversation insert returned no row" } };
  }
  if (!created) {
    const upd = await (table().update(fields).eq("id", id).eq("org_id", key.org_id) as unknown as PromiseLike<{ error: Err }>);
    if (upd.error) return { error: upd.error };
  }
  return { id, created };
}
