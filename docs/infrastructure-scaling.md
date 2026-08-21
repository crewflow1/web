# Infrastructure sizing and the scaling ladder

How CrewFlow decides what to pay for. Written 2026-08-21 after the
infrastructure cost audit, from measured production metrics — not from
codebase size, route count, or customer projections.

The governing principle: **scale when demand appears, not months before.**
Over-provisioning is not "safety margin", it is a bill for capacity that also
masks the workload problems you would otherwise notice. The audit found exactly
that — a database at 1.2% CPU whose largest query was crons logging that they
had nothing to do.

---

## Current state

|                      |                                                                           |
| -------------------- | ------------------------------------------------------------------------- |
| Supabase compute     | **Medium** — 2 shared vCPU, 4 GB RAM, 120 direct / 600 pooled connections |
| PITR                 | **7 days** — keep; see `docs/backup-recovery-runbook.md`                  |
| Vercel build machine | **Enhanced** — 8 cores, 16 GB, selection `fixed`                          |

### Why Medium, not Large

Measured over a 32-day window on Large (2 dedicated vCPU, 8 GB):

| Metric                           | Measured | Large capacity    | Utilisation    |
| -------------------------------- | -------- | ----------------- | -------------- |
| CPU (32-day average)             | 1.20%    | 2 cores           | ~1%            |
| CPU (observed peak, 30 s window) | 6.98%    | 2 cores           | ~7%            |
| Memory                           | 0.92 GB  | 8.10 GB           | 11.4%          |
| Disk I/O busy                    | 0.69%    | 630 MB/s baseline | <1%            |
| Connections                      | 6–13     | 160               | ~8%            |
| Database size                    | 240 MB   | —                 | —              |
| Cache hit ratio                  | 99.988%  | —                 | fully resident |

The single trade-off in the move is **dedicated → shared vCPU**: Large is the
smallest tier with dedicated cores. At a ~1% duty cycle burst credits cannot
deplete, so this is a real change but not a risk. Medium keeps ~1 GB
`shared_buffers`, still roughly four times the entire database.

Small (2 GB, $15/mo) is defensible on these numbers and is the natural next step
down, but it leaves only ~2.2x memory headroom over the working set. Take it
only after a sustained observation window on Medium shows memory flat.

### Why Enhanced, not Standard, for builds

Vercel meters **build minutes x machine cores**, so a smaller machine is
normally cheaper. Standard (4 cores) was tried first and **failed**: the build
runs `NODE_OPTIONS=--max-old-space-size=6144`, and a 6 GB heap on an 8 GB
machine thrashed — a production build that takes 4.6 min on a large machine ran
36 minutes without finishing and had to be cancelled.

**The binding constraint on the build machine is MEMORY, not cores.** Enhanced
(8 cores / 16 GB) holds the 6 GB heap comfortably and is the empirically proven
configuration: 864 builds at a 3.84 min median.

Do not re-enable `elastic` build-machine selection. Left to itself it escalated
this project to a 30-core / 60 GB "Turbo" machine that built the same commit
**22% slower** for **4.5x the price** — a Next.js build does not parallelise
that wide, so the extra cores only multiplied the meter.

If the build ever needs more memory, raise the machine deliberately and record
why here.

---

## The ladder

Three bands per signal. **WATCH** means look at it this week; **UPGRADE** means
do it now. Crossing WATCH is not authority to upgrade — investigate first.

| Signal                | NORMAL         | WATCH         | UPGRADE                             |
| --------------------- | -------------- | ------------- | ----------------------------------- |
| CPU, 1-hour average   | < 20%          | 20–40%        | **> 50% sustained 24h**             |
| CPU, 5-minute peak    | < 40%          | 40–70%        | **> 80% recurring daily**           |
| Memory in use         | < 50%          | 50–65%        | **> 75%**                           |
| Cache hit ratio       | > 99.5%        | 98–99.5%      | **< 98%**                           |
| Direct connections    | < 40% of limit | 40–60%        | **> 70%**                           |
| p95 query latency     | < 100 ms       | 100–250 ms    | **> 300 ms** — see note             |
| Replication / WAL lag | none           | any sustained | growing                             |
| Database size         | < 5 GB         | 5–20 GB       | **> 20 GB** (review disk with tier) |

**The latency note is the important one.** p95 crossing a threshold is a
signal to _investigate queries_, not to buy hardware. The audit's central
finding was a workload that was ~50% self-inflicted telemetry; a bigger machine
would have hidden it. Rule: **a query fix must be ruled out before a tier
change is proposed.**

Customer count is a scheduling trigger, never a sizing one — hold a capacity
review at 25 and 75 paying organisations, and let the table above decide.

### Order of escalation

1. Fix the workload (indexes, N+1, cron frequency, dark-feature polling).
2. Then connection pooling, if connections are the pressure.
3. Then compute tier — one step at a time: Medium → Large → XL.

Each step is reversible and takes ~30 seconds of database restart. Resizing is
cheap; discovering you never needed it is cheaper.

---

## How to read the metrics

```
GET https://<project-ref>.supabase.co/customer/v1/privileged/metrics
Authorization: Basic base64("service_role:<service_role_key>")
```

Prometheus exposition. The counters that matter:

- `node_cpu_seconds_total` — sum non-`idle` modes over the total for the
  utilisation share. These are **cumulative since boot**, so a single scrape
  gives a lifetime average; diff two scrapes ~30 s apart for a current rate.
- `node_memory_MemTotal_bytes` / `node_memory_MemAvailable_bytes` — in use is
  total minus available. Do **not** use `MemFree`; it ignores reclaimable cache.
- `node_load1` / `node_load5` / `node_load15` — divide by core count.
- `pg_stat_database_num_backends` — against `max_connections`.

A compute resize restarts Postgres, which **resets these counters**. Capture a
baseline before any resize or the before/after comparison is lost.

---

## Cost guardrails

Neither platform exposes spend limits or budget alerts through its public API —
both are dashboard-only settings.

Prefer **alerts over caps**. A hard spend cap on Vercel can pause a project when
hit, which would take `crewflow.uk` offline to save money — the wrong trade for
production. Set notification thresholds and act on them.
