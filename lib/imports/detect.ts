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

import type { Cell, ParsedSheet } from "./parsers";

export type EntityType =
  | "customer"
  | "invoice"
  | "lead"
  | "staff"
  | "cost"
  | "supplier";

export type ColumnMap = {
  // The canonical target field → source-header it came from.
  [canonicalField: string]: string;
};

export type DetectedSheet = {
  sheet: ParsedSheet;
  entity_type: EntityType | "unknown";
  confidence: number; // 0–100
  column_map: ColumnMap;
  field_confidence: Record<string, number>; // per-field signal score
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
  total: ["total", "amount inc vat", "gross", "grand total"],
  due_date: ["due date", "due", "payment due"],
  paid_at: ["paid date", "paid at", "date paid", "paid"],
  status: ["status", "paid?", "payment status"],
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

const ENTITY_FIELDS: Record<EntityType, Record<string, string[]>> = {
  customer: CUSTOMER_FIELDS,
  invoice: INVOICE_FIELDS,
  lead: LEAD_FIELDS,
  staff: STAFF_FIELDS,
  cost: COST_FIELDS,
  supplier: SUPPLIER_FIELDS,
};

const REQUIRED_FIELDS: Record<EntityType, string[]> = {
  customer: ["name"], // need at least a name
  invoice: ["number", "total"],
  lead: ["name"],
  staff: ["full_name"],
  cost: ["amount"],
  supplier: ["name"],
};

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

function findColumn(
  headers: string[],
  aliases: string[],
): { idx: number; header: string; score: number } | null {
  const lowered = headers.map((h) => h.toLowerCase().trim());
  for (const a of aliases) {
    const exact = lowered.indexOf(a);
    if (exact >= 0) return { idx: exact, header: headers[exact]!, score: 100 };
  }
  // Substring match — lower confidence.
  for (const a of aliases) {
    for (let i = 0; i < lowered.length; i++) {
      if (lowered[i]!.includes(a)) {
        return { idx: i, header: headers[i]!, score: 70 };
      }
    }
  }
  return null;
}

function mapColumns(
  headers: string[],
  fields: Record<string, string[]>,
): { map: ColumnMap; perField: Record<string, number>; idxMap: Record<string, number> } {
  const map: ColumnMap = {};
  const perField: Record<string, number> = {};
  const idxMap: Record<string, number> = {};
  for (const [canonical, aliases] of Object.entries(fields)) {
    const found = findColumn(headers, aliases);
    if (found) {
      map[canonical] = found.header;
      perField[canonical] = found.score;
      idxMap[canonical] = found.idx;
    } else {
      perField[canonical] = 0;
    }
  }
  return { map, perField, idxMap };
}

// ---------------------------------------------------------------------------
// Entity-type detection per sheet
// ---------------------------------------------------------------------------

export function detectEntityType(sheet: ParsedSheet): DetectedSheet {
  // Supplier requires an explicit "supplier" / "vendor" keyword in at
  // least one header, otherwise we'd grab every customer sheet.
  const lowered = sheet.header.map((h) => h.toLowerCase());
  const supplierSignal = lowered.some((h) => h.includes("supplier") || h.includes("vendor"));

  let best: DetectedSheet | null = null;
  for (const entity of Object.keys(ENTITY_FIELDS) as EntityType[]) {
    if (entity === "supplier" && !supplierSignal) continue;
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
    const score = Math.round(avg * 0.6 + requiredAvg * 0.4);
    if (!best || score > best.confidence) {
      best = {
        sheet,
        entity_type: entity,
        confidence: Math.min(100, score),
        column_map: map,
        field_confidence: perField,
      };
    }
  }
  if (!best) {
    return {
      sheet,
      entity_type: "unknown",
      confidence: 0,
      column_map: {},
      field_confidence: {},
    };
  }
  return best;
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

function normaliseValue(
  field: string,
  raw: Cell,
  entity: EntityType,
  warnings: string[],
): unknown {
  if (raw === null) return null;

  if (
    field === "amount" ||
    field === "total" ||
    field === "vat_total" ||
    field === "hourly_pay" ||
    field === "estimated_value"
  ) {
    const n = parseMoney(raw);
    if (n === null) {
      warnings.push(`bad number in ${field}: ${String(raw)}`);
      return null;
    }
    return n;
  }
  if (field === "due_date" || field === "paid_at" || field === "start_date" || field === "created_at") {
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
    if (["overdue"].includes(s)) return "overdue";
    if (["sent", "issued"].includes(s)) return "sent";
    if (["draft"].includes(s)) return "draft";
    return "sent"; // safe default
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
