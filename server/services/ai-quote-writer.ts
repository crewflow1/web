import "server-only";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI QUOTE WRITER — the server runtime.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Context → prompt → (one governed model call) → validated draft → stored row.
 * And then it stops. It writes NO quote, sends NOTHING, and has no reference to
 * any send path.
 *
 * THE FOUR BOUNDARIES THIS MODULE HOLDS
 * -------------------------------------
 *  1. ONE INVOCATION PATH. The only way a model is reached is
 *     `invokeWithGovernor(QUOTE_WRITER_FEATURE, "drafting", …)`. No vendor SDK
 *     is imported here or anywhere in the feature; the model arrives through
 *     `getTextProvider()`, the existing Directive-009 abstraction, exactly as
 *     the conversation engine reaches one.
 *
 *  2. NO DETERMINISTIC LEG, AND THAT IS SAID OUT LOUD. Every other governed
 *     capability degrades to a computed answer, so a user cannot tell whether
 *     AI ran. A scope of works is not computable. When no model is bound this
 *     function returns `unavailable` and the UI says so. Inventing a
 *     "fallback quote" would be the single most dangerous thing this module
 *     could do — a plausible scope of works nobody wrote.
 *
 *  3. THE HUMAN IS THE ONLY WRITER. `applyQuoteDraft` records what the operator
 *     chose and hands back LINE ITEMS. It does not touch `quotes`. The operator
 *     then saves through the ordinary builder, with the ordinary validation,
 *     the ordinary approval gate and the ordinary send gate — none of which
 *     this module can see, let alone call.
 *
 *  4. EVENT-DRIVEN. Drafting runs when a PERSON PRESSES A BUTTON. It is never
 *     on a render path, a `useEffect`, or a poll — the governor's doctrine, and
 *     the rule no wrapper can enforce on a caller's behalf.
 *
 * ORG PINNING. Every read carries `.eq("org_id", ctx.org.id)` on top of RLS.
 * RLS's `current_org_ids()` spans EVERY org the caller belongs to, so for a
 * dual-org user an unpinned read silently answers about the wrong tenant —
 * the defect class #456/#468 closed across the app. A quote writer that
 * assembled its price book from another org's quotes would be a cross-tenant
 * disclosure with a model attached.
 */

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext, type OrgContext } from "@/server/auth/session";
import { getTextProvider } from "@/lib/ai/text";
import {
  invocationHash,
  invokeWithGovernor,
  isTierActivated,
  type GovernedCall,
} from "@/lib/ai/governor";
import {
  QUOTE_WRITER_FEATURE,
  QUOTE_WRITER_TASK_CLASS,
  getQuoteWriterReadiness,
  type QuoteWriterReadiness,
} from "@/lib/ai/quote-writer-readiness";
import {
  assertQuoteContextDisclosure,
  emptyQuoteContext,
  outwardPostcode,
  populatedQuoteContextFields,
  type QuoteContext,
  type QuoteContextFieldKey,
  type QuotePriceBookEntry,
} from "@/lib/ai/quote-context";
import { assembleQuotePrompt, type AssembledQuotePrompt } from "@/lib/ai/quote-prompt";
import {
  interpretQuoteDraftResponse,
  type InterpretedQuoteDraft,
} from "@/lib/ai/quote-draft-pipeline";
import {
  QUOTE_DRAFT_SCHEMA_VERSION,
  parseQuoteDraft,
  toQuoteLineItems,
  type QuoteDraft,
} from "@/lib/ai/quote-draft-schema";
import type { LineItem } from "@/lib/quotes/schema";

const DRAFTS = "ai_quote_drafts";

/** Output cap. A scope of works is not a novel; an unbounded cap is a bill. */
const MAX_OUTPUT_TOKENS = 2_000;
/** Deterministic decoding. A quote is not a place for creative sampling. */
const TEMPERATURE = 0;
/** How many historic line prices form the price book. */
const PRICE_BOOK_LIMIT = 200;

/**
 * The generated types (lib/supabase/types.ts) are regenerated on a separate
 * cadence, so `ai_quote_drafts` is not in them yet. The codebase's established
 * idiom for that gap is a narrow structural cast at the call site rather than a
 * types regeneration inside a feature branch — see `expense_drafts` in
 * server/services/expense-drafts.ts and `ai_invocations` in lib/ai/governor.ts.
 */
