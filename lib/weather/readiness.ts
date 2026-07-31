/**
 * Weather intelligence — activation readiness.
 *
 * A direct descendant of lib/comms/readiness.ts (the #433 false-green fix),
 * lib/ai/governor/readiness.ts and lib/ai/quote-writer-readiness.ts, and it
 * exists for the same reason all three do: a single `enabled` boolean derived
 * from configuration is a LIE whenever the runtime cannot actually perform the
 * capability, and a green light over a dead path is worse than no light because
 * it suppresses the alarm that would have caught the misconfiguration.
 *
 * The specific failure this prevents: somebody sets `MET_OFFICE_API_KEY` on a
 * deploy, a naive `isWeatherConfigured()` answers "yes", the job screen starts
 * rendering a weather panel — and the panel is empty, because this build
 * contains NO PROVIDER ADAPTER at all. An operator concludes the product is
 * broken. Worse, a site manager could conclude the absence of a warning means
 * there is nothing to warn about.
 *
 * So readiness decomposes into things that are independently, verifiably true:
 *
 *   decisionLayerImplemented — the thresholds and the decision layer EXIST in
 *                              this build.            (build-time fact — TRUE)
 *   providerImplemented      — an adapter that can talk to a vendor exists.
 *                                                     (build-time fact — FALSE)
 *   districtResolutionAvailable — we can turn a postcode district into the
 *                              coordinate every vendor's API requires.
 *                                                     (build-time fact — FALSE)
 *   selectionUsable          — WEATHER_PROVIDER names a provider we could build.
 *                                                              (configuration)
 *   credentialsPresent       — the named vendor's secret is set. (configuration)
 *   available                — all of the above. FALSE today.
 *
 * THE LOAD-BEARING RULE, inherited verbatim:
 * **`available` can NEVER be true without `providerImplemented`.** No
 * environment variable can manufacture a capability this build does not have.
 *
 * AND A SECOND ONE THAT IS SPECIFIC TO THIS FEATURE:
 * **`available` can never be true without `districtResolutionAvailable`.**
 * Every realistic UK vendor is queried by latitude and longitude. This schema
 * holds no coordinates and this build has no geocoder, so even a fully paid-up
 * API key leaves the feature unable to ask a question. Splitting this out is the
 * point of the file — it is the activation blocker most likely to be missed,
 * because it is not a secret and not a subscription, it is a dataset.
 *
 * Reads `process.env` DIRECTLY (not the validated `env` object), imports no
 * vendor SDK and no `server-only`, so it is edge-safe, dependency-free, and CAN
 * NEVER THROW — a readiness probe must always answer.
 */

// ---------------------------------------------------------------------------
// Build-time capability registry.
// ---------------------------------------------------------------------------

/**
 * The vendors this build knows the NAME of. Knowing a name is not the same as
 * being able to call one — see PROVIDER_IMPLEMENTED.
 */
export const KNOWN_WEATHER_PROVIDERS = ["metoffice", "open-meteo"] as const;
export type KnownWeatherProvider = (typeof KNOWN_WEATHER_PROVIDERS)[number];

/**
 * Does a REAL provider adapter exist in this build?
 *
 * A BUILD-TIME fact, not configuration — it answers "is there code that can put
 * a request on the wire", which no env var can change. A hand-maintained mirror
 * of the factory arms in ./index, in exactly the spirit of `SENDER_IMPLEMENTED`
 * in lib/comms/readiness.ts.
 *
 * EVERY ENTRY IS FALSE, and that is the whole point of this wave: the shape is
 * built, the provider is unbound, and the decision to bind one is a commercial
 * decision about licence and cost that belongs to a human. The security suite
 * pins these to false, so activating a provider is a VISIBLE diff that trips a
 * test — never a quiet configuration change.
 */
const PROVIDER_IMPLEMENTED: Readonly<Record<KnownWeatherProvider, boolean>> = {
  metoffice: false,
  "open-meteo": false,
};

/**
 * Vendor → the environment variable that would hold its credential.
 *
 * Declaring the NAME is not introducing a secret: it is what lets this module
 * tell an operator precisely what is missing instead of "not configured".
 * Nothing in this build READS these for any purpose other than reporting, and
 * nothing could use one if it were set, because no adapter exists.
 *
 * `open-meteo` maps to a key even though its open-access tier needs none: that
 * tier is licensed for NON-COMMERCIAL use only, and CrewFlow is a commercial
 * product. The commercial tier issues a key. Treating the free tier as usable
 * here would encode a licence breach as a default.
 */
