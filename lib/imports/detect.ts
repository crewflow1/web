/**
 * Migration OS — entity-type + column detection.
 *
 * Pure, heuristic detection that runs without an LLM dependency. We
 * inspect header names per sheet, score each candidate entity type, pick
 * the winner above a threshold, then canonicalise each row into a
 * `mapped` shape that matches the destination table.
 *
 * Why heuristic-first: deterministic + testable + works offline.
 * Anthropic SDK can layer on top later for fuzzy / multilingual headers
 * without changing this contract.
 *
 * Confidence scoring philosophy:
 *   - Header match scores per-column (0-100), then a row's confidence is
 *     the % of expected columns we found.
 *   - Values that fail a basic type sanity-check knock the row's
 *     confidence down (e.g. a VAT column that's mostly null).
 */

import { matchColumns } from "./header-match";
import type { Cell, ParsedSheet } from "./parsers";
import { parseVatRate } from "./vat";

export type EntityType =
  | "customer"
  | "invoice"
  | "lead"
  | "staff"
  | "cost"
  | "supplier"
  | "job"
  | "quote"
  | "payment";

export type ColumnMap = {
  // The canonical target field → source-header it came from.
  [canonicalField: string]: string;
};

export type DetectedSheet = {
  sheet: ParsedSheet;
  entity_type: EntityType | "unknown";
  confidence: number; // 0 to 100
  column_map: ColumnMap;
  field_confidence: Record<string, number>; // per-field signal score
  // Set when the detector picked an entity but isn't confident enough to let
  // it import unattended (e.g. a soft-only staff vs customer tie). The parse
  // pipeline forces these rows into `needs_review` regardless of confidence.
  review_required?: boolean;
};