type Row = Record<string, unknown>;
type MaybeErr = { message: string; code?: string } | null;
type Selector = {
  eq(column: string, value: unknown): Selector;
  order(column: string, opts: { ascending: boolean }): Selector;
  limit(n: number): Selector;
  maybeSingle(): PromiseLike<{ data: Row | null; error: MaybeErr }>;
  then: PromiseLike<{ data: Row[] | null; error: MaybeErr }>["then"];
};
type Updater = {
  eq(column: string, value: unknown): Updater;
  select(columns: string): { maybeSingle(): PromiseLike<{ data: Row | null; error: MaybeErr }> };
};
type Table = {
  select(columns: string): Selector;
  insert(row: Row): {
    select(columns: string): { single(): PromiseLike<{ data: Row | null; error: MaybeErr }> };
  };
  update(row: Row): Updater;
};
const table = (client: unknown, name: string) =>
  (client as { from(t: string): unknown }).from(name) as Table;

// ═══════════════════════════════════════════════════════════════════════════
// 1. buildQuoteContext — THE DISCLOSURE CONTRACT, in executable form.
// ═══════════════════════════════════════════════════════════════════════════

export type QuoteContextInput = {
  /** Draft against an existing quote (re-scoping). */
  quoteId?: string | null;
  /** Draft against a lead, before any quote exists. The common case. */
  leadId?: string | null;
  /**
   * Text extracted from an uploaded document or an imported email, supplied by
   * the caller rather than read from a table — no such store exists yet, and
   * the contract names the field because the PROMPT BOUNDARY has to handle it
   * whichever way it eventually arrives. Untrusted; fenced as data.
   */
  documentText?: string | null;
};

export type BuiltQuoteContext = {
  context: QuoteContext;
  /** Which contract fields were actually populated. Stored on the draft. */
  fields: ReadonlyArray<QuoteContextFieldKey>;
};

/**
 * Assemble exactly what leaves CrewFlow, and nothing else.
 *
 * THIS FUNCTION'S RETURN VALUE IS THE DISCLOSURE CONTRACT. Not the doc — the
 * doc describes it. `assertQuoteContextDisclosure` refuses anything outside the
 * closed set before it can be assembled into a prompt, so a future author who
 * adds `customer_name` here gets a failed test, not a quiet disclosure.
 *
 * Reads are ORG-PINNED and FAIL LOUD (`readFailure`). A silent empty context
 * would produce a confident-looking draft assembled from nothing, which is
 * exactly the failure mode `docs/loud-read-failures.md` exists to prevent.
 */
export async function buildQuoteContext(input: QuoteContextInput): Promise<BuiltQuoteContext> {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const context = emptyQuoteContext();

  let leadId = input.leadId ?? null;
  let propertyId: string | null = null;

  // --- the quote, when re-scoping an existing one -------------------------
  if (input.quoteId) {
    const { data, error } = await supabase
      .from("quotes")
      .select("id, notes, lead_id, property_id")
      .eq("id", input.quoteId)
      // ACTIVE-ORG SCOPE. Without it a dual-org user drafting in org A would
      // assemble a prompt from org B's quote — a cross-tenant read with a
      // third-party model on the other end of it.
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    if (error) throw readFailure("ai quote writer: source quote", error);
    if (data) {
      context.work_description = nullableText(data.notes);
      leadId = leadId ?? data.lead_id;
      propertyId = data.property_id;
    }
  }

  // --- the lead ------------------------------------------------------------
  if (leadId) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, notes, service, postcode, property_id")
      .eq("id", leadId)
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    if (error) throw readFailure("ai quote writer: source lead", error);
    if (data) {
      // The lead's own words are the richer scope source when both exist.
      context.work_description = nullableText(data.notes) ?? context.work_description;
      context.property_kind = nullableText(data.service) ?? context.property_kind;
      // MINIMISATION HAPPENS HERE: the outward half only, and a value that is
      // not postcode-shaped becomes null rather than being passed through — a
      // "postcode" column holding a house name must not become a way to smuggle
      // an address past the contract.
      context.postcode_outward = outwardPostcode(data.postcode);
      propertyId = propertyId ?? data.property_id;
    }
  }

  // --- the property: NOTES ONLY, never the address -------------------------
  if (propertyId) {
    const { data, error } = await supabase
      .from("properties")
      .select("id, notes")
      .eq("id", propertyId)
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    if (error) throw readFailure("ai quote writer: property", error);
    // `properties.address` is deliberately NOT selected. Site notes describe
    // access and constraints, which change the work; the address identifies a
    // household, which does not.
    if (data) context.site_notes = nullableText(data.notes);
  }

  // --- caller-supplied untrusted text --------------------------------------
  context.document_text = nullableText(input.documentText);

  // --- the org's own trade -------------------------------------------------
  context.org_trade = await readOrgTrade(supabase, ctx);

  // --- the price book: the org's OWN previous line prices ------------------
  context.price_book = await readPriceBook(supabase, ctx, input.quoteId ?? null);

  // THE GATE. Refuses anything the contract does not name, before assembly.
  assertQuoteContextDisclosure(context);

  return { context, fields: populatedQuoteContextFields(context) };
}

