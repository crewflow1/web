# LIA-02 — Legitimate Interests Assessment: B2B prospecting (PD-10)

Draft 2026-11-16 · for `[LEGAL REVIEW]` · CrewFlow role: **controller**.

## What is being assessed
Identifying UK construction firms from public sources (Companies House register and the firms' own websites), contacting a named or role-based business address once or twice by email (and a website contact form where no email is published) to offer CrewFlow, and recording who has been contacted and any opt-out.

Code and register facts:
- In-product HQ sales surface: `hq_sales_*`, `hq_communications`, `hq_comms_suppressions` (service-role only); drafts are produced by `server/services/hq-outreach.ts` + `lib/ai` (Anthropic) and are **draft-only — a human reviews, edits, approves and sends** (header of `hq-outreach.ts`; execution locked). `/api/cron/outreach-drain` only drafts. Resend bounces/complaints automatically add the address to `hq_comms_suppressions` (`server/services/resend-events-handler.ts` → `applyHqSuppression`), and sends consult the suppression list (`server/services/hq-comms.ts`).
- Companies House lookups: `COMPANIES_HOUSE_API_KEY`; `hq_sales_sourcing_pool` = 0 rows in prod (`PROVIDER-REGISTER.md`).
- Outside the product: the founder's own manually sent outreach campaign from `hello@crewflow.uk`, tracked outside this repository `[FOUNDER]` confirm scope, number of contacts, whether any individual (sole trader) was contacted, and how opt-outs/replies are recorded.
- Demo requests (`app/api/demo/route.ts` → `demo_requests`, 3 rows) are **inbound** (the person asked) and belong to C3, not this LIA; they should still not be reused for cold marketing beyond the demo conversation.

## Two regimes
1. **UK GDPR** — Art. 6(1)(f) legitimate interests; Art. 14 notice because data is not obtained from the person; right to object to direct marketing is absolute (Art. 21(2)-(3)).
2. **PECR** (Privacy and Electronic Communications Regulations 2003) — reg. 22: unsolicited marketing **email** to an *individual subscriber* (sole traders, some partnerships) requires prior consent; **corporate subscribers** (Ltd, LLP, plc, Scottish partnerships) may be emailed on an opt-out basis. Reg. 23: sender identity and a valid address to opt out are mandatory. The "soft opt-in" does not apply to a first contact. A form submission on a firm's contact page is not an email and is lower risk but is not exempt from UK GDPR. `[LEGAL REVIEW]` confirm this classification and the treatment of corporate-subscriber role mailboxes (`info@`, `hello@`) vs named personal addresses of directors.

## Three-part test
**Purpose.** Win customers for a B2B product; commercial interests are recognised as legitimate (ICO). Recital 47 expressly mentions direct marketing.

**Necessity.** A manual, targeted, low-volume approach to firms that fit the product (NI/UK construction businesses) is a proportionate way to find customers; there is no consent route for a cold market. Mitigation by design: only firms matching defined fit criteria, a small number of messages, plain-language relevance to their trade.

**Balancing.**

| Factor | Assessment |
|---|---|
| Data | Business name, a business email or contact form, a director/officer name where public, role. No special-category data. |
| Expectation | A construction firm that publishes a contact address expects trade enquiries; a software offer relevant to construction is within a reasonable expectation. A sole trader's personal mailbox is **not** (hence PECR exclusion) |
| Impact | Low: one-to-few messages; no profiling or tracking pixels (`[FOUNDER]` confirm no open-tracking in the manual sends) |
| Safeguards | Exclude individual subscribers by company type (use Companies House `company_type`; drop sole traders/ordinary partnerships) `[FOUNDER]`/`[LEGAL REVIEW]`; identify CrewFlow, say where the address was found, one-line opt-out; suppression list honoured permanently (`hq_comms_suppressions`); stop after the planned follow-ups; delete non-responders after a set period |
| Art. 14 | Provide in the first message (short sentence + link to the privacy notice section on prospects: `../PRIVACY-POLICY-DRAFT.md` §3.3) |

**Outcome (draft):** legitimate interests is available for **corporate** B2B contacts when the Art. 14 line, opt-out and suppression are in place. It is **not** available as a PECR basis for emailing individual subscribers.

## Open items
| Item | Owner |
|---|---|
| **Retention period for non-responders** (PD-10) — no job deletes `demo_requests` or HQ sales rows; do not build before the period is set | `[FOUNDER]` |
| Confirm every outreach email carries identity, source and opt-out; confirm opt-out replies are recorded and honoured across any tool outside the product | `[FOUNDER]` |
| Decide whether the in-product Companies House sourcing pool stores personal officer names | `[FOUNDER]` |
| Legal sign-off on corporate-subscriber classification | `[LEGAL REVIEW]` |

Review: before scaling beyond the current campaign, or yearly. Sign-off `[LEGAL REVIEW]` ______ `[FOUNDER]` ______.
