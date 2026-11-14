# CrewFlow — facts only the founder can supply (privacy workstream)

Nothing in this list could be established from the code, the database or public endpoints, and none of it may be guessed. Each item says **why it is needed** and **where it is used**. IDs F-1…F-15 are the placeholders in `PRIVACY-POLICY-DRAFT.md`.

Status of every item: **NEEDS-FOUNDER**. Items marked ⚖ should be answered with, or by, a qualified data-protection adviser.

## A. Identity of the controller (blocks publishing any policy)

| ID | Fact needed | Why it is needed | Used in |
|---|---|---|---|
| F-1 | Full legal name of the entity that operates CrewFlow (limited company, LLP or sole trader) | A privacy notice must identify the controller (UK GDPR Art. 13(1)(a)); contracts and the DPA must name a party. The live pages only say "operated from Belfast" | Policy §1; terms; DPA |
| F-2 | Registered office / postal address for correspondence | Same article; people must be able to write to the controller | Policy §1, §14 |
| F-3 | Legal form and company number (and place of registration), or confirmation it is a sole trader | Identifies the entity unambiguously; the Companies Act requires a company to show this on its website | Policy §1; website footer |
| F-4 | ICO registration number — or confirmation that registration and the data-protection fee still need doing | Most organisations processing personal data must pay the fee; the number is normally shown in the notice. If not yet registered, that is a pre-launch action | Policy §1 |
| F-5 | The privacy contact address to publish (today `hello@crewflow.uk`), who monitors it, and whether a Data Protection Officer is appointed ⚖ | Art. 13(1)(a)/(b); a DPO is mandatory only in certain cases — that is a legal judgement | Policy §1, §14 |
| F-15 | The publication ("last updated") date of the new policy | Shown on the page; `CURRENT_TOS_VERSION` is pinned to the terms date by a test and the two should stay coherent | Policy header |

## B. Legal positions ⚖

| ID | Fact / decision needed | Why it is needed | Used in |
|---|---|---|---|
| F-6 | The lawful basis for each purpose, and the legitimate-interests assessments behind monitoring, support access and prospecting | Must be stated in the notice (Art. 13(1)(c)–(d)); an engineer cannot determine it | Policy §4 |
| F-7 | How sales prospects are sourced and contacted: which sources (Companies House, websites, directories), whether recipients include sole traders/partnerships, what each email says about who CrewFlow is and how to opt out, and where opt-outs are recorded | Art. 14 (data not obtained from the person) requires telling them the source; PECR treats sole traders and partnerships as individuals for email marketing. The product has a suppression table (`hq_comms_suppressions`, 0 rows) — outreach done outside the product needs an equivalent record | Policy §3.3, §11; `COMPLIANCE-GAPS.md` G-12 |
| F-10 | From the Anthropic and OpenAI agreements actually accepted: is customer content excluded from model training; how long are requests retained; is zero-retention available/enabled; what transfer mechanism applies | The policy must not say "not used for training" unless it is contractually true. 580 AI calls are already logged in production | Policy §5 |
| F-13 | The response time CrewFlow will promise for data requests (legal maximum: one month), and who will actually do the work | The live page promises 14 days; there is no per-person export or erasure tool, so each request is manual | Policy §11 |
| F-14 | Whether account owners will be emailed about material policy changes, and how | The live page promises it; no mechanism exists | Policy §13 |
| F-20 | Whether a data processing agreement (Art. 28) exists and has been given to any current or design-partner customer | CrewFlow is a processor for tenant data; without a DPA neither side is compliant. The terms page has no processor clauses | `COMPLIANCE-GAPS.md` G-3 |
| F-21 | Who decides and files a breach notification (ICO within 72 hours; tenants "without undue delay" as their processor), and how they are reached out of hours | No procedure exists in the repository | G-24 |

## C. Providers — contracts, regions, plan settings

