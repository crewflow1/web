# CrewFlow Engineering Maturity — Durable Reference

This directory is the human-readable engineering reference that survives without
session history. It exists to raise the maturity categories that can be raised by
**engineering** (documentation, maintainability, bus-factor, architecture
clarity) and to state, precisely and honestly, which categories can only be
completed by **external proof** (staging provisioning, a live monitoring backend,
an external pentest, real provider credentials, real traffic, human staffing).

| Doc | Raises | What it gives you |
|---|---|---|
| [CORRECTNESS-GUARDS.md](CORRECTNESS-GUARDS.md) | Maintainability, Architecture, Bus-factor | Every source-scanning meta-test: the defect class it protects, how it works, how to satisfy it *correctly* (never by weakening it), and the tracked brittleness debt. |
| [SUBSYSTEM-OWNERSHIP.md](SUBSYSTEM-OWNERSHIP.md) | Bus-factor, Documentation | Per-subsystem purpose, path, invariants, failure mode, recovery, and owner (TBD → the CEO assignment action). |
| [EXTERNAL-PROOF-READINESS.md](EXTERNAL-PROOF-READINESS.md) | Infrastructure, Observability, Deployment, Ops, Security, Product | What is engineering-ready for staging / Sentry / pentest / DR / load / providers, and the exact CEO/operator action that turns each into proof. |

## The honesty contract

Nothing in this repo claims an externally-dependent proof as complete. Where the
remaining maturity requires a resource an engineering session cannot provision —
a staging account, a Sentry DSN, a pentest firm, provider credentials, HMRC
recognition, PITR, or a named human owner — the docs say **"ENGINEERING COMPLETE
/ EXTERNAL PROOF REQUIRED"** and name the action. This is deliberate: a fabricated
100 is worth less than an honest 100-minus-the-external-proof.
