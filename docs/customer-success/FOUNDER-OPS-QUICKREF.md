# Founder Ops Quickref

One page. Bookmark these six places (no secrets here — sign in with your own accounts):
**Supabase** dashboard → project `crewflow` (`jzntbskdqdopzwdqwvkp`) · **Resend** → Logs · **Sentry** → the CrewFlow project · **Vercel** → crewflow web → Deployments · **CrewFlow HQ** → crewflow.uk/admin/ops · **GitHub** → crewflow1/web → Actions.

| Incident | FIRST check | SECOND check | Escalate when |
|---|---|---|---|
| **CREWFLOW DOWN** | crewflow.uk/api/health — if `db:"degraded"` it's the database (next row). If the page itself won't load: Vercel → Deployments → is the newest one failing? Click the previous good one → **Instant Rollback**. | Sentry (new errors?) + status.vercel.com | Rollback doesn't fix it within 15 min |
| **DATABASE PROBLEM** | Supabase dashboard → is the project **PAUSED**? (Shows up as the site saying db degraded / hosts not resolving — exactly the 25 Aug incident.) Resume it; the app heals itself. | status.supabase.com | Not paused and not a Supabase incident → engineering |
| **LOGIN BROKEN** | HQ → Customers → the org: status pill (suspended/pending bounces users) + last-login. Resend-invite button is right there. | Supabase → Authentication → Users (exists? confirmed? banned?) + Auth logs | An auth error you can't read → engineering |
| **EMAIL NOT ARRIVING** | Resend → Logs (bounce / spam / quota) — invoice & quote sends live here. | Supabase → Auth → SMTP settings + Auth logs (login links/resets ride SMTP; port must stay **587**) | Resend shows delivered but customer insists not → have them check spam, then engineering |
| **BAD DEPLOY** | Vercel → Deployments → previous good → **Instant Rollback** (seconds, always safe — app is stateless, migrations are additive; never "roll back" a migration) | GitHub Actions — was CI red on that merge? | App still broken after rollback |
| **CUSTOMER REPORTS WRONG DATA** | In-app tools first: invoice **Void**, job **Cancel/Reopen**, Imports → **Rollback**. | If it smells like corruption/loss: STOP, write down the exact UTC time, do NOT keep clicking — read the Database-Incident section in FIRST-CUSTOMER-SUPPORT.md | Anything needing a restore → engineering ON THE CALL before touching Supabase Backups (restores are destructive) |

**Weekly 2-minute habit:** open /admin/ops (all green?), Sentry (new issues?), Resend logs (failures?). That's the whole monitoring routine until customer #5.

**Backups:** a dated logical backup lives in `~/CrewFlow-backups/` (see its README for the rehearsed 2-minute restore route). Refresh it monthly — the exact command set is in that README — and keep a copy on encrypted off-machine storage.
