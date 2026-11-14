# Staged, approval-required SQL (privacy / data-minimisation)

**Nothing in this folder is a migration.** These files are deliberately **outside**
`supabase/migrations/` so that no tool can apply them by accident. Each one
removes a column, a table or rows — an irreversible act on the single production
database — and therefore needs an explicit human decision first.

To adopt one: a human approves it, it is copied into `supabase/migrations/` under
the reserved version shown in its header (20261308000000–20261310000000 are
reserved for this workstream), the listed follow-up code/test edits are made in
the same PR, and it goes through the normal branch → review → approved-apply
flow.

| File | Reserved version | What it does | Blocked on |
|---|---|---|---|
| `20261308000000_drop_unused_personal_columns.sql` | 20261308000000 | Drops `time_entries.gps_lat/gps_lng`, `users.avatar_url`, `demo_requests.user_agent` | Founder approval; the code that stopped writing them (this branch) deployed first |
| `20261309000000_drop_orphan_waitlist.sql` | 20261309000000 | Drops the orphan `waitlist` table | Founder approval |
| `20261310000000_purge_verbatim_rate_limit_keys.sql` | 20261310000000 | One-off delete of pre-digest rate-limit rows | Optional — the daily sweep added on this branch removes them anyway |

Every file starts with a **pre-flight block of read-only checks**. Run those
first and compare with the expected values in the header; if any differs, stop.
