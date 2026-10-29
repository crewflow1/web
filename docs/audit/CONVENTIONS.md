# CrewFlow Feature & Button Audit — shared conventions (2026-10-28, main 128dc5aa)

STATUS legend (every feature/button MUST carry one):
- LIVE & WORKING — code complete AND corroborated (deployed migration, prod health, or a passing test exercising it).
- IMPLEMENTED, NOT LIVE-VERIFIED — code complete; operation not browser-confirmed in this audit (DEFAULT for most; honest).
- PARTIALLY IMPLEMENTED — some paths exist, others stubbed/TODO.
- FLAGGED OFF — implemented but hidden/disabled by a FEATURE_* flag or `flag:` nav gate (name the flag).
- PLACEHOLDER / COMING SOON — visible/coded, no real function.
- BROKEN — reproducible evidence of failure (cite it).

Roles: owner, admin, staff ONLY (ADMIN_ROLES = owner+admin). No manager/supervisor role exists.
Evidence: cite `path:line` for every non-trivial claim. Never invent a button/feature. If unverifiable, say so.
Browser verification was NOT performed (authenticated multi-role prod access out of scope) — classify from code + known prod state; record this limitation.