export type MappedRow = {
  entity_type: EntityType;
  confidence: number;
  mapped: Record<string, unknown>;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Aliases — every canonical field has a list of header substrings we'll
// recognise. Order matters: the first match wins, so put the most-specific
// alias first ("customer name" before "name").
// ---------------------------------------------------------------------------

const CUSTOMER_FIELDS: Record<string, string[]> = {
  name: ["customer name", "client name", "company name", "full name", "name"],
  email: ["customer email", "client email", "email address", "e-mail", "email"],
  phone: ["mobile", "cell", "phone number", "telephone", "tel", "phone"],
  address_line1: ["address line 1", "address1", "street", "address"],
  city: ["town", "city"],
  postcode: ["post code", "postal code", "zip", "postcode"],
  notes: ["notes", "note", "comments", "comment"],
};

const INVOICE_FIELDS: Record<string, string[]> = {
  number: ["invoice number", "invoice no", "invoice #", "inv no", "inv #", "number"],
  customer_name: ["customer name", "client name", "bill to", "customer", "client"],
  amount: ["net", "subtotal", "amount excl vat", "amount net", "amount"],
  vat_total: ["vat amount", "vat total", "tax amount", "tax", "vat"],
  // "total due" / "amount due" / "balance due" are listed explicitly so the
  // gross figure is claimed EXACTLY, in the first pass, before `due_date` (or
  // anything else) can look at the column. The header matcher's class rules
  // already refuse `Total Due` as a date; naming it here means the money column
  // is also matched with full confidence rather than as a loose fallback.
  total: [
    "total",
    "amount inc vat",
    "gross",
    "grand total",
    "total due",
    "amount due",
    "balance due",
  ],
  due_date: ["due date", "due", "payment due"],
  // A bare "Paid" column is deliberately NOT a `paid_at` alias. Now that one
  // column can only belong to one field, the two have to be told apart, and a
  // spreadsheet column headed just "Paid" is overwhelmingly a yes/no flag — a
  // date column says "Paid Date" or "Date Paid". Leaving "paid" here made
  // `paid_at` claim the flag (warning "bad date in paid_at: yes") and cost the
  // invoice its status.
  paid_at: ["paid date", "paid at", "date paid"],
  status: ["status", "paid?", "paid", "payment status"],
  created_at: ["invoice date", "date", "created"],
};

const LEAD_FIELDS: Record<string, string[]> = {
  name: ["lead name", "name", "contact name"],
  email: ["email", "e-mail"],
  phone: ["phone", "mobile", "tel"],
  source: ["source", "channel", "lead source"],
  service: ["service", "trade", "work type", "category"],
  urgency: ["urgency", "priority"],
  postcode: ["postcode", "post code", "zip"],
  estimated_value: ["estimated value", "value", "quote value", "potential value"],
  notes: ["notes", "comments"],
};

const STAFF_FIELDS: Record<string, string[]> = {
  full_name: ["full name", "name"],
  email: ["email", "e-mail"],
  phone: ["mobile", "phone", "tel"],
  hourly_pay: ["hourly rate", "hourly pay", "rate", "wage", "pay"],
  employment_type: ["employment type", "employment", "contract type"],
  start_date: ["start date", "started", "hire date"],
  // NI numbers are deliberately NOT auto-imported — they live in the
  // admin-gated staff_secrets table and must be entered explicitly by
  // an org admin to avoid leaking sensitive data through a malformed CSV.
};

const COST_FIELDS: Record<string, string[]> = {
  amount: ["amount excl vat", "amount net", "net", "amount", "value"],
  // A stated rate and a VAT amount are both recognised, and the rate wins on
  // commit: `finances.vat_rate` is the writable input (`vat_total` is a stored
  // generated column), so a rate the file already states needs no arithmetic.
  // Declared before `vat_total` so a "VAT Rate" column is claimed as a rate
  // before the amount field can look at it — though the header matcher's class
  // rules refuse it as money regardless. A bare "VAT" header still reads as the
  // amount, which is the spreadsheet convention.
  vat_rate: ["vat rate", "vat %", "vat percent", "vat percentage", "tax rate", "tax %"],
  vat_total: ["vat amount", "vat total", "vat", "tax"],
  category: ["category", "type", "expense type"],
  notes: ["description", "notes", "note", "memo", "details"],
  created_at: ["date", "expense date", "created"],
};

const SUPPLIER_FIELDS: Record<string, string[]> = {
  name: ["supplier name", "vendor name", "supplier", "vendor", "name"],
  email: ["email", "e-mail"],
  phone: ["phone", "tel"],
  notes: ["notes", "comments", "account"],
};

// ------------------------------------------------------------------
// CEO Migration OS expansion (PR 2): jobs, quotes, payments.
//
// These extend the existing customer/invoice/lead/staff/cost catalog.
// The destination tables (`jobs`, `quotes`, `invoice_payments`) all
// require a parent record (customer / customer / invoice respectively).
// insertOne() resolves those parents by name/number within the org;
// rows that can't resolve are marked `skipped` with an error_message
// — they DO NOT throw, matching the directive's "AI flags issues but
// does not stop migration" rule.
// ------------------------------------------------------------------

const JOB_FIELDS: Record<string, string[]> = {
  customer_name: ["customer name", "client name", "customer", "client", "for"],
  title: ["job title", "title", "job", "scope", "work"],
  status: ["job status", "status", "stage"],
  scheduled_date: ["scheduled", "scheduled date", "date", "start date", "when"],
  address: ["address", "address line 1", "address1", "street", "site"],
  value: ["job value", "value", "amount", "price"],
  notes: ["notes", "description", "details", "comments"],
  assigned_email: [
    "assigned to",
    "assigned",
    "engineer",
    "tech",
    "assigned email",
  ],
};

const QUOTE_FIELDS: Record<string, string[]> = {
  number: ["quote number", "quote no", "quote #", "quote ref", "ref", "number"],
  customer_name: ["customer name", "client name", "customer", "client"],
  total: ["total", "amount inc vat", "grand total", "amount"],
  status: ["status", "quote status"],
  valid_until: ["valid until", "expires", "expiry", "expires on", "expiry date"],
  notes: ["notes", "comments"],
};

const PAYMENT_FIELDS: Record<string, string[]> = {
  // Required pair: which invoice + how much.
  invoice_number: [
    "invoice number",
    "invoice no",
    "invoice #",
    "inv no",
    "inv #",
    "invoice ref",
  ],
  amount: ["amount", "paid", "payment", "value", "total"],
  paid_at: ["paid date", "paid at", "date paid", "payment date", "date"],
  payment_method: ["payment method", "method", "type", "via"],
  reference: ["reference", "ref", "transaction ref", "bank ref"],
  notes: ["notes", "comments"],
};

const ENTITY_FIELDS: Record<EntityType, Record<string, string[]>> = {
  customer: CUSTOMER_FIELDS,
  invoice: INVOICE_FIELDS,
  lead: LEAD_FIELDS,
  staff: STAFF_FIELDS,
  cost: COST_FIELDS,
  supplier: SUPPLIER_FIELDS,
  job: JOB_FIELDS,
  quote: QUOTE_FIELDS,
  payment: PAYMENT_FIELDS,
};

const REQUIRED_FIELDS: Record<EntityType, string[]> = {
  customer: ["name"], // need at least a name
  invoice: ["number", "total"],
  lead: ["name"],
  staff: ["full_name"],
  cost: ["amount"],
  supplier: ["name"],
  // Jobs absolutely need a customer to be linkable — the schema's
  // customer_id is nullable but a job without a customer is useless
  // operationally.
  job: ["customer_name"],
  // Quote needs both an identifier and a customer to resolve.
  quote: ["number", "customer_name"],
  // Payment needs an invoice reference + an amount; date is forced
  // to today on commit if missing.
  payment: ["invoice_number", "amount"],
};

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/**
 * Map a sheet's headers onto this entity's canonical fields.
 *
 * The matching itself lives in lib/imports/header-match.ts — see that module
 * for why it is whole-token, class-aware and globally deduplicated rather than
 * the per-field "first header containing this alias" it replaced (which read
 * `VAT Reg No` as a VAT amount, `Total Due` as a due date, and `Subtotal` as
 * the invoice total).
 */
function mapColumns(
  headers: string[],
  fields: Record<string, string[]>,
): { map: ColumnMap; perField: Record<string, number>; idxMap: Record<string, number> } {
  return matchColumns(headers, fields);
}

// ---------------------------------------------------------------------------
// Entity-type detection per sheet
// ---------------------------------------------------------------------------

// Staff vs customer is the most dangerous confusion in the detector: a staff
// roster and a customer list share the exact same name/email/phone columns, so
// without a discriminator a plain contact sheet scores HIGHER as staff (fewer
// catalog fields ⇒ a higher per-field average) and gets silently filed as
// staff — wrong, and it even surfaces a "send staff invite" CTA for customers.
//
// So staff is only ever a candidate when a staff-specific signal is present:
//   STRONG — unambiguously payroll/HR data; if one of these is present the
//            staff classification is trusted outright.
//   SOFT   — words that also appear on customer-ish data (a "role" or "job
//            title" column can live on a CRM export). A staff win driven only
//            by a soft signal is treated as ambiguous: we lean to the customer
//            interpretation and force the sheet into manual review.
const STAFF_SIGNAL_STRONG = [
  "hourly rate",
  "wage",
  "employment type",
  "start date",
  "hire date",
  "payroll number",
];
const STAFF_SIGNAL_SOFT = ["role", "position", "job title"];

export function detectEntityType(sheet: ParsedSheet): DetectedSheet {
  // Discriminator keywords — entities that could otherwise be confused
  // with a sibling (supplier vs customer, job vs customer, quote vs
  // invoice, payment vs invoice, staff vs customer) require an explicit
  // signal in at least one header.
  const lowered = sheet.header.map((h) => h.toLowerCase());
  const supplierSignal = lowered.some(
    (h) => h.includes("supplier") || h.includes("vendor"),
  );
  // Jobs need either an explicit job-shape word OR a scheduled date —
  // those are absent from customer sheets.
  const jobSignal = lowered.some(
    (h) =>
      h.includes("job") ||
      h.includes("scheduled") ||
      h.includes("assigned") ||
      h.includes("engineer"),
  );
  // Quotes specifically reference "quote" — invoices say "invoice".
  const quoteSignal = lowered.some(
    (h) => h.includes("quote") || h.includes("valid until") || h.includes("expir"),
  );
  // Payments either say "payment" / "paid" or are explicitly paired
  // with an invoice number column.
  const paymentSignal = lowered.some(
    (h) =>
      h.includes("payment") ||
      h.includes("paid") ||
      (h.includes("method") && lowered.some((x) => x.includes("invoice"))),
  );
  // Staff signals (see the STAFF_SIGNAL_* note above).
  const hasStrongStaffSignal = lowered.some((h) =>
    STAFF_SIGNAL_STRONG.some((a) => h.includes(a)),
  );
  const hasSoftStaffSignal = lowered.some((h) =>
    STAFF_SIGNAL_SOFT.some((a) => h.includes(a)),
  );
  const staffSignal = hasStrongStaffSignal || hasSoftStaffSignal;

  type Candidate = {
    entity: EntityType;
    score: number;
    column_map: ColumnMap;
    field_confidence: Record<string, number>;
  };
  const candidates: Candidate[] = [];
  for (const entity of Object.keys(ENTITY_FIELDS) as EntityType[]) {
    if (entity === "supplier" && !supplierSignal) continue;
    if (entity === "job" && !jobSignal) continue;
    if (entity === "quote" && !quoteSignal) continue;
    if (entity === "payment" && !paymentSignal) continue;
    if (entity === "staff" && !staffSignal) continue;
    const fields = ENTITY_FIELDS[entity];
    const { map, perField } = mapColumns(sheet.header, fields);
    const required = REQUIRED_FIELDS[entity];
    const requiredHits = required.filter((f) => perField[f]! > 0).length;
    if (requiredHits < required.length) continue;
    // Confidence = average of per-field scores, weighted slightly toward
    // required fields being exact.
    const allFields = Object.keys(fields);
    const totalScore = allFields.reduce((s, f) => s + (perField[f] ?? 0), 0);
    const avg = totalScore / allFields.length;
    const requiredAvg =
      required.reduce((s, f) => s + (perField[f] ?? 0), 0) / required.length;
    const score = Math.min(100, Math.round(avg * 0.6 + requiredAvg * 0.4));
    candidates.push({ entity, score, column_map: map, field_confidence: perField });
  }

  if (candidates.length === 0) {
    return {
      sheet,
      entity_type: "unknown",
      confidence: 0,
      column_map: {},
      field_confidence: {},
    };
  }

  // Highest score wins. Array.prototype.sort is stable, so equal scores keep
  // catalog order (customer is declared before staff) — a name/email/phone
  // sheet never loses a tie to staff.
  candidates.sort((a, b) => b.score - a.score);
  let winner = candidates[0]!;
  let reviewRequired = false;

  // Ambiguity guard: staff won, but only on a SOFT signal (role/position/job
  // title) — data that just as plausibly describes a customer. Lean to the
  // customer interpretation and force manual review rather than silently
  // filing people as staff (and offering them a staff-invite CTA).
  if (winner.entity === "staff" && !hasStrongStaffSignal) {
    const customer = candidates.find((c) => c.entity === "customer");
    if (customer) {
      winner = customer;
      reviewRequired = true;
    }
  }

  return {
    sheet,
    entity_type: winner.entity,
    confidence: winner.score,
    column_map: winner.column_map,
    field_confidence: winner.field_confidence,
    review_required: reviewRequired,
  };
}

// ---------------------------------------------------------------------------
// Row → mapped record
// ---------------------------------------------------------------------------

export function mapRow(detected: DetectedSheet, row: Cell[]): MappedRow {
  if (detected.entity_type === "unknown") {
    return { entity_type: "customer", confidence: 0, mapped: {}, warnings: ["unknown entity"] };
  }
  const headers = detected.sheet.header;
  const headerIdx = (h: string) => headers.indexOf(h);
  const get = (canonical: string): Cell => {
    const source = detected.column_map[canonical];
    if (!source) return null;
    const idx = headerIdx(source);
    return idx >= 0 ? row[idx] ?? null : null;
  };

  const warnings: string[] = [];
  const mapped: Record<string, unknown> = {};
  const entity = detected.entity_type;
  const fields = ENTITY_FIELDS[entity];

  for (const canonical of Object.keys(fields)) {
    const raw = get(canonical);
    if (raw === null) continue;
    const v = normaliseValue(canonical, raw, entity, warnings);
    if (v !== null && v !== undefined) {
      mapped[canonical] = v;
    }
  }

  // Per-row confidence: start with sheet's overall, knock down if required
  // fields are empty in this specific row.
  let rowConf = detected.confidence;
  for (const req of REQUIRED_FIELDS[entity]) {
    if (mapped[req] === undefined || mapped[req] === null || mapped[req] === "") {
      rowConf = Math.max(0, rowConf - 30);
      warnings.push(`missing ${req}`);
    }
  }

  return { entity_type: entity, confidence: Math.round(rowConf), mapped, warnings };
}

/**
 * Re-map a previously-extracted raw row to a *chosen* entity type.
 *
 * Used by the "Needs review" flow: when an operator re-classifies a row
 * whose automatic detection was uncertain (or wrong), we re-derive the
 * mapped fields against the target entity's column aliases. We rebuild a
 * single-row ParsedSheet from the stored raw record (header → value) and
 * run the SAME mapColumns + mapRow path the original upload used — so
 * there's no bespoke mapping logic here to drift out of sync with the
 * detector. The returned confidence mirrors detectEntityType's formula;
 * callers that treat the re-classification as human-verified may override
 * it (e.g. to 100).
 */
export function remapRawToEntity(
  raw: Record<string, unknown>,
  entity: EntityType,
): MappedRow {
  const header = Object.keys(raw);
  const cells: Cell[] = header.map((h) => {
    const v = raw[h];
    if (v === null || v === undefined) return null;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      return v;
    }
    return String(v);
  });
  const sheet: ParsedSheet = { name: "review", header, rows: [cells] };
  const { map, perField } = mapColumns(header, ENTITY_FIELDS[entity]);
  // Same confidence formula detectEntityType uses, so a re-classified row
  // carries a comparable score before the human override.
  const allFields = Object.keys(ENTITY_FIELDS[entity]);
  const required = REQUIRED_FIELDS[entity];
  const avg =
    allFields.length > 0
      ? allFields.reduce((s, f) => s + (perField[f] ?? 0), 0) / allFields.length
      : 0;
  const requiredAvg =
    required.length > 0
      ? required.reduce((s, f) => s + (perField[f] ?? 0), 0) / required.length
      : 0;
  const confidence = Math.min(100, Math.round(avg * 0.6 + requiredAvg * 0.4));
  const detected: DetectedSheet = {
    sheet,
    entity_type: entity,
    confidence,
    column_map: map,
    field_confidence: perField,
  };
  return mapRow(detected, cells);
}

