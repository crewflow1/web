# CrewFlow — founder / legal decision checklist (2026-11-16)

One list. **Default** = engineering recommendation, not a legal view. **Blocks:** **1st** = first paying customer, **Full** = full public launch, **—** = neither. Detail: `COMPLIANCE-GAPS.md` §Decisions, `FOUNDER-FACTS-NEEDED.md`, deletion `LEGAL-RETENTION-DECISIONS.md` §4, cancellation `TERMS-UPDATE-DRAFT.md` §4–5, `AI-SPEND-GOVERNANCE.md` §6.

## Identity and paperwork (F-1…F-5, F-15, F-20, F-21)
- [ ] Legal entity, company number, registered address (F-1–3) — name the DPA/policy parties. **Default:** supply. **1st**
- [ ] ICO registration and fee (F-4) — **Default:** register now. **1st**
- [ ] Privacy contact, DPO yes/no (F-5) — **Default:** monitored address, no DPO, adviser confirms. **1st**
- [ ] Approve the DPA (`DPA-DRAFT.md`) and sub-processor list; accept at onboarding with the Terms (F-20, G-3). **Default:** adviser review, then click-through. **1st**
- [ ] Breach procedure: who decides/files, out of hours; tenant notice time (F-21, DPA cl. 9). **Default:** founder owner, 48h to tenants. **1st**
- [ ] Per-provider DPA/region/transfer mechanism (F-9, DPA cl. 6.4; Resend, Stripe, Backblaze, KV unknown). **Default:** collect from dashboards. **1st**

## Retention and deletion
- [ ] **PD-1/G-25** post-cancellation period and end action (cancel never deletes vs Art. 28(3)(g)); fill Terms "Your data". **Default:** notice, then delete/return after N months. **1st**
- [ ] L1/PD-9 delete tenant statutory ledgers on company deletion after export offer. **Default:** yes. **Full**
- [ ] L2/PD-3 billing archive 6 years from deletion year (vs per invoice). **Default:** per invoice period. **Full**
- [ ] L4/L5/L6, PD-14 payroll period; NI only while payroll line; H&S evidence kept; ex-staff clearing. **Default:** as built. **Full**
- [ ] L8 7-day cooling-off; L13 provider logs disclosed; L15 no cancellation record kept; L16 30-day processor deadline; L17 detach Stripe cards. **Default:** as built, no L17. **Full**
- [ ] PD-16 adopt L1–L14 and enable `FEATURE_ACCOUNT_DELETION`. **Default:** after adviser sign-off. **Full**
- [ ] PD-2, PD-8 ledger and deletion tombstone retention; PD-13 audit-log retention; PD-15 import/webhook ageing. **Default:** time-box all. **Full**
- [ ] PD-7/F-18 backups: age-out acceptable; delete plaintext dumps on operator Mac (G-6). **Default:** delete plaintext. **1st**

## Terms and consumer protection
- [ ] Approve cancellation/billing clauses (draft §2); no-refund setup fee wording. **Default:** approve with adviser. **1st**
- [ ] Draft §4: confirm B2B only; consumer/sole-trader rights, DMCC 2024, UCTA reasonableness. **Default:** B2B-only wording. **1st**
- [ ] F-5(terms): failed-payment 30-day read-only promise vs immediate suspension. **Default:** change terms to match code. **1st**
- [ ] Existing customer notice: 30-day change email before publishing; honour pro-rata for anyone cancelling earlier (≤1 customer, confirm who; F-25 real or test data). **Default:** send now. **1st**

## AI, consent, transfers, policy
- [ ] PD-6/F-10 Anthropic/OpenAI terms accepted: training, retention, ZDR, transfer; processor role on tenant data. **Default:** verify, then disclose. **1st**
- [ ] Per-company AI off switch (G-13). **Default:** build before launch. **Full**
- [ ] Confirm £500 platform AI ceiling (migration 358) and set provider hard caps (Anthropic workspace+org, OpenAI enforced). **Default:** ~US$650–700 workspace cap. **—** (cost control)
- [ ] PD-5 basis for consent-free Sentry errors; analytics consent (#1092). **Default:** LI for errors, consent for performance. **Full**
- [ ] PD-4 photo EXIF: strip or keep. **Default:** strip. **Full**
- [ ] F-6 lawful bases/LIAs; PD-10/F-7 prospecting (PECR, Art. 14, opt-out); PD-11/F-13 DSAR time (live says 14 days). **Default:** adviser; promise one month. **Full**
- [ ] F-14 notify owners of policy changes; F-16/F-17 log and session settings (PD-17); F-12 admin MFA list; F-22 certifications. **Default:** confirm, claim only what is true. **Full**
- [ ] F-19 WhatsApp armed in prod, no traffic: intended? DPIA (G-21) before call recording, voice, telematics, WhatsApp. **Default:** turn flag off. **Full**
- [ ] F-24 staged SQL (column drops): approve/refuse. **—**
- [ ] Publish corrected privacy policy (G-1) replacing untrue live statements. **Default:** after F-1…F-6. **1st**
