# CrewFlow — WhatsApp AI Assistant Release Inventory & Directive-to-Main Plan
**Directive #018 R6 — Controlled Live Execution · Documentation & Release Engineer (Part 21)**
Read-only analysis. Worktree `/Users/moetalibi/Code/web-impl` @ `feat/whatsapp-hardening-release`.
Generated 2026-07-17. No source files were modified.

---

## 0. Real state of the branches (measured, not guessed)

| Fact | Value | How measured |
|---|---|---|
| `origin/main` tip | `ed6b6ee` (PR #186, Outreach AI Phase 1) | `git log -1 origin/main` |
| `origin/directive/018-r6-controlled-live-execution` tip | `dc155f4` (Merge PR **#359**, WhatsApp inbound foundation) | `git log -1` |
| Local `feat/whatsapp-hardening-release` tip | `36ce1a2` | `git branch --show-current` |
| **Commits on directive branch not in main** | **356** | `git rev-list --count origin/main..origin/directive/…` |
| **Commits on local feat branch not in main** | **358** | `git rev-list --count origin/main..feat/…` |
| Local commits **beyond** the directive tip | **2** (PR2 `abd5230`, PR3 `36ce1a2`) | `git rev-list --count origin/directive/…..feat/…` |
| Local branch vs directive tip (behind / ahead) | `0 / 2` | `git rev-list --left-right --count` |
| **Migrations on main** | **100** | `git ls-tree -r origin/main -- supabase/migrations` |
| **Migrations on feat branch** | **154** | `git ls-tree -r feat/…` |
| **Migrations ahead of main (delta)** | **54** | `comm -13` of the two lists |
| Main's newest migration | `20260729000000_outreach_ai_employee.sql` | tail of main's list |

**Interpretation.** Nothing WhatsApp is in production. `main` stops at `20260729`; *everything* from `20260730` onward (54 migrations, 356+ commits) is unreleased. The WhatsApp milestone is 3 stacked PRs: **#359 (inbound foundation — MERGED into the directive branch)** → **#360 (draft-first engine — PR #360 `abd5230`, open)** → **#361 (outbound sender + receipts — PR #361 `36ce1a2`, open)**. The local branch = directive tip + those two hardening commits.

### Tables NOT yet in production (verified against main's tip)
Not present on `origin/main`; created in the delta, so **absent from prod**:
- `ai_reply_transports` (`20260816`), `ai_reply_delivery_receipts` (`20260817`) — outbound transport substrate (prerequisite; already on the directive branch).
- `whatsapp_webhook_events` (`20260917`), `whatsapp_number_routes` (`20260918`) — inbound ingress + routing (PR #359, on directive branch).
- All `receptionist_conversation_*` tables (`20260819`–`20260909`) — conversation runtime substrate.

**Correction to the brief:** `ai_receptionist_setups` **IS already in production** — it was created at `20260625000000_ai_receptionist_setups.sql`, which predates main's tip and is on `origin/main`. Only its *consumption by the WhatsApp channel* is new. `whatsapp_number_routes` (the new routing table) is what's absent, not `ai_receptionist_setups`.

---

## Artifact 1 — Directive-to-Main Merge Plan

**Goal:** land the WhatsApp milestone in production **dark** (zero customer impact), then activate by configuration only.

**Stack & merge order (must be sequential — each builds on the prior):**

| Order | PR | Commit | What it delivers | State |
|---|---|---|---|---|
| 1 | **#359** | `66dad5f` (merged as `dc155f4`) | Inbound webhook: GET verify + POST HMAC, ingress claim ledger, phone_number_id→org routing, hand-off to `processInboundEnquiry`. Adds `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`. | ✅ On directive branch |
| 2 | **#360** | `abd5230` | Draft-first engine: channel-aware entry (`canRunReceptionistChannel`), no-fallback transport registry (`getTransportProvider`), dark WhatsApp provider, `ChannelBadge` in review inbox. Adds `COMMS_WHATSAPP_PROVIDER`; migration `20261044` (renumbered from `20260920`). | 🟣 Consolidated onto `feat/whatsapp-consolidated` |
| 3 | **#361** | `36ce1a2` | Outbound half: real Meta Graph sender (`createMetaWhatsAppProvider`), channel-agnostic receipt authority (`recordWhatsAppDeliveryReceipt`), inbound provider metadata. Adds `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION`; migrations `20261043`, `20261045` (renumbered from `20260919`, `20260921`). | 🟣 Consolidated onto `feat/whatsapp-consolidated` |

**Recommended path to production:**
1. **Decide the merge unit.** Because the WhatsApp milestone rides inside the full **54-migration / 356-commit** directive→main delta, the cleanest release is: merge the entire `directive/018-r6…` branch to `main` via its integration PR, *after* PR #360 and #361 are pushed and merged **into the directive branch first** (preserving the #359→#360→#361 order). Do **not** cherry-pick just the WhatsApp commits — they depend on the transport/receptionist substrate earlier in the delta.
2. **Push the two local commits** as PR #360 then #361 onto the directive branch; keep them stacked (rebase #361 on #360). CI (typecheck + build + integration Postgres) must be green — the commit messages record `tsc clean · eslint clean · unit 227 files/4698 tests · security 108/3219` locally, but integration + prod build run on the Vercel/CI gate.
3. **Merge directive → main** through the normal reviewed PR. This applies all 54 migrations on the next Supabase deploy and ships all code **dark** (flags default off, no Meta creds).
4. **Heads-up for the reviewer (not a WhatsApp risk):** the 54-migration delta contains exactly **one destructive migration** — `20260812000000_lr5_4b_remove_legacy_authority_columns.sql` drops `ai_employees.tools_allowed` and `.permissions` (Capability-Registry cutover, LR5.4b). It is irreversible and unrelated to WhatsApp; confirm the registry cutover is validated before the directive→main merge. Every WhatsApp migration is additive.

---

## Artifact 2 — Migration Deployment Order (WhatsApp milestone)

Supabase applies migrations in **filename-timestamp order**. The WhatsApp-milestone sequence:

| # | Migration file | Purpose (one line) | Kind | Introduced by |
|---|---|---|---|---|
| — | `20260816000000_ai_reply_transports.sql` | Outbound transport ledger (append-only, per-attempt) — prerequisite substrate. | additive (`create table if not exists`) | pre-#359 |
| — | `20260817000000_ai_reply_delivery_receipts.sql` | Delivery/read receipt ledger correlated by wamid — prerequisite substrate. | additive | pre-#359 |
| 1 | `20260917000000_whatsapp_webhook_events.sql` | Inbound webhook replay/claim ledger (idempotent `event_key`, service-role only, RLS no-policy). | additive | #359 |
| 2 | `20260918000000_whatsapp_number_routes.sql` | `phone_number_id → org` routing map (unrouted events ack-dropped). | additive | #359 |
| 3 | `20261043000000_inbound_enquiries_provider_dedup.sql` | Adds `provider_message_id`/`provider_timestamp`/`has_media` + partial-unique dedup index. | additive (`add column if not exists`, partial unique) | #361 |
| 4 | `20261044000000_widen_transport_channel_whatsapp.sql` | Widens transport + receipt `channel` CHECK `('sms')→('sms','whatsapp')`. | additive superset (drop+re-add wider CHECK) | #360 |
| 5 | `20261045000000_whatsapp_read_receipt_status.sql` | Widens receipt `status` CHECK by one value: adds `read` (non-terminal). | additive superset | #361 |

**All additive & dark.** Every statement is `create table if not exists` / `add column if not exists` / CHECK-constraint **widening** (existing rows always still satisfy the superset). No `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, or `DELETE FROM` in any of the seven. Safe to apply **ahead of** code.

**RENUMBER (2026-07-27, consolidation onto `main`) — resolved, was a release blocker.** Rows 3–5 were originally authored as `20260919000000` / `20260920000000` / `20260921000000`. Those three **version prefixes are already applied in production** by unrelated migrations that landed on `main` while this stack sat on its branch — `20260919000000_snags.sql`, `20260920000000_site_diary.sql`, `20260921000000_toolbox_talks.sql`. Supabase keys migration identity on the **numeric version prefix, not the filename**, so git could not surface the clash and the deploy would have silently skipped all three (leaving the `channel`/`status` CHECKs narrow while WhatsApp code expected them wide). Because these files had **never been applied in any environment** — the applied prod tip is `20261042000000`, far ahead of them — they were free to move. Re-slotted to `20261043/44/45000000`: after the applied tip, contiguous, and preserving their original relative order. **SQL bodies are unchanged byte for byte**; only a header comment was added to each. Rows 1–2 (`20260917`/`20260918`) are already applied in prod via #359 and are untouched.

**Ordering nuance (now moot).** Pre-renumber, `20260919`/`20260921` (from #361) carried *earlier* timestamps than `20260920` (from #360), so a split deployment could have applied them out of order. The renumber puts them in dependency order in one contiguous block, and this consolidated branch ships all three in a **single deployment**, so they apply in one monotonic pass.

---

## Artifact 3 — Environment Readiness Matrix

All six are `z.string().optional()` in `lib/env.ts` — none blocks boot; absence = dark.

| Var | Purpose | Required to ACTIVATE? | Secret? | Where set | Added by |
|---|---|---|---|---|---|
| `WHATSAPP_APP_SECRET` | HMAC key for `X-Hub-Signature-256` on inbound POST; absent ⇒ `verifyMetaSignature` fails closed (rejects all). | **Yes — inbound** | **SECRET** | Vercel prod env | #359 |
| `WHATSAPP_VERIFY_TOKEN` | Shared string echoed in Meta's `GET hub.challenge` subscription handshake; absent ⇒ 403. | **Yes — inbound / subscription** | **SECRET** (shared) | Vercel prod env **+ Meta webhook config** (must match) | #359 |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API bearer token the sender POSTs with. | **Yes — outbound** | **SECRET** | Vercel prod env | #361 |
| `WHATSAPP_PHONE_NUMBER_ID` | Business phone-number id in the Graph `POST /{id}/messages`. | **Yes — outbound** | No (identifier) | Vercel prod env | #361 |
| `WHATSAPP_GRAPH_VERSION` | Pins Graph API version (default `v21.0`). | No — optional/tuning | No | Vercel (optional) | #361 |
| `COMMS_WHATSAPP_PROVIDER` | Names the outbound provider; default `auto` resolves to Meta once creds present; `none/off/disabled/unknown` ⇒ null. | No — optional (`auto` works once creds set) | No | Vercel (optional) | #360 |

**Activation gates in code:** inbound needs `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN`; outbound is gated on `Boolean(WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID)` (`getWhatsAppProvider`, `lib/comms/index.ts:182`). **4 required-to-activate** (2 inbound secret, 1 outbound secret, 1 outbound non-secret) + **2 optional**.

---

## Artifact 4 — External Integration Readiness Matrix (Meta-side blockers)

These are **outside the repo** — they cannot be satisfied by code or deploy; each is an external blocker on activation (not on shipping dark).

| # | Item | What it unblocks | Status |
|---|---|---|---|
| 1 | **Meta App** (Business type, WhatsApp product added) | Everything; source of App Secret | ⛔ External — must exist |
| 2 | **WhatsApp Business Account (WABA)** | Sender + templates live under it | ⛔ External |
| 3 | **Business verification** (Meta Business Manager) | Lifts messaging limits; required for production access | ⛔ External |
| 4 | **Sender registration** (business phone number → `phone_number_id`) | Provides `WHATSAPP_PHONE_NUMBER_ID`; the routing key for `whatsapp_number_routes` | ⛔ External |
| 5 | **App Secret** → `WHATSAPP_APP_SECRET` | Inbound HMAC verification | ⛔ External (copy into Vercel) |
| 6 | **Verify token** → `WHATSAPP_VERIFY_TOKEN` | GET subscription handshake (self-chosen; set in **both** Meta + env, must match) | ⚙️ Self-provisioned |
| 7 | **Access token** (system-user, long-lived) → `WHATSAPP_ACCESS_TOKEN` | Outbound Graph sends | ⛔ External |
| 8 | **Webhook subscription** (Meta → `https://crewflow.uk/api/webhooks/whatsapp`, `messages` field) | Delivery of inbound events; verified via GET handshake | ⛔ External (config after deploy) |
| 9 | **Approved message templates** | Out-of-session-window sends (>24h). Not required for in-window operator-reviewed replies (PR3 sends free-form; template classification deferred). | ⛔ External (needed only for proactive/out-of-window) |

**~8–9 external blockers.** None blocks the dark ship; all block live traffic.

---

## Artifact 5 — Feature-Flag Launch Sequence (each layer independently gated)

| Stage | Action | Effect | Still safe because |
|---|---|---|---|
| **0. Dark (default)** | Merge + migrate. `NEXT_PUBLIC_FEATURE_WHATSAPP=false`, no creds. | Webhook GET/POST → **404** (`isWhatsAppInboundLive` false). Outbound provider null. | Zero customer impact; touches no tenant data. |
| **1. Inbound enable (global)** | Set `NEXT_PUBLIC_FEATURE_WHATSAPP=true` + `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN`. Subscribe webhook in Meta. | Webhook verifies + claims events. Messages route by `phone_number_id`. | No org is `live` yet ⇒ per-org gate fail-closed ⇒ nothing drafts; unrouted numbers ack-dropped. |
| **2. Per-org enable** | Insert `whatsapp_number_routes` (phone_number_id→org); set that org's `ai_receptionist_setups.enabled=true`, `status='live'`. | Inbound WhatsApp for that org runs the AI engine → **draft lands in review inbox**. | Outbound still dark (no creds) ⇒ operator "Send" records `no_provider`, sends nothing. Human-reviewed only. |
| **3. Outbound enable** | Set `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`. | `getWhatsAppProvider` resolves; operator-reviewed **Send actually delivers** via Meta Graph; read receipts recorded. | Still **draft-first**: a reply is only sent when a human approves it in the review inbox. Never falls back to SMS (no-fallback registry). |
| **4. Autonomous-ack** | (Separate, later) `NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION` governs live booking execution. | Booking actions may execute. | Defaults **off**; even armed, strongest eligibility is `requires_human_review` — no autonomous customer send by construction. |

Roll forward per-org (stage 2) one tenant at a time before touching the global outbound creds (stage 3).

---

## Artifact 6 — Smoke-Test Plan (post-deploy, dark)

Run against production immediately after the directive→main deploy, **flag still off**, then after stage-1 enable.

**A. While dark (`NEXT_PUBLIC_FEATURE_WHATSAPP=false`):**
1. `GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=123` → expect **404** `{"ok":false,"error":"not_enabled"}` (route present, gate closed).
2. `POST /api/webhooks/whatsapp` (any body) → expect **404** `not_enabled`. Confirms no ingestion path is open.
3. DB: `select count(*) from whatsapp_webhook_events` → table exists, **0 rows**. Repeat for `whatsapp_number_routes`. Confirms migrations applied, nothing written.

**B. After stage-1 enable (flag on + `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN`, before any org live):**
4. **Webhook verification GET:** `GET …?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=CF123` → expect **200**, body exactly `CF123`, `content-type: text/plain`. Wrong token → **403**.
5. **Synthetic signed POST:** build a minimal Meta message envelope; compute `sha256=` HMAC of the **raw body** with `WHATSAPP_APP_SECRET`; send as `X-Hub-Signature-256`.
   - Valid signature, unrouted `phone_number_id` → **200**; row in `whatsapp_webhook_events` with `processed_at` set and `org_id` null (ack-dropped) — **no `inbound_enquiries` row, no outbound**.
   - **Tampered/absent signature → 401** `invalid_signature` (fail-closed auth boundary).
6. **Idempotency:** replay the same signed POST → still **200**, still exactly one `whatsapp_webhook_events` row (unique `event_key`).
7. **Confirm no outbound:** `select * from ai_reply_transports where channel='whatsapp'` → any row is `failed`/`no_provider`; `sent` count = 0. No Meta Graph egress.

---

## Artifact 7 — Rollback Plan

| Scenario | Action | Why it's safe/instant |
|---|---|---|
| **Kill switch (any severity)** | Set `NEXT_PUBLIC_FEATURE_WHATSAPP=false` and redeploy env. | `isWhatsAppInboundLive` flips false ⇒ webhook 404s instantly; `canRunReceptionistChannel` fail-closes all `whatsapp_msg`. No code revert needed. |
| **Stop outbound only** | Unset `WHATSAPP_ACCESS_TOKEN` (or set `COMMS_WHATSAPP_PROVIDER=off`). | `getWhatsAppProvider` → null ⇒ sends stop, records `no_provider`. Inbound drafting unaffected. |
| **Single tenant misbehaving** | Set that org's `ai_receptionist_setups.status` off `'live'`, or `whatsapp_number_routes.active=false`. | Per-org gate fail-closes for that org only; others keep running. |
| **Receipt/transport bug** | Disable outbound (above); ledgers are **append-only, immutable** (`no_update`/`no_delete` triggers), so bad data cannot corrupt state — a bad receipt is an inert extra row, `read` is non-terminal and can't regress `delivered`. Fix forward. | No mutable status to unwind. |
| **Schema rollback** | **Not required.** | All WhatsApp migrations are additive/dark; unused tables/columns are inert with the flag off. Down-migrations would be pure risk for no benefit. |

**Bottom line:** rollback is a **config flip**, not a deploy revert or a schema change. The only irreversible migration in the wider delta (`20260812` legacy authority-column drop) is unrelated to WhatsApp and is settled before the merge.

---

## Artifact 8 — Post-Deployment Monitoring Plan

**Inbound ingress health — `whatsapp_webhook_events`:**
- **In-flight / stuck:** `select count(*) from whatsapp_webhook_events where processed_at is null and claimed_at < now() - interval '15 minutes'` (lease = `WHATSAPP_CLAIM_LEASE_MS`, 15 min). Non-zero + rising ⇒ handler stuck/crashing mid-dispatch. Index `whatsapp_webhook_events_inflight_idx` supports this.
- **Error rate:** rows with non-null `error_message`; watch trend.
- **Unrouted:** events with `org_id is null` and `processed_at` set ⇒ a `phone_number_id` with no active `whatsapp_number_routes` row (missing provisioning). Cross-check the HQ notification stream.
- **Webhook HTTP:** rate of `401 invalid_signature` (forged/misconfigured secret) and `500` batch failures (Meta will retry — confirm the retry drains, not loops).

**Outbound transport health — `ai_reply_transports` (channel='whatsapp'):**
- **`no_provider` count:** expected while dark/pre-creds; a spike *after* outbound is enabled ⇒ creds dropped or provider misresolved.
- **`provider_error` / `failed`:** Graph non-2xx, missing wamid, out-of-window free-form rejection (throws by design). Alert on sustained non-zero.

**Delivery lifecycle — `ai_reply_delivery_receipts` (channel='whatsapp'):**
- Watch the `queued→sent→delivered→read` progression; a stall at `sent` ⇒ Meta status callbacks not arriving (webhook `messages`/status subscription issue). `read` is interim and must never regress `delivered`.

**Human-review queue depth:**
- Review-inbox backlog (verdict=`review`) for WhatsApp drafts. Draft-first means every reply waits for a human — a growing queue is an **operational staffing** signal, and (pre-outbound-enable) the natural steady state since nothing auto-sends.

**Suggested first-week alerts:** in-flight-stuck > 0 for >30 min; `invalid_signature` rate step-change; any `whatsapp` transport `sent` before stage-3 is intended (would indicate the outbound gate opened unexpectedly).

---

### Appendix — Key files (all absolute)
- `/Users/moetalibi/Code/web-impl/lib/env.ts` — env schema (6 WhatsApp vars + flags).
- `/Users/moetalibi/Code/web-impl/app/api/webhooks/whatsapp/route.ts` — inbound edge (GET verify / POST HMAC).
- `/Users/moetalibi/Code/web-impl/server/services/whatsapp-webhook-handler.ts` — claim→route→hand-off; `isWhatsAppInboundLive` (line 318).
- `/Users/moetalibi/Code/web-impl/server/services/receptionist-channel-eligibility.ts` — `canRunReceptionistChannel` (per-org live gate).
- `/Users/moetalibi/Code/web-impl/lib/comms/index.ts` — `getWhatsAppProvider` (line 176) / `getTransportProvider` (no-fallback, line 223).
- `/Users/moetalibi/Code/web-impl/lib/comms/providers/meta-whatsapp-sender.ts` — Graph API sender (PR3).
- `/Users/moetalibi/Code/web-impl/lib/comms/providers/meta-whatsapp.ts` — signature verify + payload/status parse.
- `supabase/migrations/20260917000000_*.sql`, `20260918000000_*.sql` (applied via #359) and `20261043000000_*.sql`…`20261045000000_*.sql` — the 5 WhatsApp migrations.
