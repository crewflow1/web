/**
 * Health & Safety — RAMS auto-draft template catalogue (DETERMINISTIC, no AI).
 *
 * The Master-Plan "auto-generated RAMS" is, for v1, a curated in-repo library of
 * reusable, standards-based templates keyed by work-type/trade. `generateRamsDraft`
 * (see app/(app)/health-safety/actions.ts) maps a chosen template into a DRAFT
 * risk_assessment + its risk_assessment_hazards, feeding the EXISTING manual /
 * immutable-revision pipeline (draft → human edits → issue). Nothing here ever
 * issues a RAMS: a human still names the assessor, edits, and approves.
 *
 * Why an in-repo catalogue rather than an org-scoped `rams_templates` table for v1:
 *   - The starter library is the SAME standards-based content for every tenant —
 *     the standard hazards for roofing / groundworks / working-at-height don't
 *     vary by org. Per-org customisation (editing the library) is a genuine v2
 *     feature, not a v1 requirement.
 *   - Keeping it in-repo makes it fully deterministic, versioned in git, and
 *     code-reviewable, and adds ZERO schema/migration/RLS surface. The generated
 *     draft flows into risk_assessments, which already carries the full tenant
 *     RLS + immutability + revisioning invariants — so tenant isolation is
 *     inherited from the destination table, not re-implemented here.
 *
 * Every hazard below is authored to satisfy `validateHazard` (lib/health-safety/
 * rams.ts): likelihood/severity in 1–5, residual present as a matched pair, and
 * residual risk never higher than the initial risk (controls reduce risk). The
 * unit test asserts this for the whole catalogue so a bad template can't ship.
 *
 * Ratings use the standard HSE 5×5 convention (likelihood × severity), the same
 * matrix the DB `risk_rating` generated column computes.
 */

/** One assessed hazard carried by a template, with default 5×5 scores + controls. */
export type TemplateHazard = {
  hazard: string;
  whoAtRisk: string;
  /** Initial (uncontrolled) likelihood, 1–5. */
  likelihood: number;
  /** Initial (uncontrolled) severity, 1–5. */
  severity: number;
  controlMeasures: string;
  /** Residual (post-control) likelihood, 1–5. */
  residualLikelihood: number;
  /** Residual (post-control) severity, 1–5. */
  residualSeverity: number;
};

/** A reusable RAMS template keyed by work-type/trade. */
export type RamsTemplate = {
  key: string;
  /** Human label for the picker. */
  label: string;
  /** Short one-line description of what the template covers. */
  summary: string;
  /** Default RAMS header title. */
  title: string;
  /** Default activity/task text. */
  activity: string;
  /** Default required PPE. */
  ppe: string[];
  /** Default safe method of work. */
  methodStatement: string;
  /** The standard hazards for this work-type, in presentation order. */
  hazards: TemplateHazard[];
};

/**
 * The starter catalogue. Ordered as presented in the picker. Keys are stable
 * identifiers (never rename — they are the wire value the generate action reads).
 */
