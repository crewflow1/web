# Customer #1 Launch Checklist

Tick top to bottom. The detailed how-to for each block is in FIRST-CUSTOMER-ONBOARDING.md; support paths in FIRST-CUSTOMER-SUPPORT.md; incident one-pager in FOUNDER-OPS-QUICKREF.md.

## BEFORE CONTRACT
□ Company name + trading address □ Company number □ Owner contact (name/mobile/email — **the email they'll log in with**) □ Billing contact □ Employee count + subbies □ VAT registered? scheme? VAT number □ CIS contractor? UTR □ Current tools (quotes/invoices/payroll/safety — what we're replacing) □ Expected CrewFlow users (who is admin vs field) □ Founder-assisted onboarding agreed (half-day setup + 60-min owner training + 15-min crew training + daily check-ins wk 1) □ Payment terms agreed (billing is off-platform: £1,000 setup + £500/mo invoiced manually)

## BEFORE ACCOUNT CREATION (all green the same day)
□ crewflow.uk/api/health → `healthy`, `db:"ok"` □ Migration parity clean (ask engineering or trust CI green) □ **Supabase: plan tier confirmed + daily backups visible + PITR enabled** (dashboard → Database → Backups) □ Fresh dated logical backup in ~/CrewFlow-backups/ (<7 days old) □ Sentry open + quiet □ Resend logs clean □ Auth email proven (send yourself a password reset from crewflow.uk/reset-password — arrives within a minute from auth@crewflow.uk)

## CUSTOMER DATA (collect before Day −1, any format — CSV/Excel/PDF/photos import)
□ Team list (name, email, mobile, role, hourly pay, emergency contact) □ Role split agreed (owner/admin = office+money; staff = field — **staff cannot see prices/invoices; say this up front**) □ Customer list □ Supplier list + payment terms □ Live jobs (customer, site address, dates, value, crew) □ Open quotes □ Outstanding invoices + payments received □ Price list / rate card (manual entry — budget 30–60 min) □ Vehicles/assets (manual) □ Staff tickets (CSCS/SMSTS/first-aid + expiry dates)

## ACCOUNT SETUP (founder, Day −1)
□ Approve demo request in HQ with the owner's login email □ Owner signs up → org created → wizard □ Organisation: address/phone/logo/bank details/default terms □ VAT number + Tax defaults (FY start month, default VAT, CIS rate) □ CIS contractor UTR (on /cis) □ Invite admin(s) □ Invite site manager(s) + workers as **staff** □ Import data in order: customers → suppliers → jobs → invoices → payments → costs □ Price book + assets + tickets by hand □ RAMS generated + issued for each live job □ Worker-portal links issued for any subbie operatives

## TRAINING
□ Owner (60 min): dashboard briefing · lead→quote→e-sign→job · invoice→payment · **void invoice + cancel job escape hatches** · reports/VAT/CIS · month-end □ Admin (with owner or separate 30 min): imports, rota, timesheet review □ Site manager (15 min, on phone): job, diary, photos, RAMS, snags, toolbox □ Workers (15 min, on phones): My Day → clock in/out → today's job → sign RAMS → photo

## GO LIVE (Day 0)
□ Owner logs in fine □ Every invited user logged in (HQ shows last-login) □ Workers' **My Day** shows today's rota + their assigned jobs □ Live jobs look right (site address, crew, dates) □ RAMS visible + at least one real sign-off □ First real quote created & sent □ First real job running □ First real invoice sent □ Customer confirms the email arrived (not spam) □ One worker does the full loop on their own phone (clock in → photo → diary → clock out)

## 24 HOURS
□ Sentry: no new errors □ Resend: no failed sends □ Supabase Auth logs: no failed logins piling up □ /admin/ops: crons green □ Call the owner: "anything confusing? anything you went back to the spreadsheet for?"

## 7 DAYS
□ Issue list reviewed (anything P0/P1 → engineering immediately) □ Friction list (where did they hesitate — training vs product?) □ Usage: every seat logged in this week? timesheets flowing? diary daily? □ Data quality: invoices/payments recorded properly? quotes real? □ Write down P2s **with the customer evidence attached** — that list drives the next engineering wave, nothing else does

## 30 DAYS
□ Owner review meeting: month-end walk-through (invoiced/paid/overdue/job profit/VAT/CIS figures vs their accountant) □ ROI conversation (hours saved, what they stopped using) □ Ask for testimonial / case-study permission □ Confirm continuation + invoice month 2 □ Convert the evidence pile into the ranked P2 list for the post-freeze wave

---

## APPENDIX — Customer Onboarding Pack (send/collect before account creation)

**1. Information we need:** legal name, company number, trading address, owner login email + mobile, billing contact, employee/subbie counts, VAT status+scheme+number, CIS contractor status+UTR, financial-year start month, list of current tools being replaced.
**2. Files we need (any format — CSV/Excel/PDF/photos all import):** customer list · supplier list (+payment terms) · live jobs (customer, site address, dates, value, crew) · open quotes · outstanding invoices + payments received · costs to date · price list/rate card · vehicle/asset list · staff ticket scans or a list with expiry dates.
**3. Users we need:** every person who'll log in — name, email, mobile; which are office vs site.
**4. Permissions/roles:** owner/admin = office + money (sees prices, invoices, reports); staff = field (My Day, jobs, diary, photos, safety — cannot see money). Subbie operatives who only sign RAMS need no account (we send a signing link).
**5. Financial configuration:** VAT number + scheme (standard/cash/flat-rate), CIS UTR + default deduction rate, bank details for invoices, default payment terms, invoice numbering start if continuing a sequence.
**6. Site/safety information:** live sites + addresses, which jobs need RAMS/permits on day one, any existing RAMS to re-key, toolbox-talk cadence, who the competent person is.
**7. What CrewFlow does today:** quotes with online e-sign acceptance → auto job + invoice · job management (programme, diary, photos, drawings, snags, variations, valuations, retention) · site & safety (RAMS, permits, toolbox talks, inductions, muster, worker signing links) · staff (rota, clock-in/out timesheets, leave, tickets, payroll *estimates*) · money (invoices, payments, costs, POs + 3-way matching, job profitability, aged debtors, VAT/CIS *figures*, accountant CSV exports) · customer portal · works on phones, core field actions work offline.
**8. What CrewFlow does NOT do yet (say it plainly):** no card payments in-product (invoices are paid by bank transfer; billing us is manual too) · does not FILE VAT/CIS/RTI with HMRC (it prepares the figures; keep your accountant/payroll filing route) · payroll figures are estimates, not payslips of record · no accident/RIDDOR log (keep the paper accident book) · no live bank feed (statement CSV reconcile) · no quote discounts/duplication yet · SMS/WhatsApp notifications off (email + in-app only).
**9. Support expectation:** founder-assisted — Moe personally sets up your account, imports your data, trains the team, checks in daily for week one and weekly after; support answer within the working day; your data is exportable on request at any time.
