# Personal-data breach procedure — DRAFT (not adopted)

Status: engineering draft for founder adoption and legal review. Markers: `[FOUNDER: …]` facts to supply,
`[LEGAL REVIEW: …]` judgements. UK GDPR Arts. 33–34; DPA clause 9 (`DPA-DRAFT.md`) must not be offered until
this procedure is adopted.

## 1. Roles
- Incident lead: `[FOUNDER: name, phone]` (default: the founder). Deputy: `[FOUNDER]`.
- Privacy contact (published): `[FOUNDER: e.g. privacy@crewflow.uk]`.
- Engineering responder: whoever holds production access (Supabase, Vercel, Stripe, B2).

## 2. Detection sources (exist today)
Sentry errors; outage monitor (GitHub Actions issues: health, cron staleness, stale backup, stuck Stripe webhooks — #1099);
`/admin/ops` and HQ notifications; Supabase/Vercel/Stripe provider notices; CSP violation reports (#1110);
customer or staff reports to hello@crewflow.uk; security researcher reports (Terms invite them).

## 3. First hour — contain, then assess
1. Open an incident record (`docs/ops/incidents/YYYY-MM-DD-<slug>.md`, private repo or local — never the public repo while open): time detected, who, source.
2. Contain without destroying evidence: revoke the exposed credential/session/link (portal token revoke, Supabase key rotation only with founder approval), set `MAINTENANCE_MODE=on` if active harm continues, switch a misbehaving feature off by its flag.
3. Preserve evidence: copy relevant logs (Vercel, Supabase, Sentry event ids), the git SHA in production (`/api/health`), and DB rows involved (ids only, not contents, into the record).
4. Decide whether it is a **personal-data breach** (accidental/unlawful destruction, loss, alteration, unauthorised disclosure of or access to personal data).

## 4. Assess risk and roles
- Whose data: CrewFlow's own (CrewFlow = controller) or a customer company's tenant data (CrewFlow = processor).
- Categories (use `data-register.csv`): staff payroll/compensation, bank details, identity documents, photos, signatures, customer contacts.
- Scope: which orgs, how many people, whether data left the boundary (cross-tenant? public?).
- Likelihood and severity of risk to individuals → `[LEGAL REVIEW: risk thresholds]`.

## 5. Notifications
| Case | Who | Deadline |
|---|---|---|
| Tenant data (CrewFlow processor) | Each affected customer company (controller) | **Without undue delay** after becoming aware (DPA clause 9: `[FOUNDER/LEGAL: e.g. 24–48h]`) with the facts in §4 |
| CrewFlow's own data, risk to individuals | ICO | **Within 72 hours** of becoming aware (report even if incomplete; update later) |
| CrewFlow's own data, **high** risk | Affected individuals | Without undue delay |
| Payment data | Stripe (CrewFlow never stores card numbers) | per Stripe terms |
Never include unnecessary personal data in notifications. Keep vulnerability detail private until fixed (D-16).

## 6. Fix, verify, close
Root cause → fix with a regression test (security tier) → release through the normal approval path → verify in
production → update the record (timeline, decisions, notifications sent, lessons) → keep the record in the breach log
(Art. 33(5) requires documenting ALL breaches, including unreported ones) for `[FOUNDER/LEGAL: retention period]`.

## 7. Drill
Run a tabletop drill before the first paying customer goes live (one scenario: a leaked portal link exposing a
customer's invoices) and record it here.