| ID | Fact needed | Why it is needed | Used in |
|---|---|---|---|
| F-8 | **Decision:** move Vercel serverless functions out of the USA (`iad1`) to London (`lhr1`) or Dublin (`dub1`), or keep them there and document the transfer | Verified from response headers: application code runs in Washington DC while the database is in Ireland. Either the policy must disclose a US transfer and the safeguard, or the region must change (Vercel project setting or `vercel.json`) | Policy §6–§7; G-2 |
| F-9 | For **each** active provider — Supabase, Vercel, Resend, Stripe, Anthropic, OpenAI, Sentry, PostHog, Backblaze, Vercel KV/Upstash, Meta (WhatsApp): (a) is a DPA signed or accepted, (b) the region configured on the account (Resend, Backblaze bucket, KV, Stripe account country are unknown to me), (c) the transfer mechanism if outside the UK | The sub-processor table and the transfers section cannot be completed, and the Art. 28 chain to tenants cannot be evidenced, without this | Policy §6–§7; `PROVIDER-REGISTER.md` |
| F-16 | Log/event retention actually configured: Vercel logs, Sentry events, PostHog events, Resend message logs; Supabase backup retention (stated as 7 days) | The retention schedule lists these as "plan-dependent". The live page claims a 90-day roll-off I could not confirm | `RETENTION-SCHEDULE.md` §2.4 |
| F-17 | Supabase Auth dashboard settings: session lifetime / inactivity timeout; that custom SMTP points at Resend; whether auth audit logs are kept anywhere (the `auth.audit_log_entries` table is empty in production) | Sessions hold raw IP + user agent; an empty auth audit trail matters for incident investigation | `RETENTION-SCHEDULE.md`; G-20 |
| F-19 | WhatsApp: is it **meant** to be switched on in production? Is `WHATSAPP_TEST_RECIPIENT_ALLOWLIST` set? | `/api/health` shows the channel credentialed and flagged on, contradicting the activation register and the programme baseline, which both call it dark | `PROVIDER-REGISTER.md` §2.12; G-17 |
| F-22 | Any security certification or insurance actually held (e.g. Cyber Essentials) | So the policy and sales material claim only what is true. None is claimed in the draft | Policy §10 |

## D. Internal practice

| ID | Fact needed | Why it is needed | Used in |
|---|---|---|---|
| F-11 | **Decisions** on retention: (i) what happens to a company's data when it cancels, and after how long; (ii) how long demo requests and sales contacts are kept; (iii) whether ex-staff sensitive fields should be cleared on removal; (iv) how long import staging is kept; (v) the activity-log window | The live pages promise periods nothing enforces. The mechanisms mostly exist and are switched off | Policy §9; `RETENTION-SCHEDULE.md` §4 |
| F-12 | Who has administrator access to the Supabase, Vercel, Stripe, Resend, Sentry, PostHog, Backblaze and domain/DNS accounts, and whether multi-factor sign-in is enforced on each | The live page claims "only the on-call engineer can access production infrastructure, and access is logged" — not verifiable from code | Policy §10 |
| F-18 | The backup operator machine: is full-disk encryption (FileVault) on; who else can log in; where the backup encryption key is escrowed; whether the 8 **plaintext** local dump directories are needed | The backup script keeps plaintext copies of the whole production database, auth data and files on that machine | G-6 |
| F-23 | Whether any tenant is expected to record workers under 18 (apprentices) | Determines whether the children section needs more than one sentence | Policy §12 |
| F-24 | Approval (or refusal) of each staged SQL file in `staged-migrations/` | They drop columns/a table; irreversible; outside my authority | `DATA-MINIMISATION.md` |
| F-25 | Whether the 602 customer records and 1,803 staged import rows currently in production are test/demo data or a real customer's | If real, a processor relationship already exists without a DPA, and the import-staging copy is live personal data with no retention rule | G-3, G-15 |

## E. Quick reference — what each blocks

- **Publishing a corrected policy:** F-1, F-2, F-3, F-4, F-5, F-6, F-8 (or disclose), F-9, F-10, F-11, F-13, F-15.
- **Onboarding a paying customer as a processor:** F-20, F-9, F-21.
- **Engineering work waiting on a decision:** F-8 (region), F-11 (retention build), F-24 (staged SQL), F-19 (WhatsApp state).
