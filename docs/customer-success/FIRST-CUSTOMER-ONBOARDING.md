# First Customer Onboarding — founder playbook

One page per phase. Rehearsed end-to-end 2026-08-29 against build `c469e7fd` with a seeded 12-person NI contractor (Harrison & Cole Construction Ltd). Measured total: **about half a day of founder time**, split across two days.

---

## BEFORE SIGNUP (collect while closing the deal)

Ask the customer to email you (any format — the importer reads CSV/Excel/ODS/Numbers/PDF/photos):

- [ ] Company details: legal name, trading address, phone, email, company number
- [ ] **VAT number** + scheme (standard / cash / flat-rate) — CrewFlow defaults to cash accounting
- [ ] **CIS**: are they a contractor? Their UTR. List of subcontractors + verification numbers if they have them
- [ ] Billing contact + the email the owner will log in with (**must match the demo-request email** or you'll approve it manually in HQ)
- [ ] Team list: name, email, mobile, role (who is office/admin vs site staff), hourly pay for staff, emergency contacts
- [ ] Staff tickets: CSCS/SMSTS/first-aid etc. with expiry dates
- [ ] Customer list (name, email, phone, address)
- [ ] Supplier list + payment terms
- [ ] Live jobs: customer, site address, start/end dates, agreed value, who's on them
- [ ] Outstanding invoices (number, customer, net/VAT, due date, what's been paid)
- [ ] Price list / rate card (goes into Price book — **manual entry**, no import; budget 30-60 min)
- [ ] Vehicles/assets list (manual entry in Fleet/Assets — no import)
- [ ] Logo (PNG), bank details for invoices, default quote terms

## ACCOUNT SETUP (founder, ~30 min, Day −1)

1. HQ → `/admin/demos` → approve their demo request (or create + approve one with their login email). Org becomes `trial` on their signup.
2. Owner signs up → lands in `/onboarding/company` (5 fields) → guided setup wizard appears.
3. In-app Settings: VAT number, **Tax defaults** (financial-year start month, CIS default rate, default VAT), bank details, default quote terms, logo, reply-to email.
4. Sanity: `/api/health` green; send yourself a test quote email from the sample data.

## USER SETUP (~20 min)

- Staff → Add staff, one per person: name, email, **role** (owner/admin = office+money; staff = field), phone, employment type, hourly pay, emergency contact. Invites go out by branded magic-link email.
- Rule of thumb: office/admin/PM = `admin`; site managers and field staff = `staff`. **Money, Sales, Reports are owner/admin only** — tell the owner this up front so it lands as a feature (staff can't see prices/invoices), not a bug.
- Subcontractor operatives who need to sign RAMS do **not** need accounts — issue worker-portal links per job (Site & safety → Worker links).

## DATA SETUP (founder-assisted, 1–2 h, Day −1)

Order matters — do it in this sequence with Imports (`/imports`, admin-only; every import has one-click rollback):

1. Customers (CSV/Excel import, deduped)
2. Suppliers (import — stored as suppliers)
3. Jobs (import; site address/value land in notes — open each live job after and fill the site-address fields properly; assign the site manager)
4. Outstanding invoices (import — back-dated, `overdue` normalises to sent+due date)
5. Payments already received (import — matches on invoice number)
6. Costs/expenses to date (import)
7. Price book (manual — from their rate card)
8. Vehicles/assets, staff tickets (manual)
9. RAMS for live jobs: generate from the 11 built-in templates (~5 min each), issue, then send worker-portal links

Rehearsal reference: a realistic 12-person book (6 customers, 4 jobs, 3 invoices, 5 cost lines, rota, RAMS) took **under 2 hours** including checks. The setup checklist on the owner's dashboard auto-detects what's done (ours read 8/12 = 67% straight after import).

## TRAINING (Day 0 + Day 1)

- **Owner/admin, 60 min, screen-share:** dashboard briefing ("what needs attention"), lead → quote → send → customer e-signs at the public link → job auto-created; invoice → send → record payment; the **void invoice** and **cancel job** escape hatches (show them — it's confidence, not clutter); Reports + month-end; where VAT/CIS numbers live.
- **Site manager + field staff, 15 min, on their phones:** log in → My day → Clock in/out; Today's rota → View job; Site diary; photo upload from camera; toolbox talk sign; snag. Show the worker-portal RAMS link flow for subbies.
- Print nothing. The bottom nav is the manual.

## DAY-ONE CHECK (founder, 15 min, end of day 1)

- [ ] Everyone invited has logged in (HQ customer page shows last-login)
- [ ] At least one real clock-in happened
- [ ] Diary entry exists for each live site
- [ ] Owner opened the dashboard briefing
- [ ] No red in `/admin/ops`; nothing new in Sentry

## WEEK-ONE CHECK (2× 15-min calls)

- [ ] First real quote sent + accepted through the portal
- [ ] First invoice sent from CrewFlow; payment recorded
- [ ] Timesheets flowing (check payroll draft numbers look sane vs their old system)
- [ ] RAMS signed by every operative on live jobs (register shows sign-off counts)
- [ ] Ask: "what did you go back to the old spreadsheet for?" — that list is the product feedback

## 30-DAY REVIEW (45 min)

- Walk the owner through: Reports (invoiced/paid/overdue), job profitability on their biggest job, aged debtors, VAT quarter figure vs accountant, CIS statements for the month, cert-expiry list.
- Agree what they still do outside CrewFlow and why.
- Confirm billing arrangement for month 2 (invoicing is off-platform until Stripe activates).

## Known limits to set expectations on (day one, honestly)

- Quotes: no discount field, no duplicate-quote button (use templates); payroll figures are estimates — keep filing RTI via their existing route; HMRC VAT/CIS filing is prepare/export only; no incident/RIDDOR log yet (keep the paper accident book); bank feed is manual CSV reconcile; "My jobs" panel on My Day currently shows nothing (workers use Today's rota / Jobs tab — fix scheduled).
