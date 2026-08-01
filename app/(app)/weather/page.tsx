import type { ReactNode } from "react";
import { requireOrgContext } from "@/server/auth/session";
import { readWeatherWatches } from "@/server/services/weather";
import {
  getWeatherReadiness,
  weatherStatusLine,
  datasetInfo,
  WORK_TYPES,
  WORK_TYPE_LABELS,
  WORK_TYPE_THRESHOLDS,
  FULLY_UNSOURCED_WORK_TYPES,
  UNSOURCED_THRESHOLD_COUNT,
  ALL_THRESHOLDS,
  isSourced,
  msToMph,
  type Threshold,
  type WorkType,
} from "@/lib/weather";
import { Badge, Table, THead, TBody, TR, TH, TD } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Weather · CrewFlow" };

/**
 * /weather — the weather intelligence surface, DARK.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PAGE DELIBERATELY DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 * It renders NO weather. Not a placeholder temperature, not a greyed-out
 * forecast card, not a "sample" seven-day strip. No provider is connected, so
 * there is no weather to show, and a mock-up of one on a live operational screen
 * is the single most dangerous thing this page could contain: a site manager who
 * skim-reads a demo forecast and books a pour on it has been actively misled by
 * their own software. Fake data on a safety-adjacent surface is not a design
 * placeholder, it is a hazard.
 *
 * It also does NOT produce an extension-of-time output. That is a different
 * problem — contractual entitlement, not work viability — and the cache these
 * thresholds read from is explicitly not evidence (see the migration header).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES SHOW, all of which is true today
 * ═══════════════════════════════════════════════════════════════════════════
 *   1. THE READINESS STATE, prominently and in plain words, including every
 *      blocker. Modelled on the quote-writer panel's dark state: "built and
 *      switched off" is a far more useful thing to tell an operator than "not
 *      configured", and it is what stops a support ticket.
 *
 *   2. THE THRESHOLDS, WITH THEIR SOURCES. This is real reference content and
 *      it is useful with no provider whatsoever — it is the answer to "at what
 *      wind speed do we stop lifting, and who says so", which a foreman
 *      currently has to look up in four different documents. Every row states
 *      its own provenance, and the rows resting on a CrewFlow default rather
 *      than a published standard are marked as such, because presenting our own
 *      guess with the same authority as BS 8500 would be dishonest.
 *
 *   3. THE SHAPE of the eventual surface, described in words rather than
 *      mocked in pixels.
 *
 *   4. THE WATCH LIST — the org's own configuration, which exists independently
 *      of any provider (and is empty, because nothing creates one yet).
 *
 * STRICTLY READ-ONLY. No form, no server action, no mutation.
 */
export default async function WeatherPage() {
  const { ctx } = await requireOrgContext();
  const readiness = getWeatherReadiness();
  const watches = await readWeatherWatches(ctx.org.id);

  const sourcedCount = ALL_THRESHOLDS.length - UNSOURCED_THRESHOLD_COUNT;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Weather</h1>
        <p className="mt-1 text-sm text-slate-600">
          Whether the weather lets the work happen — concrete, lifting, roofing, groundworks
          and external trades, against the limits UK practice actually sets.
        </p>
      </header>

      <ReadinessPanel readiness={readiness} />

      <WatchPanel count={watches.length} />

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">
            The limits CrewFlow will apply
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            These are live in the build and fully tested — they are what a forecast will be
            checked against the moment one is connected. {sourcedCount} of{" "}
            {ALL_THRESHOLDS.length} rest on a regulation, a British/ISO standard or published
            trade guidance. The other {UNSOURCED_THRESHOLD_COUNT} are CrewFlow&rsquo;s own
            defaults, marked below, because the hazard is real but nobody publishes a number.
          </p>
        </div>

        <div className="divide-y divide-slate-100">
          {WORK_TYPES.map((workType) => (
            <WorkTypeBlock key={workType} workType={workType} />
          ))}
        </div>

        <div className="border-t border-slate-200 bg-amber-50 px-4 py-3">
          <p className="text-xs text-amber-900">
            <span className="font-semibold">Advisory only.</span> None of this discharges a
            duty under CDM 2015, the Work at Height Regulations 2005 or LOLER 1998. A
            competent person must assess the actual site — a forecast for a postcode district
            is an input to that judgement, never a substitute for it. Where a crane is
            involved, the manufacturer&rsquo;s own in-service wind speed governs and is
            frequently far lower than the figures below.
          </p>
        </div>
      </section>

      <EventualShapePanel />
    </div>
  );
}

