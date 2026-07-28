/**
 * Migration OS — matching spreadsheet headers to canonical fields.
 *
 * This module exists because the original matcher lost money.
 *
 * It matched each canonical field independently, and each field took the first
 * header that *contained* one of its aliases anywhere. Three things followed
 * from that, all of them silent:
 *
 *   1. `VAT Reg No` contains "vat", so a VAT *registration number* was read as
 *      a VAT *amount* — a company's tax ID became reclaimable tax.
 *   2. `Total Due` contains "due", so an invoice's money column was ALSO read
 *      as `due_date`, and a total of 1250.00 became an Excel serial date.
 *   3. `Subtotal` contains "total", so on a net/VAT/gross sheet the `total`
 *      field bound to the SUBTOTAL — every invoice imported VAT-exclusive.
 *
 * Nothing about those failures was specific to one spreadsheet, so nothing
 * about the fix is either. There is no list of known-bad headers here. Instead
 * two general rules do the work:
 *
 *   WHOLE-TOKEN MATCHING. An alias matches only as a complete run of whole
 *   words. "total" matches `Total Due` and does not match `Subtotal`, the same
 *   way "cat" is not a word in "catalogue". This alone closes (3).
 *
 *   SEMANTIC FIELD CLASSES. Every canonical field declares what KIND of thing
 *   it holds — money, a date, a rate, an identifier, a contact, free text, an
 *   enum. Every field class then declares which kinds of thing it is NOT. A
 *   loose match is refused when the header carries a word that contradicts the
 *   field's class: `reg`/`no`/`ref`/`id` say "this is an identifier, not
 *   money", and `total`/`amount`/`balance` say "this is money, not a date".
 *   That closes (1) and (2), and closes the whole family they belong to —
 *   `Tax ID`, `VAT Number`, `Amount Due`, `Balance Due`, `Value Date`,
 *   `Payment Terms` and so on all fall out of the same rule.
 *
 * The critical subtlety in that second rule is WHERE the contradiction has to
 * appear. It is evaluated on the RESIDUAL tokens — the words the header carries
 * *beyond* the alias that matched — never on the alias itself. Without that,
 * `Hourly Rate` would be refused as money because "rate" is a rate-word, even
 * though "hourly rate" is precisely the alias asking for it. With it, the rule
 * reads the way a person would: `Hourly Rate` is pay, `Rate %` is a percentage,
 * `VAT` is an amount, `VAT Reg No` is a registration.
 *
 * Finally, matching happens in two global passes rather than per field:
 * every exact match is claimed first, then loose matches compete for what is
 * left. A column belongs to at most one field. `Total Due` cannot be both the
 * total and the due date, which is what let defect (2) exist at all.
 */

/** What KIND of value a canonical field holds. Drives the negative rules. */
export type FieldClass =
  | "money"
  | "rate"
  | "date"
  | "identifier"
  | "email"
  | "phone"
  | "text"
  | "enum";

/**
 * The class of every canonical field in the catalogue, keyed by field name.
 *
 * Field names are reused across entities (`amount` is a cost's net figure and
 * an invoice's and a payment's) and mean the same kind of thing every time, so
 * one map covers all of them. A field missing from here is treated as "text",
 * the class with the fewest restrictions — an unclassified field can still
 * match, it just gets no protection.
 */
const FIELD_CLASSES: Record<string, FieldClass> = {
  // Money. The columns a wrong match actually costs the operator.
  amount: "money",
  total: "money",
  vat_total: "money",
  hourly_pay: "money",
  estimated_value: "money",
  value: "money",
  // Percentages.
  vat_rate: "rate",
  // Dates.
  due_date: "date",
  paid_at: "date",
  start_date: "date",
  created_at: "date",
  scheduled_date: "date",
  valid_until: "date",
  // Identifiers / references.
  number: "identifier",
  invoice_number: "identifier",
  reference: "identifier",
  postcode: "identifier",
  // Contact.
  email: "email",
  assigned_email: "email",
  phone: "phone",
  // Constrained vocabularies.
  status: "enum",
  urgency: "enum",
  employment_type: "enum",
  // Free text.
  name: "text",
  full_name: "text",
  customer_name: "text",
  notes: "text",
  address: "text",
  address_line1: "text",
  city: "text",
  title: "text",
  source: "text",
  service: "text",
  category: "text",
  payment_method: "text",
};

