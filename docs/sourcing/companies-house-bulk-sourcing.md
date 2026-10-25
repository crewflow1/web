# Companies House bulk sourcing (free dataset → NI construction prospect pool)

Free, key-less HQ lead sourcing for Northern Ireland construction/trades prospects from
the official **Companies House Free Company Data Product** (monthly bulk dataset). Replaces
the Companies House *REST API key* dependency for basic sourcing; the REST path is preserved
as optional future enrichment.

## Architecture (why GitHub Actions, not Vercel)
The monthly file is ~470 MB zipped / multi-GB CSV — past Vercel serverless memory/duration/
storage limits. A scheduled **GitHub Actions** job streams it instead:

```
monthly bulk download → stream (unzip -p) → parse line-by-line → filter (NI + construction SIC
+ active) → normalize → UPSERT eligible-company pool → discard raw file
        (then, separately, in-app)
weekly roster tick → promote <=10 un-promoted active pool rows → DRAFT prospects (status 'new')
```

- **Importer:** `scripts/sourcing/companies-house-bulk-import.ts` (run via `tsx`), scheduled by
  `.github/workflows/companies-house-bulk-sourcing.yml` (monthly; `workflow_dispatch` for manual
  dry-runs). The whole CSV is NEVER held in RAM — records are streamed, filtered, and upserted in
  500-row batches; the temp file is deleted at the end.
- **Pure logic:** `lib/sourcing/companies-house-bulk.ts` (CSV parse, header mapping+validation,
  SIC/NI/active filters, normalize) — unit-tested, no I/O.
- **Canonical SIC list:** `lib/sourcing/construction-sic.ts` (one allowlist, shared by the bulk
  path and the REST path).
- **Promotion:** `server/services/hq-lead-sourcing-runner.ts` — pool-first (keyless), then the
  optional REST path (only if the pool is empty AND a key is set), else an honest dark completion.

## Official dataset
- Files: `BasicCompanyDataAsOneFile-YYYY-MM-01.zip` (one CSV) or `BasicCompanyData-YYYY-MM-01-part{1..7}_7.zip`.
- Host: `http://download.companieshouse.gov.uk/<filename>`. Monthly, published within 5 working
  days of the prior month-end; filename date is the 1st of the month.
- Columns are mapped **by header name at runtime** and required columns are asserted present, so a
  changed upstream schema aborts loudly rather than sourcing nothing.

## Filtering rules
A record is **eligible** iff ALL hold (deterministic reason codes recorded):
1. `CompanyStatus == "Active"` (live companies only).
2. **NI geography** — `RegAddress.PostCode` is in the **BT** postcode area (`^BT\d`). BT is the only
   UK postcode area wholly in Northern Ireland; GB has no BT postcodes, so a BT registered office ⇒
   NI registered office. Trade-off (documented): a registered office ≠ operating location, and the
   rarer NI-incorporated company using a GB registered office is not captured; the company-number
   "NI" prefix is corroborating provenance only, never the gate.
3. ≥1 SIC code (from `SICCode.SicText_1..4`, `"CODE - desc"`) in the construction allowlist (SIC 41–43).

## Dedupe / monthly refresh
- Pool key = **`company_number` (UNIQUE)**; monthly re-import UPSERTs — no duplicate pool rows.
- On update: factual public fields + `last_snapshot_date`/`last_seen_at` refresh; **promotion state
  (`promoted`, `promoted_at`, `promoted_company_id`) and `first_*` are never overwritten**, so a
  refresh never un-promotes or clobbers sales-owned state. The pool holds NO human/sales-owned
  fields (notes/approvals live on the promoted `hq_sales_companies` row).
- Prospect dedupe at promotion = `companies_house_number` against `hq_sales_companies` (app-layer,
  loud read), so repeated imports never create duplicate prospects.
- Idempotency: one `hq_sales_sourcing_imports` row per snapshot (UNIQUE `snapshot_date`); a prior
  `success` makes a re-run a no-op unless `--force`.

## Volume controls
- **Source catalogue** (pool) vs **promoted prospects** are separate. The pool can hold thousands of
  eligible companies cheaply; the weekly worker promotes **≤10** (`SOURCING_BATCH_LIMIT`, unchanged)
  into DRAFT prospects at `status='new'`. No outreach, no officer enrichment.

## Security
- `hq_sales_sourcing_pool` + `hq_sales_sourcing_imports` are **service-role-only** (RLS enabled, no
  client policy, no grant) — identical posture to the other `hq_sales_*` tables; invisible to the
  customer/staff Data API.
- Promotion writes only through the sanctioned `createCompany` door.
- The GitHub Actions secret (`SUPABASE_SERVICE_ROLE_KEY`) is never logged.

## Cost
- GitHub Actions: a monthly ~5–10 min job on `ubuntu-latest` — negligible against free minutes.
- Egress (CH download) is free; Supabase writes are a few thousand upserts/month. **≈ £0/month.**

## Activation (not done here — review only)
Set repo Actions secrets `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, then merge. The
`schedule` trigger only fires from the default branch, so the workflow is dormant until merged.