function normaliseValue(
  field: string,
  raw: Cell,
  entity: EntityType,
  warnings: string[],
): unknown {
  if (raw === null) return null;

  // A VAT rate is a percentage, not money — parseMoney would read a
  // percent-formatted cell (SheetJS hands "20%" over as 0.2) as twenty pence.
  // parseVatRate owns that conversion so `mapped.vat_rate` is always in percent
  // units. An unusable rate cell is dropped with a warning rather than guessed
  // at; the commit path then resolves the rate from the VAT amount instead.
  if (field === "vat_rate") {
    const n = parseVatRate(raw);
    if (n === null) {
      warnings.push(`bad VAT rate: ${String(raw)}`);
      return null;
    }
    return n;
  }
  if (
    field === "amount" ||
    field === "total" ||
    field === "vat_total" ||
    field === "hourly_pay" ||
    field === "estimated_value" ||
    field === "value"
  ) {
    const n = parseMoney(raw);
    if (n === null) {
      warnings.push(`bad number in ${field}: ${String(raw)}`);
      return null;
    }
    return n;
  }
  if (
    field === "due_date" ||
    field === "paid_at" ||
    field === "start_date" ||
    field === "created_at" ||
    field === "scheduled_date" ||
    field === "valid_until"
  ) {
    const d = normaliseDate(raw);
    if (!d) {
      warnings.push(`bad date in ${field}: ${String(raw)}`);
      return null;
    }
    return d;
  }
  if (field === "email") {
    const s = String(raw).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
      warnings.push(`bad email: ${s}`);
      return null;
    }
    return s;
  }
  if (field === "phone") {
    // Loose: strip whitespace, keep + and digits.
    return String(raw).replace(/[^\d+]/g, "") || null;
  }
  if (field === "status" && entity === "invoice") {
    const s = String(raw).toLowerCase().trim();
    if (["paid", "yes", "y", "true"].includes(s)) return "paid";
    // "overdue" is NOT mapped to a stored status: it is derived from due_date
    // plus the trigger-owned payment status (lib/invoices/overdue.ts), so
    // storing it would create a value nothing keeps current. No information is
    // lost — an invoice a CSV calls overdue is unpaid and past its date, which
    // `sent` + its due_date already says, and the derived authority will show
    // it as overdue on the same terms as every other invoice.
    if (["overdue"].includes(s)) return "sent";
    if (["sent", "issued"].includes(s)) return "sent";
    if (["draft"].includes(s)) return "draft";
    return "sent"; // safe default
  }
  if (field === "status" && entity === "job") {
    // jobs.status check: 'new'|'in-progress'|'completed'|'blocked'
    const s = String(raw).toLowerCase().trim();
    if (["completed", "done", "finished", "closed"].includes(s)) return "completed";
    if (["blocked", "on hold", "hold", "stuck"].includes(s)) return "blocked";
    if (
      s.includes("progress") ||
      ["in-progress", "in progress", "wip", "active", "started"].includes(s)
    ) {
      return "in-progress";
    }
    return "new"; // safe default
  }
  if (field === "status" && entity === "quote") {
    // quotes.status: draft / sent / viewed / accepted / declined / expired
    const s = String(raw).toLowerCase().trim();
    if (["accepted", "won", "approved"].includes(s)) return "accepted";
    if (["declined", "lost", "rejected"].includes(s)) return "declined";
    if (["expired", "stale"].includes(s)) return "expired";
    if (["viewed", "opened"].includes(s)) return "viewed";
    if (["sent", "issued", "out"].includes(s)) return "sent";
    return "draft";
  }
  if (field === "urgency" && entity === "lead") {
    const s = String(raw).toLowerCase().trim();
    if (["urgent", "high", "asap"].includes(s)) return "urgent";
    if (["medium", "med", "normal"].includes(s)) return "medium";
    if (["low", "later"].includes(s)) return "low";
    return null;
  }
  if (field === "employment_type") {
    const s = String(raw).toLowerCase().trim();
    if (s.includes("self") || s.includes("subbie") || s.includes("contractor"))
      return "self_employed";
    if (s.includes("apprentice")) return "apprentice";
    if (s.includes("contract")) return "contractor";
    return "employee";
  }
  return String(raw).trim();
}

function parseMoney(raw: Cell): number | null {
  if (typeof raw === "number") return Math.round(raw * 100) / 100;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[£$€,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function normaliseDate(raw: Cell): string | null {
  if (typeof raw === "number") {
    // Excel serial date — days since 1899-12-30.
    const ms = (raw - 25569) * 86400 * 1000;
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const d = m[1]!.padStart(2, "0");
    const mo = m[2]!.padStart(2, "0");
    let y = m[3]!;
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo}-${d}`;
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}