export const RAMS_TEMPLATES: readonly RamsTemplate[] = [
  {
    key: "working-at-height",
    label: "Working at height",
    summary: "Scaffolds, MEWPs, ladders and any work where a fall is foreseeable.",
    title: "Working at height",
    activity:
      "Work carried out at height where a person could fall a distance liable to cause injury — including access, the work itself, and materials handling at height.",
    ppe: ["Hard hat", "Hi-vis vest", "Safety boots", "Gloves", "Fall-arrest harness (where required)"],
    methodStatement:
      "1. Confirm the work-at-height is necessary and cannot be avoided; select collective protection (edge protection / working platform) before personal fall protection.\n" +
      "2. Inspect all access equipment before use; scaffolds to be tagged and handed over by a competent person; MEWPs by trained operators only.\n" +
      "3. Establish an exclusion zone below the work; barrier and signage in place.\n" +
      "4. Carry out the work, keeping three points of contact on ladders and never overreaching.\n" +
      "5. Rescue plan agreed and equipment on site before any harness work begins.\n" +
      "6. Inspect, clear and hand back the area on completion.",
    hazards: [
      {
        hazard: "Fall from height (edge, opening, or platform)",
        whoAtRisk: "Operatives, other trades",
        likelihood: 4,
        severity: 5,
        controlMeasures:
          "Collective edge protection (guardrails, toe-boards) to all open edges and openings; working platforms fully boarded; harness with a suitable anchor where collective protection is not reasonably practicable; competent inspection before use.",
        residualLikelihood: 2,
        residualSeverity: 4,
      },
      {
        hazard: "Falling objects / tools striking persons below",
        whoAtRisk: "Operatives, public, other trades",
        likelihood: 4,
        severity: 4,
        controlMeasures:
          "Toe-boards and brick guards on platforms; tool lanyards; exclusion zone and barriers below; no loose materials stored at edges; debris netting where appropriate.",
        residualLikelihood: 2,
        residualSeverity: 3,
      },
      {
        hazard: "Collapse or failure of access equipment (scaffold / ladder / MEWP)",
        whoAtRisk: "Operatives",
        likelihood: 3,
        severity: 5,
        controlMeasures:
          "Scaffold erected and tagged by a competent (CISRS) scaffolder; pre-use inspection and 7-day inspections recorded; ladders to a suitable angle and secured; MEWPs on firm level ground within SWL and operated by IPAF-trained staff.",
        residualLikelihood: 1,
        residualSeverity: 5,
      },
      {
        hazard: "Adverse weather (high wind / ice) increasing fall risk",
        whoAtRisk: "Operatives",
        likelihood: 3,
        severity: 4,
        controlMeasures:
          "Daily weather check; stop work in high winds (per MEWP/scaffold limits, typically 17–23 mph); no work on icy or slippery platforms until cleared and gritted.",
        residualLikelihood: 2,
        residualSeverity: 3,
      },
    ],
  },
  {
    key: "roofing",
    label: "Roofing & tiling",
    summary: "Pitched and flat roof works — tiling, slating, felting and repairs.",
    title: "Roofing works",
    activity:
      "Roof tiling, slating, felting and associated roof-level works, including access to the roof and loading out of materials.",
    ppe: ["Hard hat", "Hi-vis vest", "Safety boots", "Gloves", "Fall-arrest harness (where required)"],
    methodStatement:
      "1. Erect independent scaffold with a suitable working platform and edge protection to the eaves; provide roof ladders / crawling boards for pitched work.\n" +
      "2. Provide safe access to the roof; no climbing on tiles or fragile surfaces.\n" +
      "3. Load out materials in manageable quantities; use a hoist or telehandler, not manual carrying up ladders.\n" +
      "4. Fit fragile-material covers and edge protection to any rooflights/openings.\n" +
      "5. Carry out the work from the platform / roof ladders, keeping the area tidy.\n" +
      "6. Clear debris to a chute or skip; inspect and hand back on completion.",
    hazards: [
      {
        hazard: "Fall from roof edge or eaves",
        whoAtRisk: "Roofers, labourers",
        likelihood: 4,
        severity: 5,
        controlMeasures:
          "Independent scaffold with double guardrail and toe-board to eaves; roof ladders/crawling boards for access on pitch; harness and running line for short-duration edge work where a platform is impractical.",
        residualLikelihood: 2,
        residualSeverity: 4,
      },
      {
        hazard: "Fall through fragile roof material or rooflight",
        whoAtRisk: "Roofers",
        likelihood: 3,
        severity: 5,
        controlMeasures:
          "Identify fragile surfaces before access; stagings/crawling boards spanning supports; covers or edge protection fitted to all rooflights and openings; never step directly on fragile sheeting.",
        residualLikelihood: 1,
        residualSeverity: 5,
      },
      {
        hazard: "Falling tiles / slates / debris striking persons below",
        whoAtRisk: "Public, operatives below",
        likelihood: 4,
        severity: 4,
        controlMeasures:
          "Debris netting and toe-boards; ground-level exclusion zone with barriers and signage; enclosed rubbish chute; no throwing of materials from the roof.",
        residualLikelihood: 2,
        residualSeverity: 3,
      },
      {
        hazard: "Manual handling of tiles / rolls at height",
        whoAtRisk: "Roofers, labourers",
        likelihood: 4,
        severity: 3,
        controlMeasures:
          "Mechanical hoist/telehandler for loading out; break loads into manageable quantities; team lifts for felt rolls; good handling technique and rotation of tasks.",
        residualLikelihood: 2,
        residualSeverity: 2,
      },
      {
        hazard: "Adverse weather (wind, rain, ice) on the roof",
        whoAtRisk: "Roofers",
        likelihood: 3,
        severity: 4,
        controlMeasures:
          "Daily weather check; stop work in high winds or when surfaces are wet/icy; clear and dry access routes before resuming.",
        residualLikelihood: 2,
        residualSeverity: 3,
      },
    ],
  },
  {
    key: "groundworks",
    label: "Groundworks & excavation",
    summary: "Excavations, trenching, drainage and foundation works.",
    title: "Groundworks and excavation",
    activity:
      "Excavation, trenching, drainage and foundation works, including plant movements and the handling of spoil and materials.",
    ppe: ["Hard hat", "Hi-vis vest", "Safety boots", "Gloves", "Eye protection"],
    methodStatement:
      "1. Obtain and review service drawings; scan with CAT & Genny before breaking ground; hand-dig trial holes to confirm services.\n" +
      "2. Support or batter excavation sides per the temporary works design; do not enter an unsupported excavation over 1.2m.\n" +
      "3. Establish exclusion zones for plant; use a trained banksman for reversing/slewing.\n" +
      "4. Provide safe access (ladder) into and out of the excavation; barrier all open edges.\n" +
      "5. Keep spoil and plant back from the edge; monitor for water ingress and ground movement.\n" +
      "6. Backfill and reinstate; inspect daily and after any event that could affect stability.",
    hazards: [
      {
        hazard: "Collapse of excavation / trench sides",
        whoAtRisk: "Operatives in the excavation",
        likelihood: 3,
        severity: 5,
        controlMeasures:
          "Temporary works design for support (trench boxes/shoring) or battering to a safe angle; no entry to unsupported excavations deeper than 1.2m; daily inspection by a competent person and after rain.",
        residualLikelihood: 1,
        residualSeverity: 5,
      },
      {
        hazard: "Contact with buried services (electric / gas / water)",
        whoAtRisk: "Operatives",
        likelihood: 3,
        severity: 5,
        controlMeasures:
          "Service drawings reviewed; CAT & Genny survey before and during digging; safe-digging practice with hand tools near known services; permit for work near live apparatus.",
        residualLikelihood: 1,
        residualSeverity: 5,
      },
      {
        hazard: "People struck by, or plant overturning near, the excavation",
        whoAtRisk: "Operatives, banksman",
        likelihood: 4,
        severity: 5,
        controlMeasures:
          "Segregate pedestrians from plant; trained banksman with agreed signals; stop-blocks and edge distance for plant; exclusion zone around slewing radius; reversing aids fitted.",
        residualLikelihood: 2,
        residualSeverity: 4,
      },
      {
        hazard: "Water ingress / person or plant falling into open excavation",
        whoAtRisk: "Operatives, public",
        likelihood: 3,
        severity: 4,
        controlMeasures:
          "Edge barriers to all open excavations; covers or fencing out of hours; pumping and monitoring of water ingress; safe laddered access.",
        residualLikelihood: 2,
        residualSeverity: 3,
      },
    ],
  },
  {
    key: "electrical",
    label: "Electrical installation",
    summary: "First/second-fix wiring, testing and work on or near electrical systems.",
    title: "Electrical installation works",
    activity:
      "Electrical installation, containment, wiring, termination and testing, including work on or near existing electrical systems.",
    ppe: ["Safety boots", "Hi-vis vest", "Insulated gloves (for live-risk tasks)", "Eye protection"],
    methodStatement:
      "1. Establish the scope; identify existing circuits and isolate as the default — work dead wherever reasonably practicable.\n" +
      "2. Safe isolation procedure: isolate, lock off, prove dead with a proving unit and approved voltage indicator, then post caution notices.\n" +
      "3. Install containment and cabling; maintain safe access (see working-at-height where applicable).\n" +
      "4. Terminate and test to BS 7671; only competent (qualified) persons carry out testing.\n" +
      "5. Energise under control; verify and certify; remove locks and notices.\n" +
      "6. Housekeeping and hand-back with certification.",
    hazards: [
      {
        hazard: "Electric shock / electrocution from live conductors",
        whoAtRisk: "Electricians, other trades",
        likelihood: 3,
        severity: 5,
        controlMeasures:
          "Work dead by default; safe isolation with lock-off and prove-dead using a proving unit and approved voltage indicator; only competent persons work on electrical systems; RCD protection on temporary supplies.",
        residualLikelihood: 1,
        residualSeverity: 5,
      },
      {
        hazard: "Arc flash / burns during switching or fault",
        whoAtRisk: "Electricians",
        likelihood: 2,
        severity: 5,
        controlMeasures:
          "De-energise before work; where live working is unavoidable and justified, use a documented live-working permit, insulated tools/PPE and a competent second person; stand to the side when switching.",
        residualLikelihood: 1,
        residualSeverity: 4,
      },
      {
        hazard: "Fire / ignition from faulty temporary supplies or hot work",
        whoAtRisk: "All site personnel",
        likelihood: 2,
        severity: 4,
        controlMeasures:
          "Inspected and tested temporary supplies (110V where practicable); no overloading; extinguishers available; hot-work permit where soldering/heat is used.",
        residualLikelihood: 1,
        residualSeverity: 3,
      },
      {
        hazard: "Contact with concealed cables when drilling / cutting",
        whoAtRisk: "Electricians, other trades",
        likelihood: 3,
        severity: 4,
        controlMeasures:
          "Cable/voltage detector before drilling or chasing; know the safe zones for concealed cables; isolate suspect circuits before penetration work.",
        residualLikelihood: 1,
        residualSeverity: 4,
      },
    ],
  },
  {
    key: "demolition-strip-out",
    label: "Demolition & soft strip",
    summary: "Soft strip and non-structural demolition of internal fabric and fittings.",
    title: "Demolition and soft strip-out",
    activity:
      "Non-structural soft strip and demolition of internal fittings, partitions and fabric, including removal and segregation of waste.",
    ppe: ["Hard hat", "Hi-vis vest", "Safety boots", "Gloves", "Eye protection", "Dust mask (FFP3 where required)"],
    methodStatement:
      "1. Confirm structure is de-serviced (electric/gas/water isolated) and a refurbishment/demolition asbestos survey (R&D) has been reviewed.\n" +
      "2. Establish the sequence — top-down, non-structural only; no removal of load-bearing elements without a temporary works design.\n" +
      "3. Set up dust suppression and waste routes (chutes/skips); segregate waste streams.\n" +
      "4. Strip out fittings and partitions in the planned sequence, checking for hidden services.\n" +
      "5. Stop immediately and reassess if suspected asbestos-containing materials are found.\n" +
      "6. Clear, clean and hand back the area.",
    hazards: [
      {
        hazard: "Exposure to asbestos-containing materials (ACMs)",
        whoAtRisk: "Operatives, occupants",
        likelihood: 3,
        severity: 5,
        controlMeasures:
          "Refurbishment & Demolition asbestos survey reviewed before work; presume-ACM and stop if unidentified suspect material is found; licensed contractor for licensed ACMs; no disturbance of known ACMs by this task.",
        residualLikelihood: 1,
        residualSeverity: 5,
      },
      {
        hazard: "Uncontrolled collapse of structure / falling debris",
        whoAtRisk: "Operatives",
        likelihood: 3,
        severity: 5,
        controlMeasures:
          "Non-structural elements only; planned top-down sequence; temporary works design for any propping; exclusion zones below; no undermining of remaining structure.",
        residualLikelihood: 1,
        residualSeverity: 5,
      },
      {
        hazard: "Harmful dust and poor air quality",
        whoAtRisk: "Operatives, adjacent trades",
        likelihood: 4,
        severity: 3,
        controlMeasures:
          "Dust suppression (water damping) and on-tool extraction; FFP3 RPE (face-fit tested); local screening; task rotation and welfare breaks.",
        residualLikelihood: 2,
        residualSeverity: 2,
      },
      {
        hazard: "Contact with residual live services",
        whoAtRisk: "Operatives",
        likelihood: 3,
        severity: 5,
        controlMeasures:
          "Confirm all services isolated and proven dead before strip-out; cable/voltage detection before cutting; permit for any work near retained live services.",
        residualLikelihood: 1,
        residualSeverity: 5,
      },
    ],
  },
  {
    key: "manual-handling",
    label: "Manual handling",
    summary: "Lifting, carrying and moving of loads by hand across general site work.",
    title: "Manual handling operations",
    activity:
      "Manual lifting, carrying, pushing, pulling and moving of loads by hand during general site activities.",
    ppe: ["Safety boots", "Hi-vis vest", "Gloves"],
    methodStatement:
      "1. Avoid the manual handling where reasonably practicable — use mechanical aids (trolley, pallet truck, telehandler) or deliver to point of use.\n" +
      "2. Assess each significant lift (task, individual, load, environment — TILE).\n" +
      "3. Break loads down into manageable weights; use team lifts for awkward/heavy items with a nominated lead.\n" +
      "4. Keep routes clear, level and well lit; plan the lift and destination before starting.\n" +
      "5. Use good technique — stable base, bend the knees, keep the load close, no twisting.\n" +
      "6. Rotate tasks and take breaks on repetitive handling.",
    hazards: [
      {
        hazard: "Musculoskeletal injury from lifting / carrying heavy loads",
        whoAtRisk: "Operatives",
        likelihood: 4,
        severity: 3,
        controlMeasures:
          "Mechanical aids used in preference to manual lifting; TILE assessment of significant lifts; loads broken down to manageable weights; trained handling technique; team lifts for heavy/awkward items.",
        residualLikelihood: 2,
        residualSeverity: 2,
      },
      {
        hazard: "Slips, trips and falls while carrying loads",
        whoAtRisk: "Operatives",
        likelihood: 4,
        severity: 3,
        controlMeasures:
          "Access routes kept clear, level and well lit; loads sized so the route is visible; spillages cleared immediately; suitable footwear.",
        residualLikelihood: 2,
        residualSeverity: 2,
      },
      {
        hazard: "Crush / impact injuries to hands and feet from dropped loads",
        whoAtRisk: "Operatives",
        likelihood: 3,
        severity: 3,
        controlMeasures:
          "Gloves and safety boots (toe protection); secure grip and stable stacking; keep fingers clear of pinch points; nominated lead directs team lifts.",
        residualLikelihood: 1,
        residualSeverity: 3,
      },
    ],
  },
] as const;

