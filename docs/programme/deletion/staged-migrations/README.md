# Staged — NOT applied, NOT in `supabase/migrations`

Changes that are irreversible when run, or that touch a script which operates on production. Each needs
separate founder approval. Nothing here has been executed anywhere, including locally.

| File | What | Why staged |
|---|---|---|
| `purge-expired-retained-billing.sql` | Function that deletes `privacy_retained_billing_records` rows whose `retention_until` has passed. | Irreversible destruction of accounting records. First row becomes eligible on 2033-01-01. Needs the retention period confirmed by counsel (DESIGN §8 L2) before it exists in production at all. |
| `backup-tombstone-export.md` | The addition to `scripts/ops/off-platform-backup.sh` and to the restore runbook. | That script runs against production with production credentials; a change to it is reviewed on its own. |

The four migrations in `supabase/migrations/20261311…20261314` are additive and are **not** staged: they
create two service-role-only tables and service-role-only functions, and add a teardown escape to 19 existing
guard functions. They delete nothing when applied.
