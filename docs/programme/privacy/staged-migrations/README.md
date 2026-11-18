# Staged, approval-required SQL (privacy / data-minimisation)

**Nothing in this folder is a migration.** These files are deliberately **outside**
`supabase/migrations/` so that no tool can apply them by accident. Each one
removes a column, a table or rows — an irreversible act on the single production
database — and therefore needs an explicit human decision first.

To adopt one: a human approves it, it is copied into `supabase/migrations/` under
a **new version number issued by the lead**, the listed follow-up code/test edits
are made in the same PR, and it goes through the normal branch → review →
approved-apply flow.

**2026-11-16 — the version numbers in the file names are OBSOLETE.** They were
reserved when the production tip was `20261295000000`; main is now at
`20261354000000` and pending PRs hold `20261355000000`–`20261362000000`. Migrations
must be strictly ascending (D-15), so an adopted file needs a number above every
pending one (the lead allocates from `20261363000000`+). Rename on adoption; do not
apply under the old number.

Extra follow-up for `…drop_unused_personal_columns.sql` since main `d24295e8`:
`20261342000000_users_private_profile_column_acl.sql` lists `avatar_url` in the
colleague-readable column grant. Dropping the column removes its privileges
automatically, but the column-ACL guard tests that enumerate `users` columns
must be updated in the same PR (search `__tests__` for `avatar_url`).

| File | Reserved version | What it does | Blocked on |
|---|---|---|---|
| `20261308000000_drop_unused_personal_columns.sql` | obsolete — lead allocates ≥ 20261363000000 | Drops `time_entries.gps_lat/gps_lng`, `users.avatar_url`, `demo_requests.user_agent` | Founder approval; the code that stopped writing them (this branch) deployed first |
| `20261309000000_drop_orphan_waitlist.sql` | obsolete — as above | Drops the orphan `waitlist` table | Founder approval |
| `20261310000000_purge_verbatim_rate_limit_keys.sql` | obsolete — as above | One-off delete of pre-digest rate-limit rows | Optional — the daily sweep added on this branch removes them anyway |

Every file starts with a **pre-flight block of read-only checks**. Run those
first and compare with the expected values in the header; if any differs, stop.