/** Fast lookup by key. */
const TEMPLATE_BY_KEY: ReadonlyMap<string, RamsTemplate> = new Map(
  RAMS_TEMPLATES.map((t) => [t.key, t]),
);

/** True if `key` names a template in the catalogue. */
export function isRamsTemplateKey(key: string): boolean {
  return TEMPLATE_BY_KEY.has(key);
}

/** The template for `key`, or null if unknown. */
export function getRamsTemplate(key: string): RamsTemplate | null {
  return TEMPLATE_BY_KEY.get(key) ?? null;
}

/** Lightweight picker options (no hazard payload) for the UI. */
export function ramsTemplateOptions(): Array<{ key: string; label: string; summary: string }> {
  return RAMS_TEMPLATES.map((t) => ({ key: t.key, label: t.label, summary: t.summary }));
}

/** The draft header a template produces (feeds a `risk_assessments` insert). */
export type GeneratedRamsHeader = {
  title: string;
  activity: string;
  ppe: string[];
  methodStatement: string;
};

/** A generated hazard row (feeds a `risk_assessment_hazards` insert). */
export type GeneratedRamsHazard = {
  hazard: string;
  whoAtRisk: string;
  likelihood: number;
  severity: number;
  controlMeasures: string;
  residualLikelihood: number;
  residualSeverity: number;
  sortOrder: number;
};