function nullableText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * The org's trade, from its AI receptionist setup — the one place CrewFlow
 * already asks a firm what it does. Absent for orgs that never configured it,
 * which simply means the draft uses generic construction vocabulary.
 */
async function readOrgTrade(supabase: unknown, ctx: OrgContext): Promise<string | null> {
  try {
    const { data, error } = await table(supabase, "ai_receptionist_setups")
      .select("trade_type")
      .eq("org_id", ctx.org.id)
      .limit(1)
      .maybeSingle();
    if (error) {
      // Non-fatal: a missing trade degrades the draft's vocabulary, nothing
      // more. Reported rather than thrown — unlike the scope reads above,
      // whose absence would make the draft wrong rather than generic.
      console.warn("[ai/quote-writer] trade read failed", error.message);
      return null;
    }
    return nullableText(data?.trade_type);
  } catch (e) {
    console.warn("[ai/quote-writer] trade read threw", e);
    return null;
  }
}

/**
 * The org's own price book — historic line descriptions and unit prices.
 *
 * THE ONLY SANCTIONED SOURCE OF A PRICE. Everything about this read is shaped
 * by the disclosure contract:
 *   - THREE COLUMNS. Not `quotes(customer_id)`, not `line_total`, not the quote
 *     it came from. The natural join would ship a customer id per line.
 *   - ORG-PINNED, and `quote_line_items` carries its own `org_id`, so this
 *     needs no join to be correct.
 *   - THE CURRENT QUOTE'S OWN LINES ARE EXCLUDED, so a re-scope cannot cite
 *     itself as a price source.
 *   - DEDUPED BY DESCRIPTION, most recent first: a firm that has quoted
 *     "supply and fit 600mm vanity unit" forty times contributes one entry.
 * Money crosses into the contract as INTEGER PENCE.
 */