/**
 * The readiness state. Wording comes from `weatherStatusLine` so the honest
 * sentence lives beside the logic that decides it, and a test asserts the dark
 * state never claims to be anything else.
 */
function ReadinessPanel({ readiness }: { readiness: ReturnType<typeof getWeatherReadiness> }) {
  const built = readiness.decisionLayerImplemented;
  const geo = datasetInfo();

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Status</h2>
        <Badge tone={readiness.available ? "emerald" : "amber"}>
          {readiness.available ? "Active" : "Not configured"}
        </Badge>
      </div>

      <p className="mt-2 text-sm text-slate-700">{weatherStatusLine(readiness)}</p>

      {built && !readiness.available ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Fact label="Work thresholds and decision logic" ok>
            Built and tested in this release
          </Fact>
          <Fact label="Weather provider" ok={false}>
            None connected
          </Fact>
          <Fact label="Location lookup" ok={readiness.districtResolutionAvailable}>
            {readiness.districtResolutionAvailable
              ? `Built in — ${geo.districtCount.toLocaleString("en-GB")} UK postcode ` +
                `districts resolve to a coordinate (${geo.version}). District-level ` +
                `accuracy: in a rural district the point can sit well away from the site.`
              : "No postcode-to-coordinate source in this build"}
          </Fact>
          <Fact label="Weather data held" ok={false}>
            None. Nothing is being fetched or stored.
          </Fact>
        </div>
      ) : null}

      {readiness.blockers.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Outstanding to activate
          </p>
          <ul className="mt-1 space-y-1 text-xs text-slate-600">
            {readiness.blockers.map((b) => (
              <li key={b} className="flex gap-2">
                <span aria-hidden className="text-slate-400">
                  &bull;
                </span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {readiness.strandedCredentialRisk ? (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
          A weather provider credential is set in this environment for a vendor whose adapter
          does not exist in this build, so nothing can use it. Either finish that vendor&apos;s
          integration or remove the credential — a key that nothing reads is an invitation for
          some future call site to read it directly and bypass this seam.
        </p>
      ) : null}

      {readiness.districtResolutionAvailable ? (
        // The Open Government Licence requires these lines wherever ONSPD-derived
        // data is used, and the location-lookup capability shown above is exactly
        // that. datasetInfo() carries them so the wording lives with the dataset.
        <p className="mt-3 text-[11px] leading-4 text-slate-400">
          Location lookup derived from the ONS Postcode Directory.{" "}
          {geo.attribution.join(". ")}.
        </p>
      ) : null}
    </section>
  );
}

function Fact({
  label,
  ok,
  children,
}: {
  label: string;
  ok: boolean;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-800">
        {/* The word carries the state; the colour only reinforces it. */}
        <Badge tone={ok ? "emerald" : "slate"} variant="soft">
          {ok ? "Ready" : "Missing"}
        </Badge>
        <span>{children}</span>
      </p>
    </div>
  );
}

function WatchPanel({ count }: { count: number }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">Locations being watched</h2>
      {count === 0 ? (
        <p className="mt-1 text-sm text-slate-600">
          None. Once a provider is connected, CrewFlow will watch the postcode district of
          each live job and keep its forecast warm.{" "}
          <span className="text-slate-500">
            Weather is cached per postcode district and shared across the whole platform, so
            two firms working in the same district cost one lookup between them — and no
            customer&rsquo;s full postcode is ever stored against a forecast.
          </span>
        </p>
      ) : (
        <p className="mt-1 text-sm text-slate-600">
          {count} {count === 1 ? "district" : "districts"} watched. No provider is connected,
          so nothing is being fetched for them.
        </p>
      )}
    </section>
  );
}

/** One work type and its thresholds, with provenance on every row. */
function WorkTypeBlock({ workType }: { workType: WorkType }) {
  const thresholds = WORK_TYPE_THRESHOLDS[workType];
  const fullyUnsourced = FULLY_UNSOURCED_WORK_TYPES.includes(workType);

  return (
    <div className="px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{WORK_TYPE_LABELS[workType]}</h3>
        {fullyUnsourced ? (
          <Badge tone="amber" variant="soft">
            No published thresholds exist
          </Badge>
        ) : null}
      </div>

      {fullyUnsourced ? (
        <p className="mt-1 text-xs text-amber-800">
          Every figure here is a CrewFlow default. Ground conditions depend on soil type,
          groundwater and support, none of which a forecast reports — treat these as a
          starting point for a competent person, not as limits.
        </p>
      ) : null}

      <div className="mt-3">
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Condition</TH>
              <TH numeric>Limit</TH>
              <TH>Effect</TH>
              <TH hideBelow="md">Source</TH>
            </TR>
          </THead>
          <TBody>
            {thresholds.map((t) => (
              <ThresholdRow key={t.id} threshold={t} />
            ))}
          </TBody>
        </Table>
      </div>
    </div>
  );
}

/** Wind figures get an mph gloss, because that is the unit a UK site talks in. */
function limitText(t: Threshold): string {
  const direction = t.comparator === "below" ? "below" : "above";
  if (t.unit === "m/s") {
    return `${direction} ${t.value} m/s (${Math.round(msToMph(t.value))} mph)`;
  }
  return `${direction} ${t.value} ${t.unit}`;
}

function ThresholdRow({ threshold: t }: { threshold: Threshold }) {
  const sourced = isSourced(t);
  return (
    <TR>
      <TD>
        <span className="text-slate-800">{t.rule}</span>
      </TD>
      <TD numeric muted>
        {limitText(t)}
      </TD>
      <TD>
        <Badge tone={t.severity === "blocking" ? "red" : "amber"} variant="soft">
          {t.severity === "blocking" ? "Stop work" : "Review"}
        </Badge>
      </TD>
      <TD hideBelow="md" muted>
        <span className="text-xs">{t.source}</span>
        {!sourced ? (
          <span className="mt-1 block">
            <Badge tone="slate" variant="soft">
              CrewFlow default
            </Badge>
          </span>
        ) : null}
      </TD>
    </TR>
  );
}

/**
 * The shape of the eventual surface, in words. Deliberately prose and not a
 * greyed-out mock: a wireframe of a forecast card on a live screen is exactly
 * the thing that gets mistaken for a real one.
 */
function EventualShapePanel() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">What this becomes when connected</h2>
      <ul className="mt-2 space-y-2 text-sm text-slate-600">
        <li className="flex gap-2">
          <span aria-hidden className="text-slate-400">
            &bull;
          </span>
          <span>
            Each live job gets a verdict for the trades booked on it &mdash; viable, marginal,
            or stop &mdash; against the limits above, with the reason and its source stated.
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-slate-400">
            &bull;
          </span>
          <span>
            A verdict of <em>viable</em> will require every condition to have been checked
            against real data. Missing data will never read as suitable weather; it reads as
            &ldquo;unknown&rdquo;, which is what this build returns for everything today.
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-slate-400">
            &bull;
          </span>
          <span>
            Observations will be kept as a record of what the weather actually was, separately
            from forecasts, and will not be overwritten.
          </span>
        </li>
      </ul>
      <p className="mt-3 text-xs text-slate-500">
        The provider options, their licences and their costs are documented for the activation
        decision in <code className="text-slate-600">docs/weather/provider-options.md</code>.
        No provider has been chosen and nothing has been signed up for.
      </p>
    </section>
  );
}
