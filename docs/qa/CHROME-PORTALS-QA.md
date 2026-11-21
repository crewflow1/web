# CHROME-PORTALS-QA — real-browser testing, customer & worker portals

> **Environment:** local dev (port 3001) + local Supabase, real Chromium browser.
> **Date:** 2026-11-02.

## Customer portal — tokenised quote view + accept (PASSED, DB-verified)

The customer-facing quote link `/q/<token>` was tested end-to-end as the customer
(the share link copied from the owner's quote screen):

| Check | Result | Status |
|---|---|---|
| Draft quote, before approval | link correctly refuses: "This quote link isn't available … hasn't been approved yet" — a well-designed customer error page; **no leak of an unapproved quote** | **PASSED** |
| After owner approval | full quote renders: Q-0001, from E2E Co, for Marsh & Co Builders Ltd, line items, Subtotal £18,500 / VAT £3,175 / Total £21,675 (figures match the owner view exactly) | **PASSED** |
| Accept + e-signature | typed-name signature ("Sarah Murphy") + optional draw-pad; "Accept & sign" → "Quote accepted successfully. Invoice generated and emailed…" | **PASSED** |
| Side effects (DB) | quote `status=accepted`; **auto-created** invoice `INV-0001` (total £21,675, draft) and job `bb77d21b` | **PASSED** |
| Download PDF | `/q/<token>/pdf` link present (not downloaded — download is permission-gated) | NOT EXERCISED |

This is the customer half of the revenue journey and it works through the rendered
UI with correct figures and correct persistence.

## Worker portal — not exercised in this pass

The worker/sign-off portal (tokenised `worker-links` / worker sign-off tokens,
and the H&S worker acknowledgement portal) was **not** driven in this pass — it
requires minting a worker token and is marked NOT TESTED in the CSV. Its security
model (tokenised, service-role-scoped) is covered by the integration/security
tiers (`toolbox-acknowledgements`, `worker_signoff_tokens`), but a live browser
pass is outstanding.

## Coverage boundary (honest)
Customer-portal **quote accept** path: fully tested (Chrome + DB). Customer-portal
other surfaces (invoice view, payment, document view, activity) and the worker
portal: NOT TESTED in this browser pass.