const VENDOR_CREDENTIAL: Readonly<Record<KnownWeatherProvider, string>> = {
  metoffice: "MET_OFFICE_API_KEY",
  "open-meteo": "OPEN_METEO_API_KEY",
};

/** Every weather credential this build knows about, present or not. */
export const KNOWN_WEATHER_CREDENTIALS: ReadonlyArray<string> = Object.values(VENDOR_CREDENTIAL);

/**
 * BUILD-TIME FACT: does this build contain the decision layer?
 *
 * TRUE from the moment this wave lands, because the thresholds, the reduction
 * and the verdict logic genuinely are built and tested. What is missing is the
 * data to feed them. Conflating "built" with "bound" is the mistake this whole
 * file exists to avoid — and splitting them is what lets the dark UI say the
 * true and useful thing ("built, waiting on a decision") rather than the
 * unhelpfully vague "not configured".
 */
const DECISION_LAYER_IMPLEMENTED = true;

/**
 * BUILD-TIME FACT: can this build turn a postcode district into the coordinate
 * a vendor API needs?
 *
 * FALSE. There is no latitude/longitude column anywhere in the schema, no
 * PostGIS, and no geocoder. Closing this needs a district→centroid dataset —
 * OS Code-Point Open or the ONS Postcode Directory, both Open Government
 * Licence and free, both requiring an attribution line. That is a data-ingest
 * task, not a credential, which is exactly why it gets its own field: it would
 * otherwise hide behind a green "key is set" and surprise whoever flips the
 * switch.
 */
const DISTRICT_RESOLUTION_AVAILABLE = false;

const present = (v: string | undefined | null): boolean =>
  typeof v === "string" && v.trim().length > 0;

/** Values of `WEATHER_PROVIDER` that mean "deliberately off". */
const OFF_SELECTIONS = ["", "none", "off", "disabled"] as const;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type WeatherReadiness = {
  /**
   * THE honest headline: can this runtime obtain weather for a site right now?
   * `false` today, and never true without an adapter AND district resolution.
   */
  available: boolean;
  /** The thresholds and decision layer exist in this build. TRUE. */
  decisionLayerImplemented: boolean;
  /** A provider adapter exists in this build for the selected vendor. FALSE. */
  providerImplemented: boolean;
  /** A district can be turned into a coordinate. FALSE. */
  districtResolutionAvailable: boolean;
  /** `WEATHER_PROVIDER` names a vendor this build knows (unset ⇒ nothing selected). */
  selectionUsable: boolean;
  /** The raw selection, normalised. null when unset or deliberately off. */
  selection: string | null;
  /** The selected vendor's credential is set. Meaningless while no adapter exists. */
  credentialsPresent: boolean;
  /** The vendor that would be used, or null when the seam resolves to null. */
  provider: string | null;
  /**
   * `getWeatherProvider()` would hand back a provider — i.e. adapter exists AND
   * selection usable AND credential present. FALSE.
   */
  providerResolvable: boolean;
  /** EVERYTHING standing between this runtime and `available`. Empty ⇒ available. */
  blockers: string[];
  /** Weather credentials present in this environment, by variable name. */
  credentialsFound: ReadonlyArray<string>;
  /**
   * A vendor credential is set while NO adapter exists — the drift case, and the
   * one honest warning this module owes an operator.
   *
   * It is reported rather than "fixed", because the fix is a decision: either
   * finish the adapter (activate properly) or remove the credential. A key
   * sitting in an environment that nothing reads is a standing invitation for
   * some future call site to read it directly and bypass this seam entirely —
   * which is precisely the `ungovernedCredentialRisk` the AI governor reports.
   */
  strandedCredentialRisk: boolean;
};

/**
 * Compose weather readiness.
 *
 * The build-time facts are INJECTABLE so a test can prove the invariants
 * DIRECTLY — hand it a satisfied credential, a usable selection AND a missing
 * adapter, and `available` must still be false — rather than inferring them from
 * whatever happens to be dark today. Production always takes the real reading.
 */