// ---------------------------------------------------------------------------
// Semantic markers — words that say what a header IS.
//
// Matched as WHOLE TOKENS, never substrings: "valid" must not read as "value",
// and "no" must not fire inside "notes".
// ---------------------------------------------------------------------------

/** Words that mean "this column holds money". */
const MONEY_MARKERS = [
  "amount", "amt", "total", "totals", "subtotal", "net", "gross", "balance",
  "value", "values", "price", "cost", "costs", "fee", "fees", "charge",
  "charges", "sum", "vat", "tax", "spend", "revenue", "turnover",
  "£", "$", "€", "gbp", "usd", "eur",
];

/**
 * Words that mean "this column holds a date".
 *
 * Deliberately excludes "due", "paid", "start" and "day". The first three are
 * ambiguous — `Total Due` and `Amount Paid` are money, `Due Date` and
 * `Paid Date` are dates — and are resolved by the other side's markers instead.
 * "day" is excluded because `Day Rate` is a wage, not a date.
 */
const DATE_MARKERS = ["date", "dates", "dated", "month", "year", "when", "timestamp", "time"];

/** Words that mean "this column holds a percentage". */
const RATE_MARKERS = ["rate", "rates", "%", "percent", "percentage", "pct"];

/**
 * Words that mean "this column holds a reference, not a quantity".
 *
 * This is the set that stops `VAT Reg No`, `VAT Number`, `Tax ID` and `UTR`
 * from ever being read as a VAT amount.
 */
const IDENTIFIER_MARKERS = [
  "no", "nos", "num", "number", "numbers", "ref", "refs", "reference",
  "id", "ids", "code", "reg", "regd", "registration", "registered",
  "utr", "nino", "tin", "ein", "vrn", "iban", "bic", "swift",
  "acct", "account", "sortcode",
];

/** Words that mean "this column holds a way of reaching someone". */
const CONTACT_MARKERS = ["email", "mail", "phone", "tel", "telephone", "mobile", "cell", "fax"];

/** Words that mean "this column holds a label or a count, not a value". */
const META_MARKERS = [
  "status", "method", "terms", "type", "stage", "state", "category",
  "notes", "note", "description", "comment", "comments",
  "qty", "quantity", "count", "units", "unit",
];

const set = (...groups: string[][]) => new Set(groups.flat());

/**
 * For each field class, the markers that DISQUALIFY a loose match.
 *
 * Read a row as a sentence: money is not an identifier, a rate, a date, a
 * contact or a label. A date is not money, a rate, an identifier, a contact or
 * a label. And so on.
 *
 * Two classes are deliberately lenient:
 *
 *   - `email` / `phone` are not protected from IDENTIFIER_MARKERS, because
 *     `Mobile Number` and `Contact Number` are phone columns. "number" next to
 *     a contact word means a phone number, not a reference.
 *   - `text` is protected only from money, dates and rates. Text is the
 *     catch-all class and over-restricting it costs real matches (`notes`,
 *     `category`, `title`) while protecting nothing financial.
 */
const CLASS_NEGATIVES: Record<FieldClass, ReadonlySet<string>> = {
  money: set(IDENTIFIER_MARKERS, RATE_MARKERS, DATE_MARKERS, CONTACT_MARKERS, META_MARKERS),
  date: set(MONEY_MARKERS, RATE_MARKERS, IDENTIFIER_MARKERS, CONTACT_MARKERS, META_MARKERS),
  rate: set(MONEY_MARKERS, IDENTIFIER_MARKERS, DATE_MARKERS, CONTACT_MARKERS, META_MARKERS),
  identifier: set(MONEY_MARKERS, DATE_MARKERS, RATE_MARKERS, CONTACT_MARKERS),
  enum: set(MONEY_MARKERS, DATE_MARKERS, RATE_MARKERS, IDENTIFIER_MARKERS),
  email: set(MONEY_MARKERS, DATE_MARKERS, RATE_MARKERS),
  phone: set(MONEY_MARKERS, DATE_MARKERS, RATE_MARKERS),
  text: set(MONEY_MARKERS, DATE_MARKERS, RATE_MARKERS),
};

