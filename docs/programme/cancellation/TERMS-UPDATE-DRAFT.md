# Terms of Service — proposed billing & cancellation update (DRAFT, NOT PUBLISHED)

Status: **draft for founder + legal review.** `app/terms/page.tsx` is **unchanged** in PR #1090; nothing
here is live. Written by an engineer from the founder's billing policy (2026-11-16) and the current
terms; it is not legal advice. Items marked ⚖ need a qualified adviser (England & Wales / Northern
Ireland).

## 1. Founder policy being implemented

- £1,000 setup fee: one-off, separate, **non-refundable** except where the law requires a refund.
- £500/month subscription: cancel any time from Settings → Billing, no need to contact support.
- Cancellation takes effect at the **end of the current paid period**; full access until then.
- No automatic pro-rata refund of unused days.
- A scheduled cancellation can be undone before it takes effect.
- After expiry: D-17 cancelled-company rules (owner read-only with billing + export; staff locked out).
- Cancelling never automatically deletes company data.

## 2. Clause-by-clause

| Section | Current published text (summary) | Proposed text | Why / conflict |
|---|---|---|---|
| **Billing** ¶2 | "Refunds are issued for unused prepaid time when you cancel; pro-rata." | "**Setup fee.** The setup fee is a one-off charge for setting up your workspace. It is charged once, separately from the subscription, and is non-refundable — including if you later cancel — except where the law requires a refund. **Subscription.** Your subscription renews monthly until you cancel. You can cancel at any time from Settings → Billing. Cancellation takes effect at the end of the current paid month: you keep full access until then and you won't be charged again. We don't refund unused days of a month you've already paid for, except where the law or these terms require it (see *Changes to these terms*). You can undo a scheduled cancellation from the same page at any time before it takes effect." | Current text promises pro-rata refunds — directly contradicted by the new policy. |
| **Billing** ¶1 | "Subscriptions auto-renew unless you cancel before the renewal date. … if a payment fails, your workspace becomes read-only first, and you have 30 days to pay or export before access is suspended." | Keep the first sentence. **Failed-payment sentence: flag — not changed by #1090.** | The code suspends immediately on `past_due` (decision D-06); the 30-day read-only promise does not match it today. Founder decision needed (see §4 F-5). |
| **Your data** | "When you cancel, we delete it within 30 days, except where tax law (HMRC) obliges us to retain it." | "Cancelling doesn't delete your data. After your subscription ends, the account owner can still sign in to download an export and invoices. We keep company records after cancellation in line with our retention policy and legal obligations (for example HMRC record-keeping), and you can ask us to delete your company's data at any time, subject to those obligations." | Current text promises deletion within 30 days; the policy is never auto-delete. ⚖ A retention period must be set and stated (UK GDPR storage limitation) — placeholder until the retention policy is approved. |
| **Termination** | "You can cancel at any time from the settings page or by emailing us." | "You can cancel at any time from Settings → Billing or by emailing us; see *Billing* for when cancellation takes effect." | Points to the new timing. |
| **Changes to these terms** | "…email account owners at least 30 days before the change takes effect… If you don't accept them, cancel before the effective date and we'll refund any unused prepaid time." | **Keep as is.** | This is a contractual refund commitment that protects customers from changes; the product's refund-review flag already routes these to a human. Removing it would itself be a change requiring notice. |
| New: **Checkout** | — | Checkout shows, before payment: setup fee one-off & non-refundable; subscription renews monthly, cancel any time, takes effect at period end, no refund of unused days except where required. (Implemented in #1090: `lib/billing/checkout-disclosure.ts`.) | Disclosure before payment. |

## 3. Existing customers — do NOT silently remove rights

- Customers who signed up under the current terms were promised (a) pro-rata refunds on cancellation
  and (b) deletion within 30 days. Under the current "Changes to these terms" clause, new terms bind
  them only **30 days after an email notice**, and a customer who cancels before that date is owed a
  refund of unused prepaid time.
- **Engineering handling in #1090:** nothing refunds automatically for anyone. Every immediate
  termination that cuts a paid period short raises an HQ **REFUND REVIEW** (`refund_review = pending`),
  and the HQ notice now says customers on the pre-2026-11 terms were promised pro-rata refunds. A
  scheduled (end-of-period) cancellation leaves no unused paid time, so the refund question does not
  arise — but **an existing customer who asks for pro-rata under the old terms before the new terms
  take effect must be honoured** (manual refund by the founder).
- The in-app copy never says "no refunds": it says there is no *automatic* refund and that "if your
  agreement with us or the law entitles you to a refund, we'll work it out and contact you".
- Production today: 2 organisations, 1 of them the internal HQ org — so at most one external customer
  is on the old terms. ⚖ confirm who, and send the 30-day notice before publishing.

## 4. Legal points to review ⚖ (flagged, not decided)

1. **Business customers vs consumers.** CrewFlow sells to businesses. The Consumer Contracts
   (Information, Cancellation and Additional Charges) Regulations 2013 (14-day cancellation right for
   distance contracts) and the Consumer Rights Act 2015 protect *consumers* (individuals acting outside
   their trade). A sole trader buying for their business is normally not a consumer. If CrewFlow could
   ever contract with a consumer, the non-refundable setup fee and no-refund rule need the statutory
   cancellation-period wording (and the express-request-to-start acknowledgement). Same law applies in
   Northern Ireland.
2. **Digital Markets, Competition and Consumers Act 2024 — subscription contract rules.** Consumer
   subscriptions only; commencement timing should be confirmed by the adviser. Not expected to apply
   to B2B, but confirm.
3. **Reasonableness (UCTA 1977) for standard B2B terms.** A non-refundable setup fee is generally
   defensible when clearly disclosed before payment and reflecting real set-up work; the adviser should
   confirm wording, and whether a refund is owed if CrewFlow fails to deliver the set-up.
4. **Refunds the law requires.** E.g. CrewFlow's own breach / failure to provide the service; the terms
   already keep "except where the law requires".
5. **F-5 (founder):** failed-payment handling — keep the published 30-day read-only grace (code change
   needed) or change the terms to match immediate suspension (needs notice).
6. **Retention period** to state in *Your data* once the retention policy is approved.

## 5. Approvals needed before publication

- [ ] Founder approves the proposed clauses in §2.
- [ ] Adviser review of §4 items 1–4.
- [ ] Decide F-5 (failed-payment grace) and the retention period.
- [ ] Send the 30-day change notice to existing account owners; publish on/after the effective date.
- [ ] Only then edit `app/terms/page.tsx` (separate PR).
