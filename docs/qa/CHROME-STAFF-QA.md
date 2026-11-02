# CHROME-STAFF-QA — real-browser testing, construction-company staff (R5 isolation)

> **Environment:** local dev (port 3001) + local Supabase, real Chromium browser.
> Synthetic account `e2e-staff@crewflow.test` (role **staff**, org E2E Co,
> assigned to **no** jobs). **Date:** 2026-11-02. This file focuses on the R5
> staff-isolation security boundary — the founder's security-critical requirement.

## Result: staff isolation is enforced (nav, direct-URL, and data layers)

| Check | Attempt in Chrome | Result | Status |
|---|---|---|---|
| Landing | sign in as staff | lands on `/me` (My day), **not** `/dashboard` | **PASSED** |
| Nav scoping | inspect sidebar | only **My day / Projects / Site & safety / People / Inbox** — **no Sales, no Money, no Operations, no Dashboard** | **PASSED** |
| Financial list (nav bypass) | direct URL `/invoices` | redirected to `/dashboard?error=forbidden` | **PASSED** |
| Specific invoice | direct URL `/invoices/<the £21k INV-0001 id>` | `?error=forbidden` — denied | **PASSED** |
| Quotes | direct URL `/quotes` | `?error=forbidden` — denied | **PASSED** |
| Financial reports | direct URL `/reports` | `?error=forbidden` — denied | **PASSED** |
| Costs ledger | direct URL `/finances` | client-redirect to `/me` — no costs shown | **PASSED** |
| **Unassigned job** | direct URL `/jobs/<owner's job>` (staff not assigned) | resolves to **404 "That page doesn't exist"** — the £21k job's commercial data is **not** exposed | **PASSED** |
| Own data | `/me` | shows only staff's **own** clock-in, timesheet, and pay ("no hourly rate set") | **PASSED** |

## The sensitive-data leak test (seeded real data, confirmed stripped)

Staff can see the **team roster** at `/staff` (names, emails, roles — normal for
colleagues) and can open another member's detail page. To prove the sensitive
fields are not merely blank-by-chance, I **seeded the owner's real compensation**
directly in Postgres — `staff_compensation.hourly_pay = £45.50`,
`emergency_contact = {Jane Owner, phone, Spouse}`, `users.full_name = "Pat Owner"`
— then reloaded the owner's detail page **as staff**:

- **Full name "Pat Owner"** → visible (roster field, by design).
- **Hourly pay (£)** → **empty** — the seeded £45.50 is NOT rendered. RLS
  (`staff_compensation`, mig 20261218) strips it.
- **Emergency contact (name/phone/relationship)** → **empty** — the seeded
  values are NOT rendered.
- Form note: "Only admins can edit profile fields" (write also gated).

**Verdict: no leak.** A staff user cannot read another member's pay or emergency
contact through the UI, even when that data exists.

## Low-priority UX observation (not a defect, not a leak)
The "view another member" page renders the Hourly-pay and Emergency-contact
fields as **empty, edit-disabled** inputs to a non-admin, rather than hiding them.
No data leaks (verified above), but hiding the fields entirely for non-admins
would be cleaner. Logged as **OBS-1 (P3, cosmetic)**.

## Routes exercised (staff)
`/login`, `/me`, `/staff`, `/staff/[id]`, and denied-probes of `/invoices`,
`/invoices/[id]`, `/quotes`, `/reports`, `/finances`, `/jobs/[id]` (unassigned).

## Coverage boundary (honest)
This covers the **isolation boundary** thoroughly (the security priority).
Full exercise of every staff-permitted feature (toolbox acknowledgements, job
photos, material requests, rota view, leave request submission) is partially
done and tracked in the CSV; assignment-revocation-while-logged-in is covered by
the integration/security tiers and the unassigned-job 404 above, not yet by a
full live assign→revoke→refresh browser dance.