/** The full deterministic draft a template maps to. */
export type GeneratedRamsDraft = {
  templateKey: string;
  header: GeneratedRamsHeader;
  hazards: GeneratedRamsHazard[];
};

/**
 * Deterministically map a template key to a DRAFT RAMS payload.
 *
 * Pure and total: given the same key it always returns the same draft, with no
 * DB, clock or randomness. Returns null for an unknown key (the caller fails
 * closed). The caller is responsible for stamping org_id / created_by / job_id
 * and for the DB write — this function only shapes the deterministic content.
 * Deliberately does NOT set an assessor or issue anything: a human still owns
 * assessment ownership and approval.
 */
export function buildRamsDraftFromTemplate(templateKey: string): GeneratedRamsDraft | null {
  const template = getRamsTemplate(templateKey);
  if (!template) return null;
  return {
    templateKey: template.key,
    header: {
      title: template.title,
      activity: template.activity,
      ppe: [...template.ppe],
      methodStatement: template.methodStatement,
    },
    hazards: template.hazards.map((h, index) => ({
      hazard: h.hazard,
      whoAtRisk: h.whoAtRisk,
      likelihood: h.likelihood,
      severity: h.severity,
      controlMeasures: h.controlMeasures,
      residualLikelihood: h.residualLikelihood,
      residualSeverity: h.residualSeverity,
      sortOrder: index,
    })),
  };
}
