# DPIA-04 — Vehicle telematics (Samsara, Verizon Connect)

Draft 2026-11-16 · for `[LEGAL REVIEW]` · CrewFlow role: **processor**; the **tenant is the employer** monitoring its vehicles/drivers.

**Status.** DARK. Needs `NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT=true` + `TELEMATICS_*` credentials + a bound provider (`lib/integrations/telematics/oauth.ts`); `telematics_connections` = 0 and `telematics_readings` = 0 in production. With the flag off, `server/services/telematics-sync.ts` returns `{ ran: false }` before creating any client or contacting a provider. Cron `/api/cron/telematics-sync` runs every 15 minutes (`vercel.json`).

## 1. Nature of the processing
- A tenant admin connects its Samsara or Verizon Connect account (OAuth; tokens encrypted with `lib/integrations/token-crypto`, `server/services/telematics-connections.ts`).
- The cron pulls location/odometer samples per vehicle and appends them to `telematics_readings` (service-role writer only; composite FKs pin vehicle and connection to the same org): `id, org_id, vehicle_id, connection_id, source_event_id, recorded_at, latitude numeric(9,6), longitude numeric(9,6), odometer_miles` (migration `20261103…`, mapper `lib/integrations/telematics/reading-map.ts`).
- The product records **vehicle** position, not a driver identity. A vehicle is linked to a person only indirectly (fuel logs `driver_id`, job assignments, a driver's fleet assignment). In a small firm a van usually equals one named person, so the vehicle's location history **is** personal data of that worker.
- Display: vehicle detail page `app/(app)/fleet/vehicles/[id]/page.tsx`. Odometer feeds fleet maintenance/compliance. CrewFlow does not produce driver-scoring, harsh-braking or speed data (not mapped).
- Retention: `telematics_readings` is one of the 10 tables a tenant can put under a retention policy (`lib/retention/policy.ts`); **no default exists** and `FEATURE_RETENTION_PURGE` is off, so readings are kept indefinitely unless a tenant acts.
- Related control already built: clock-in no longer accepts GPS (`__tests__/security/clock-in-no-location.test.ts`) and the Permissions-Policy denies browser geolocation (`geolocation=()`).

## 2. Necessity and proportionality
- Purposes the **tenant** may legitimately have: fleet utilisation, theft recovery, maintenance by mileage, proof of attendance at a site, insurance. Purposes that need extra care: continuous tracking out of working hours, private use, performance management.
- UK employer guidance (ICO monitoring workers; ICO vehicle tracking): the tenant must tell drivers, have a policy, limit tracking to work time or allow a privacy switch for private use.
- Proportionality gaps in CrewFlow's design: a 15-minute poll bound is moderate; position history is stored forever by default (no default window); no "private-use / off-duty" suppression; no driver-facing notice surface in the product. `[FOUNDER]` decide defaults.
- Lawful basis (tenant): legitimate interests; **not** consent (employee consent is rarely valid). Special-category inference (place of worship, clinic) is possible from raw history → minimise precision/retention.

## 3. Risks
| # | Risk | L | S | Inherent |
|---|---|---|---|---|
| R1 | Continuous location history of identifiable workers, including out-of-hours | Medium | High | High |
| R2 | Drivers unaware of tracking | Medium | High | High |
| R3 | Indefinite retention | High | Medium | Medium-High |
| R4 | Function creep (discipline, pay) | Medium | Medium | Medium |
| R5 | Cross-tenant exposure of readings | Low | High | Medium |
| R6 | Provider token compromise exposes live positions | Low | High | Medium |

## 4. Measures and residual risk
| Risk | Measure (evidence) | Gap / proposal | Residual |
|---|---|---|---|
| R1 | Dark; coarse 15-min pull; no driver-scoring data | Off-duty suppression window; default retention (e.g. a short period) — **founder to set; do not build until set** | High until decided |
| R2 | none in product | Driver notice template in tenant guidance / onboarding `[FOUNDER]` | High until addressed |
| R3 | Retention policy mechanism exists (allow-listed table) but unused | Default policy at connection time, `[FOUNDER]` period | Medium |
| R4 | Append-only, no scoring | Tenant policy template | Low-Medium |
| R5 | RLS + composite FKs; writes service-role only | — | Low |
| R6 | Encrypted tokens | Rotate on disconnect | Low |

## 5. Sign-off
Do not activate telematics for a tenant until R1-R3 are closed. `[LEGAL REVIEW]` ______ · `[FOUNDER]` ______.