async function readPriceBook(
  supabase: unknown,
  ctx: OrgContext,
  excludeQuoteId: string | null,
): Promise<ReadonlyArray<QuotePriceBookEntry>> {
  const { data, error } = await table(supabase, "quote_line_items")
    .select("description, unit, unit_price, quote_id")
    .eq("org_id", ctx.org.id)
    .order("id", { ascending: false })
    .limit(PRICE_BOOK_LIMIT);
  if (error) throw readFailure("ai quote writer: price book", error);

  const seen = new Set<string>();
  const out: QuotePriceBookEntry[] = [];
  for (const row of data ?? []) {
    if (excludeQuoteId && row.quote_id === excludeQuoteId) continue;
    const description = nullableText(row.description);
    const price = typeof row.unit_price === "number" ? row.unit_price : Number(row.unit_price);
    if (!description || !Number.isFinite(price) || price <= 0) continue;
    const key = description.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      description,
      unit: nullableText(row.unit) ?? "ea",
      // Major units → integer pence. `Math.round` because the stored numeric is
      // 2dp and floating-point multiplication of 19.99 does not land on 1999.
      unit_price_pence: Math.round(price * 100),
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. The model seam. No SDK. Ever.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The one shape this module knows a model by.
 *
 * Injectable ONLY so the eval harness can drive the pipeline with canned
 * responses. Production never passes it — `resolveQuoteWriterModel()` returns
 * null while no tier is bound, which is the dark state.
 */
export type QuoteWriterModel = {
  info: { provider: string; model: string };
  complete(prompt: {
    system: string;
    user: string;
  }): Promise<{ text: string; model: string; inputTokens: number; outputTokens: number }>;
};

/**
 * The real model, or `null`.
 *
 * TWO independent gates, and the order matters. The readiness check is first
 * and is a BUILD-TIME fact: with no tier bound to a model, this returns null
 * even on a deploy where every vendor credential is set. That is the #433
 * invariant — configuration can never manufacture a capability the build does
 * not contain — and it is why setting `ANTHROPIC_API_KEY` tomorrow switches
 * nothing on.
 */
export function resolveQuoteWriterModel(
  readiness: QuoteWriterReadiness = getQuoteWriterReadiness(),
): QuoteWriterModel | null {
  if (!readiness.available) return null;
  // PER-TIER OWN-CLASS GATE, EXPLICIT. `readiness.available` already requires the
  // `mid` tier (the `drafting` class) to be provider-resolvable, so this is
  // belt-and-braces — but stating it here keeps the invariant LOCAL and uniform
  // with every other door caller: `getTextProvider()` opens on ANY generative
  // tier, and only this call's own tier may authorise resolving a provider.
  if (!isTierActivated("mid")) return null;
  const provider = getTextProvider();
  if (!provider) return null;
  return {
    info: provider.info,
    async complete(prompt) {
      const result = await provider.generate(prompt.user, {
        system: prompt.system,
        temperature: TEMPERATURE,
        maxTokens: MAX_OUTPUT_TOKENS,
      });
      return {
        text: result.text,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. generateQuoteDraft — the one governed call.
// ═══════════════════════════════════════════════════════════════════════════

export type GenerateQuoteDraftInput = QuoteContextInput;

export type GenerateQuoteDraftOutcome =
  /** A draft was produced, validated and stored. */
  | {
      status: "created";
      draftId: string;
      draft: QuoteDraft;
      degraded: boolean;
      warnings: string[];
      lineItems: LineItem[];
    }
  /**
   * NO MODEL IS BOUND. There is no fallback, so nothing was produced. This is
   * the live state today and the honest one.
   */
  | { status: "unavailable"; blockers: string[] }
  /** The org is at its £100 monthly ceiling. The model was NOT called. */
  | { status: "blocked"; spentPence: number; ceilingPence: number }
  /** The identical request ran minutes ago. The model was NOT called. */
  | { status: "duplicate" }
  /** The model answered, and the answer was refused. Nothing was stored. */
  | { status: "rejected"; code: string; issues: string[] }
  /** The provider failed. The governor recorded it; the operator sees it. */
  | { status: "failed"; error: string };

/**
 * Draft a scope of works.
 *
 * EVENT-DRIVEN: call this from a form submission, never from a page render.
 *
 * The order of the gates is the whole design:
 *   1. NO MODEL ⇒ return `unavailable` before a single database read. Today
 *      this is the only branch that executes, in every environment.
 *   2. Build the context — org-pinned, contract-enforced.
 *   3. Assemble the prompt — instructions and untrusted data structurally apart.
 *   4. ONE governed call. Budget and dedupe are the governor's; this function
 *      translates its refusals into outcomes an operator can read.
 *   5. Validate the output STRICTLY. A refused draft is stored nowhere: a
 *      malformed generation is a defect to see, not an artifact to keep.
 *   6. Store what the model said, immutably.
 */
export async function generateQuoteDraft(
  input: GenerateQuoteDraftInput,
  deps: { model?: QuoteWriterModel | null } = {},
): Promise<GenerateQuoteDraftOutcome> {
  const readiness = getQuoteWriterReadiness();
  const model = deps.model !== undefined ? deps.model : resolveQuoteWriterModel(readiness);

  // 1. THE DARK GATE. No provider, no draft, no pretending otherwise.
  if (!model) {
    return { status: "unavailable", blockers: readiness.blockers };
  }

  const { ctx, user } = await requireOrgContext();

  // 2 + 3.
  const { context, fields } = await buildQuoteContext(input);
  const prompt = assembleQuotePrompt(context);

  // The dedupe identity: the exact prompt. Re-pressing the button on unchanged
  // inputs must not buy the same draft twice. Only its SHA-256 reaches the
  // ledger — never the customer's words.
  const dedupeContent = `${prompt.version} ${prompt.checksum}`;
  const fingerprint = invocationHash(QUOTE_WRITER_FEATURE, QUOTE_WRITER_TASK_CLASS, dedupeContent);

  // 4. THE ONE INVOCATION PATH.
  let outcome;
  try {
    outcome = await invokeWithGovernor(
      QUOTE_WRITER_FEATURE,
      QUOTE_WRITER_TASK_CLASS,
      () => callModel(model, prompt),
      { orgId: ctx.org.id, userId: user.id, dedupeContent },
    );
  } catch (err) {
    // The governor RECORDED the failure and rethrew, so this catch owns the
    // degraded path exactly as every other governed caller's does. There is no
    // degraded draft to fall back to, so the operator is told plainly.
    console.error("[ai/quote-writer] generation failed", err);
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  if (outcome.status === "blocked") {
    return {
      status: "blocked",
      spentPence: outcome.spentPence,
      ceilingPence: outcome.ceilingPence,
    };
  }
  if (outcome.status === "duplicate") return { status: "duplicate" };

  // 5. VALIDATE, STRICTLY.
  const interpreted = interpretQuoteDraftResponse(outcome.value.text, prompt);
  if (!interpreted.ok) {
    console.error("[ai/quote-writer] model output REFUSED", {
      code: interpreted.code,
      issues: interpreted.issues.slice(0, 5),
    });
    return { status: "rejected", code: interpreted.code, issues: interpreted.issues };
  }

  // 6. STORE.
  const draftId = await storeDraft({
    supabase: await createClient(),
    ctx,
    userId: user.id,
    input,
    interpreted: interpreted.result,
    prompt,
    fields,
    provider: outcome.value.provider,
    model: outcome.value.model,
    fingerprint,
  });
  if (!draftId) {
    return { status: "failed", error: "the draft could not be saved" };
  }

  return {
    status: "created",
    draftId,
    draft: interpreted.result.draft,
    degraded: interpreted.result.degraded,
    warnings: interpreted.result.warnings,
    lineItems: toQuoteLineItems(interpreted.result.draft),
  };
}

type ModelLeg = { text: string; provider: string; model: string };

/**
 * The provider leg, isolated so the governor can time it and account for it.
 * Returns `usage` describing what was actually billed — provider truth, never
 * an estimate. Throws on any failure; the caller owns what happens next.
 */
async function callModel(
  model: QuoteWriterModel,
  prompt: AssembledQuotePrompt,
): Promise<GovernedCall<ModelLeg>> {
  const result = await model.complete({ system: prompt.system, user: prompt.user });
  return {
    value: { text: result.text, provider: model.info.provider, model: result.model },
    usage: {
      provider: model.info.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    },
  };
}

async function storeDraft(args: {
  supabase: unknown;
  ctx: OrgContext;
  userId: string;
  input: QuoteContextInput;
  interpreted: InterpretedQuoteDraft;
  prompt: AssembledQuotePrompt;
  fields: ReadonlyArray<QuoteContextFieldKey>;
  provider: string;
  model: string;
  fingerprint: string;
}): Promise<string | null> {
  const { data, error } = await table(args.supabase, DRAFTS)
    .insert({
      org_id: args.ctx.org.id,
      created_by: args.userId,
      quote_id: args.input.quoteId ?? null,
      lead_id: args.input.leadId ?? null,
      status: "draft",
      // What the MODEL said. Frozen from here on by the lifecycle trigger.
      content: {
        ...args.interpreted.draft,
        // CrewFlow's merged warnings, so the stored artifact matches what the
        // operator was actually shown.
        warnings: args.interpreted.warnings,
      },
      provenance: args.provider,
      model: args.model,
      prompt_version: args.prompt.version,
      prompt_checksum: args.prompt.checksum,
      schema_version: QUOTE_DRAFT_SCHEMA_VERSION,
      degraded: args.interpreted.degraded,
      // KEYS, never values. See lib/ai/quote-context.ts.
      context_fields: [...args.fields],
      invocation_hash: args.fingerprint,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[ai/quote-writer] draft insert failed", error);
    return null;
  }
  return String(data.id);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Apply / discard — and note what apply does NOT do.
// ═══════════════════════════════════════════════════════════════════════════

export type ApplyQuoteDraftResult =
  | { ok: true; lineItems: LineItem[] }
  | { ok: false; error: "not_found" | "not_open" | "invalid_edit" | "write_failed" };

/**
 * Record that the operator accepted this draft, as edited, and hand back the
 * line items for the ordinary quote builder.
 *
 * WHAT THIS FUNCTION DOES NOT DO, and could not be made to do without a diff a
 * reviewer would see: create a quote, update a quote, allocate a quote number,
 * mint a public token, request approval, or send anything. It writes ONE row in
 * ONE table and returns an array. The operator then presses Save in the builder
 * they already use, and every existing control — validation, the approval gate,
 * the send gate, the accepted-quote freeze — applies unchanged, because nothing
 * about this path is special to it.
 *
 * `edited` is what the HUMAN ended up with. It is re-validated through the same
 * strict schema: an operator's browser is not a trusted source either, and a
 * draft that fails validation here is a bug worth seeing rather than a payload
 * worth storing.
 */
export async function applyQuoteDraft(
  draftId: string,
  edited: unknown,
): Promise<ApplyQuoteDraftResult> {
  const { ctx, user } = await requireOrgContext();
  const supabase = await createClient();

  const parsed = parseQuoteDraft(edited);
  if (!parsed.ok) {
    console.error("[ai/quote-writer] edited draft refused", parsed.issues.slice(0, 5));
    return { ok: false, error: "invalid_edit" };
  }

  // Prove the draft is in the ACTIVE org before writing. A foreign draft reads
  // as absent, and the update's own predicate makes it a no-op regardless.
  const { data: existing, error: readErr } = await table(supabase, DRAFTS)
    .select("id, status")
    .eq("id", draftId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (readErr) throw readFailure("ai quote writer: draft gate", readErr);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.status !== "draft") return { ok: false, error: "not_open" };

  const { data, error } = await table(supabase, DRAFTS)
    .update({
      status: "applied",
      applied_content: parsed.draft,
      applied_at: new Date().toISOString(),
      applied_by: user.id,
    })
    .eq("id", draftId)
    .eq("org_id", ctx.org.id)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    console.error("[ai/quote-writer] apply failed", error);
    return { ok: false, error: "write_failed" };
  }

  return { ok: true, lineItems: toQuoteLineItems(parsed.draft) };
}

/**
 * The operator threw the suggestion away.
 *
 * A STATUS, NOT A DELETE. "AI proposed this and a human rejected it" is the
 * most informative thing this table can record about whether the feature earns
 * its cost, and deleting the row would destroy exactly the evidence that the
 * review step is doing its job.
 */
export async function discardQuoteDraft(
  draftId: string,
): Promise<{ ok: true } | { ok: false; error: "not_found" | "not_open" | "write_failed" }> {
  const { ctx, user } = await requireOrgContext();
  const supabase = await createClient();

  const { data: existing, error: readErr } = await table(supabase, DRAFTS)
    .select("id, status")
    .eq("id", draftId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (readErr) throw readFailure("ai quote writer: discard gate", readErr);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.status !== "draft") return { ok: false, error: "not_open" };

  const { data, error } = await table(supabase, DRAFTS)
    .update({
      status: "discarded",
      discarded_at: new Date().toISOString(),
      discarded_by: user.id,
    })
    .eq("id", draftId)
    .eq("org_id", ctx.org.id)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    console.error("[ai/quote-writer] discard failed", error);
    return { ok: false, error: "write_failed" };
  }
  return { ok: true };
}

/** The most recent OPEN draft for a quote or lead, for the review surface. */
export async function latestOpenQuoteDraft(
  anchor: { quoteId?: string | null; leadId?: string | null },
): Promise<{ id: string; content: unknown; degraded: boolean } | null> {
  if (!anchor.quoteId && !anchor.leadId) return null;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  let query = table(supabase, DRAFTS)
    .select("id, content, degraded, created_at")
    .eq("org_id", ctx.org.id)
    .eq("status", "draft");
  query = anchor.quoteId
    ? query.eq("quote_id", anchor.quoteId)
    : query.eq("lead_id", anchor.leadId);

  const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw readFailure("ai quote writer: latest draft", error);
  if (!data) return null;
  return {
    id: String(data.id),
    content: data.content,
    degraded: data.degraded === true,
  };
}
