# HQ Completion — Home · Cmd+K · Decision UX · Boardroom

Finishing the four deferred HQ pieces (after the perf + HQ-IA wave was approved),
plus the employee-detail audit and mobile HQ. Local-first; not merged, not
deployed. The governance kernel (`server/sdk/*`, DB triggers, append-only
histories) is untouched — every change here is presentation.

## 1. HQ Home — the canonical front door (`app/admin/page.tsx`)

`/admin` was a redirect to `/admin/command-centre`. It is now ONE attention-first
executive Home that answers, in ~10 seconds: **what needs me · what's happening ·
what just finished · the CEO brief · is anything wrong**. Attention, not metrics —
no vanity charts.

Five sections, each an independently-streamed server component
(`app/admin/_components/hq-home.tsx`), each degrading to an honest empty/error
state:

| Section | Real source | Honesty guardrail |
|---|---|---|
| A. Needs your attention | `loadExecutiveAssistantBoard()` digest (approvals + decisions + tasks + alerts), deep-linked per source | a queue that can't be read says so; never a false "all clear" |
| B. Active now | `getTaskQueueOverview()` — the REAL `hq_ai_tasks` engine | NOT the human-authored boardroom notes; "nothing running" stated plainly |
| C. Recent outcomes | `getTimelinePage()` event spine | real events only |
| D. CEO brief | `getCeoBriefingArchive().latest` deterministic briefing | generative narrative is dark in prod → empty-state handled, never faked |
| E. System health | `buildOpsSnapshot()` | **exceptions only**; when green, one calm line — no telemetry dump |

The heaviest read (alerts, inside the digest) is isolated to section A's Suspense
boundary so it can never block B–E.

### The five former "Home-like" surfaces
Kept as **secondary deep views**, linked from Home's footer, because each has real
depth: **Command centre** (company metrics), **CEO board** (departmental
drill-down), **Morning briefings** (brief archive), **Overview** (KPI snapshot),
**Pulse** (activity feed). Home is now the front door; they are the deep dives.

Nav (`app/admin/_nav/hq-nav-model.ts`): the Home area's landing is now `/admin`
with those five demoted to children. Longest-match active resolution means
`/admin` only wins for the exact path.

## 2. HQ Cmd+K — role-gated (`app/admin/_components/hq-command-palette.tsx`)

A separate palette from the product one, rendered ONLY inside the HQ layout
(behind `requireHqPage`) — so a customer can never receive an HQ command
(role-gating by construction, not a runtime check that could drift). Sources, all
in-memory (extremely fast, no round-trip):
- **Go to** — every HQ area/child from the one nav model (`hq-commands.ts`).
- **Show** — pending approvals · blocked work · recent outcomes · failed runs · what needs you (real destinations only; never an autonomous-execution shortcut).
- **AI employees** — client-filtered from the roster the layout passes in.
Opens on ⌘K, the sidebar "Search HQ" pill, or the mobile top-bar search button
(`cf:hq-command-open`).

## 3. Decision UX — one state language (`lib/hq/presentation-state.ts`)

A pure, UI-importable mapper (no kernel import — like `gate.ts`/`state.ts` stay
pure) turns four engine vocabularies into one eight-word language:
**Needs decision · Needs approval · Draft · Ready · Executing · Completed ·
Rejected · Failed**, with an honest as-is escape hatch. Rendered by one
`DecisionStateBadge` + a learnable `DecisionStateLegend`
(`app/admin/_components/decision-state.tsx`).

The load-bearing honesty decisions:
- an approval `approved` → **Ready** (granted; the executor is dark, nothing ran) — NOT Completed;
- a decision `approved` → **Completed** (recording the call is the whole act) — the same word, a different truth;
- `expired` / `delayed` / `delegated` / `blocked` / `cancelled` / `abandoned` / `skipped` keep their OWN name — never forced into a wrong bucket.

Adopted on: Approvals, Decision Centre, Workflow sagas, the Task queue, the "What
needs you" digest, and HQ Home. The digest also gained the missing **deep-links**
(each row now routes to its source). No enum, transition table, or authority
changed.

## 4. Boardroom — off the dark island (`app/admin/ai-boardroom/*`)

Re-skinned onto the light operational system (Stripe clarity / Linear density /
Apple restraint): removed the `bg-slate-950` roots, the radial-glow divs, the
`bg-*-500/15 text-*-300` blended pills, the neon accent `glow`/`ring`, and
`animate-ping`. All status/task/accent/approval tones remapped onto the
AA-verified `components/ui/tokens` bundles; built on `PageHeader` / `StatTile` /
`Badge` / `Button`.

- **Roster card** now communicates only the seven things a leader reads at a
  glance — name, role, department, status, current focus, last activity, approval
  rung — with a "Needs your approval" flag when `waiting_approval`. The deeper
  Confidence/ETA/Health cards moved to the employee workspace (also dropping a
  heavy read off the roster's hot path).
- **Preserved**: the `DEPARTMENTS`-driven grouping, the "Framework mode · no
  autonomous execution" banner, and the honest `insufficient`→neutral card logic
  (never green over absent data).

## 5. Employee detail (`app/admin/ai-boardroom/[slug]/page.tsx`)

Re-skinned light and reorganised exec-first: **Responsibility → Now → Recent
output → Waiting on you → What failed → Authority → Telemetry → Configure**, with
all implementation noise (20k system-prompt, capability tokens, raw scopes, the
approval evidence strings, the audit log, the config/memory editors) collapsed
into one native `<details>` "Technical detail". Every form + field name preserved;
`current_task`/logged activity labelled as configured state, never autonomous
output.

## 6. Mobile HQ
Verified at **320 / 375 / 390 / 430** — no horizontal overflow on Home, Needs
your attention, Approvals, Decisions, CEO briefings, or AI workforce. Mobile top
bar gained a search button; the grouped drawer is unchanged.

## 7. Performance
Preserved the prior wave (staleTimes, Suspense streaming, server-first shell,
request memoisation, non-blocking dashboard write, parallel safe reads). HQ Home
and every rebuilt HQ page are **server components**; the only new client JS is the
~10KB Cmd+K palette (+ a tiny roster prop). No giant client-side HQ bundle.