export function fieldClass(field: string): FieldClass {
  return FIELD_CLASSES[field] ?? "text";
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Split a header (or an alias) into comparable whole-word tokens.
 *
 * Everything that separates words in a machine-generated header becomes a
 * space: underscores and hyphens (`customer_name`, `invoice-number` — the
 * shapes a database export or a CSV written by code produces), plus brackets,
 * colons, slashes, `#`, `*` and stray punctuation. Currency symbols and `%`
 * survive as tokens of their own, because they are the strongest single
 * signal a header carries about what kind of column it is.
 *
 * Aliases go through the exact same function, so "e-mail" and a header of
 * "E-Mail" meet in the middle at ["e", "mail"] rather than missing each other.
 */
export function headerTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    // Keep letters, digits, currency symbols and %; everything else separates.
    .replace(/[^\p{L}\p{N}£$€%]+/gu, " ")
    // Split a currency symbol or % away from a digit/word it is glued to
    // ("amount£", "20%") so it becomes its own token.
    .replace(/([£$€%])/g, " $1 ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** The header as a single normalised string — tokens rejoined with spaces. */
export function normaliseHeader(raw: string): string {
  return headerTokens(raw).join(" ");
}

/**
 * An extra form of the header with runs of single letters glued back together.
 *
 * OCR of a scanned invoice routinely letter-spaces a heading, so "VAT" comes
 * back as "V A T" and "TOTAL" as "T O T A L". Joining runs of two or more
 * single-character tokens recovers those without touching normal headers —
 * a real header never consists of consecutive one-letter words. Returned as an
 * ADDITIONAL candidate rather than a replacement, so nothing is lost if the
 * guess is wrong.
 */
function glueSingleLetterRuns(tokens: string[]): string[] | null {
  const out: string[] = [];
  let run: string[] = [];
  let glued = false;
  const flush = () => {
    if (run.length >= 2) {
      out.push(run.join(""));
      glued = true;
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const t of tokens) {
    if (t.length === 1 && /\p{L}/u.test(t)) run.push(t);
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return glued ? out : null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Where an alias's tokens sit inside a header's tokens, if they do at all. */
function findTokenRun(header: string[], alias: string[]): number | null {
  if (alias.length === 0 || alias.length > header.length) return null;
  for (let i = 0; i + alias.length <= header.length; i++) {
    let hit = true;
    for (let j = 0; j < alias.length; j++) {
      if (header[i + j] !== alias[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return null;
}

/**
 * Does the header carry a word that contradicts this field's class?
 *
 * Only the RESIDUAL tokens are considered — the ones outside the span the
 * alias matched. See the module header: an alias is allowed to contain the
 * very word its class forbids ("hourly rate" is money despite "rate"), because
 * the alias is the field asking for that word explicitly.
 */
function contradicts(
  headerTokensList: string[],
  matchStart: number,
  matchLength: number,
  cls: FieldClass,
): boolean {
  const negatives = CLASS_NEGATIVES[cls];
  for (let i = 0; i < headerTokensList.length; i++) {
    if (i >= matchStart && i < matchStart + matchLength) continue; // inside the alias
    if (negatives.has(headerTokensList[i]!)) return true;
  }
  return false;
}

export type MatchedColumn = { idx: number; header: string; score: number };

export type ColumnMatch = {
  /** canonical field → source header text (unchanged public shape). */
  map: Record<string, string>;
  /** canonical field → 0 (no match) | 70 (loose) | 100 (exact). */
  perField: Record<string, number>;
  /** canonical field → index into `headers`. */
  idxMap: Record<string, number>;
};

type LooseCandidate = {
  field: string;
  fieldOrder: number;
  headerIdx: number;
  aliasIdx: number;
  aliasLength: number;
  coverage: number;
  startsAtWordOne: boolean;
};

/**
 * Match a sheet's headers onto a catalogue of canonical fields.
 *
 * Two passes, both global:
 *
 *   1. EXACT. A header whose whole normalised text equals an alias is claimed
 *      by that field outright and removed from play. Doing every field's exact
 *      matches before any field's loose ones is what stops a vague alias from
 *      stealing a column that another field names precisely.
 *   2. LOOSE. Whole-token-run matches on the columns still unclaimed, filtered
 *      by the class rules, then awarded best-first so the strongest evidence
 *      wins rather than whichever field happened to be declared earliest.
 *
 * A header is claimed by at most one field, and a field claims at most one
 * header.
 */
export function matchColumns(
  headers: string[],
  fields: Record<string, string[]>,
): ColumnMatch {
  const map: Record<string, string> = {};
  const perField: Record<string, number> = {};
  const idxMap: Record<string, number> = {};

  const tokenised = headers.map((h) => headerTokens(h));
  const glued = tokenised.map((t) => glueSingleLetterRuns(t));
  const normalised = tokenised.map((t) => t.join(" "));
  const gluedNormalised = glued.map((t) => (t ? t.join(" ") : null));

  const fieldNames = Object.keys(fields);
  for (const f of fieldNames) perField[f] = 0;

  const claimedHeaders = new Set<number>();
  const claim = (field: string, headerIdx: number, score: number) => {
    map[field] = headers[headerIdx]!;
    perField[field] = score;
    idxMap[field] = headerIdx;
    claimedHeaders.add(headerIdx);
  };

  // --- Pass 1: exact ------------------------------------------------------
  for (const field of fieldNames) {
    const aliases = fields[field]!;
    let done = false;
    for (const alias of aliases) {
      if (done) break;
      const a = normaliseHeader(alias);
      if (!a) continue;
      for (let i = 0; i < headers.length; i++) {
        if (claimedHeaders.has(i)) continue;
        if (normalised[i] === a || gluedNormalised[i] === a) {
          claim(field, i, 100);
          done = true;
          break;
        }
      }
    }
  }

  // --- Pass 2: loose ------------------------------------------------------
  const candidates: LooseCandidate[] = [];
  fieldNames.forEach((field, fieldOrder) => {
    if (perField[field]! > 0) return; // already exact-matched
    const cls = fieldClass(field);
    const aliases = fields[field]!;
    aliases.forEach((alias, aliasIdx) => {
      const aliasTokens = headerTokens(alias);
      if (aliasTokens.length === 0) return;
      for (let i = 0; i < headers.length; i++) {
        if (claimedHeaders.has(i)) continue;
        // Try the header as read, then the OCR-repaired form.
        for (const toks of [tokenised[i]!, glued[i]].filter(Boolean) as string[][]) {
          const at = findTokenRun(toks, aliasTokens);
          if (at === null) continue;
          if (contradicts(toks, at, aliasTokens.length, cls)) continue;
          candidates.push({
            field,
            fieldOrder,
            headerIdx: i,
            aliasIdx,
            aliasLength: aliasTokens.length,
            coverage: aliasTokens.length / toks.length,
            startsAtWordOne: at === 0,
          });
          break;
        }
      }
    });
  });

  // Best evidence first: a longer alias phrase beats a shorter one, then the
  // alias that accounts for more of the header, then one anchored at the start
  // of the header, then the more specific alias (aliases are declared
  // most-specific-first), then catalogue order. Every tiebreak is a total
  // order on stable data, so the assignment is deterministic.
  candidates.sort(
    (a, b) =>
      b.aliasLength - a.aliasLength ||
      b.coverage - a.coverage ||
      Number(b.startsAtWordOne) - Number(a.startsAtWordOne) ||
      a.aliasIdx - b.aliasIdx ||
      a.fieldOrder - b.fieldOrder ||
      a.headerIdx - b.headerIdx,
  );

  for (const c of candidates) {
    if (perField[c.field]! > 0) continue;
    if (claimedHeaders.has(c.headerIdx)) continue;
    claim(c.field, c.headerIdx, 70);
  }

  return { map, perField, idxMap };
}