export function getWeatherReadiness(
  overrides: {
    providerImplemented?: boolean;
    decisionLayerImplemented?: boolean;
    districtResolutionAvailable?: boolean;
    /** Override the credential lookup. Testing only. */
    credentialPresent?: boolean;
  } = {},
): WeatherReadiness {
  const rawSelection = (process.env.WEATHER_PROVIDER ?? "").trim().toLowerCase();
  const deliberatelyOff = (OFF_SELECTIONS as readonly string[]).includes(rawSelection);
  const selection = rawSelection.length === 0 || deliberatelyOff ? null : rawSelection;

  const selectionUsable =
    selection !== null &&
    (KNOWN_WEATHER_PROVIDERS as readonly string[]).includes(selection);

  const vendor = selectionUsable ? (selection as KnownWeatherProvider) : null;

  const providerImplemented =
    overrides.providerImplemented ?? (vendor !== null ? PROVIDER_IMPLEMENTED[vendor] : false);

  const decisionLayerImplemented =
    overrides.decisionLayerImplemented ?? DECISION_LAYER_IMPLEMENTED;

  const districtResolutionAvailable =
    overrides.districtResolutionAvailable ?? DISTRICT_RESOLUTION_AVAILABLE;

  const envVar = vendor !== null ? VENDOR_CREDENTIAL[vendor] : undefined;
  const credentialsPresent =
    overrides.credentialPresent ??
    (envVar !== undefined && present(process.env[envVar]));

  // Mirrors `getWeatherProvider() !== null` in ./index.
  const providerResolvable = providerImplemented && selectionUsable && credentialsPresent;

  // THE INVARIANTS. Both build-time clauses are ones no environment can satisfy.
  const available = decisionLayerImplemented && providerResolvable && districtResolutionAvailable;

  const blockers: string[] = [];
  if (!decisionLayerImplemented) {
    blockers.push("the weather decision layer is not present in this build");
  }
  if (selection === null) {
    blockers.push(
      `WEATHER_PROVIDER must name a provider (${KNOWN_WEATHER_PROVIDERS.join(" | ")})`,
    );
  } else if (!selectionUsable) {
    blockers.push(
      `WEATHER_PROVIDER="${selection}" is not a provider this build knows ` +
        `(${KNOWN_WEATHER_PROVIDERS.join(" | ")})`,
    );
  } else {
    // A KNOWN vendor is selected, so report EVERY outstanding item for it rather
    // than short-circuiting on the first. This is a deliberate departure from the
    // governor's else-if chain, where a credential is genuinely meaningless until
    // a tier is bound. Here it is not: whoever plans this activation needs to know
    // they must obtain a subscription key AND that an adapter has to be written,
    // because those are two different people's work on two different timescales.
    // A checklist that revealed the second item only after the first was done
    // would turn one planning conversation into two.
    if (!providerImplemented) {
      blockers.push(`no '${selection}' provider adapter exists in this build`);
    }
    if (!credentialsPresent && envVar !== undefined) {
      blockers.push(envVar);
    }
  }
  if (!districtResolutionAvailable) {
    blockers.push(
      "no postcode-district → coordinate source in this build (OS Code-Point Open " +
        "or the ONS Postcode Directory would close this; both are Open Government " +
        "Licence and free, and both require an attribution line)",
    );
  }

  const credentialsFound = KNOWN_WEATHER_CREDENTIALS.filter((v) => present(process.env[v]));
  const anyAdapterImplemented = Object.values(PROVIDER_IMPLEMENTED).some(Boolean);

  return {
    available,
    decisionLayerImplemented,
    providerImplemented,
    districtResolutionAvailable,
    selectionUsable,
    selection,
    credentialsPresent,
    provider: providerResolvable ? selection : null,
    providerResolvable,
    blockers,
    credentialsFound,
    strandedCredentialRisk: credentialsFound.length > 0 && !anyAdapterImplemented,
  };
}

/**
 * Cheap predicate for the hot path. Every caller that would otherwise touch a
 * provider gates on this FIRST and, when false, returns its "not configured"
 * shape without a single database read and without constructing a client —
 * which is why this feature costs nothing that a user or a bill can observe.
 */
export function isWeatherAvailable(): boolean {
  return getWeatherReadiness().available;
}

/**
 * The one sentence a dark surface shows an operator.
 *
 * Written here rather than in the component, so the honest wording lives beside
 * the logic that decides it and a test can assert that the dark state never
 * claims to be anything else. Note what it does NOT say: it never implies the
 * weather is fine, because "no warning" and "no data" must not look alike.
 */
export function weatherStatusLine(readiness: WeatherReadiness): string {
  if (readiness.available) {
    return "Weather intelligence is active.";
  }
  if (readiness.decisionLayerImplemented && !readiness.providerImplemented) {
    return (
      "Weather intelligence: not configured. The work thresholds are built and " +
      "tested, but no weather provider is connected, so CrewFlow has no weather " +
      "data and is not checking anything. Nothing here should be read as " +
      "conditions being suitable."
    );
  }
  return "Weather intelligence: not configured.";
}
