// Heuristic scoring for benchmark outputs.
// Deliberately NOT an LLM judge: every score here is deterministic and
// reproducible, so the harness runs with zero external dependencies and the
// numbers can be re-derived. The rubric is a coverage + format + hygiene proxy
// for quality, not a substitute for human review (see REPORT.md methodology).

/** Count words in a string. */
function wordCount(s) {
  return (s.trim().match(/\S+/g) || []).length;
}

/**
 * Score a free-text output against a rubric.
 * Returns { quality: 0..1, parts, fallbackWorthy }.
 *
 * Components (weighted):
 *  - coverage:   fraction of mustInclude terms present (case-insensitive)      0.55
 *  - hygiene:    no mustNotInclude terms present (refusals/hallucination tells) 0.25
 *  - length:     within [minWords, maxWords]                                    0.20
 */
export function scoreText(output, rubric) {
  const text = (output || "").toLowerCase();
  const must = rubric.mustInclude || [];
  const mustNot = rubric.mustNotInclude || [];

  const hits = must.filter((t) => text.includes(t.toLowerCase()));
  const coverage = must.length ? hits.length / must.length : 1;

  const violations = mustNot.filter((t) => text.includes(t.toLowerCase()));
  const hygiene = mustNot.length ? (violations.length === 0 ? 1 : 0) : 1;

  const wc = wordCount(output || "");
  let lengthScore = 1;
  if (rubric.minWords && wc < rubric.minWords) {
    lengthScore = Math.max(0, wc / rubric.minWords);
  } else if (rubric.maxWords && wc > rubric.maxWords) {
    // mild penalty for overrun, capped
    lengthScore = Math.max(0.4, 1 - (wc - rubric.maxWords) / rubric.maxWords);
  }

  const quality = 0.55 * coverage + 0.25 * hygiene + 0.2 * lengthScore;

  // A response is "fallback-worthy" (should have escalated to hosted) if it
  // refused, hallucinated a forbidden tell, is empty, or missed most key facts.
  const fallbackWorthy =
    wc === 0 || violations.length > 0 || coverage < 0.5 || hygiene === 0;

  return {
    quality: Number(quality.toFixed(3)),
    parts: {
      coverage: Number(coverage.toFixed(3)),
      hygiene,
      lengthScore: Number(lengthScore.toFixed(3)),
      words: wc,
      missedTerms: must.filter((t) => !text.includes(t.toLowerCase())),
      violations,
    },
    fallbackWorthy,
  };
}

/** Strip markdown fences / leading prose and pull the first JSON object. */
export function extractJson(raw) {
  if (!raw) return null;
  let s = raw.trim();
  // remove ```json ... ``` fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // find first balanced-looking object
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  const candidate = s.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Minimal JSON-Schema validator (draft-07 subset sufficient for our schema):
 * handles type, required, enum, pattern, minimum, minLength, minItems,
 * additionalProperties:false, and nested object/array.
 */
export function validateSchema(data, schema, path = "$") {
  const errors = [];
  const t = schema.type;
  const typeof_ = (v) =>
    Array.isArray(v) ? "array" : v === null ? "null" : typeof v;

  if (t) {
    const actual = typeof_(data);
    const want = t === "integer" ? "number" : t;
    if (actual !== want) {
      errors.push(`${path}: expected ${t}, got ${actual}`);
      return errors; // can't descend further
    }
  }
  if (t === "number" || t === "integer") {
    if (schema.minimum !== undefined && data < schema.minimum)
      errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
  }
  if (t === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength)
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data))
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    if (schema.enum && !schema.enum.includes(data))
      errors.push(`${path}: "${data}" not in enum`);
  }
  if (schema.enum && t !== "string" && !schema.enum.includes(data))
    errors.push(`${path}: value not in enum`);
  if (t === "object") {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (!(req in data)) errors.push(`${path}.${req}: required but missing`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(data)) {
        if (!(k in props)) errors.push(`${path}.${k}: additional property not allowed`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in data) errors.push(...validateSchema(data[k], sub, `${path}.${k}`));
    }
  }
  if (t === "array") {
    if (schema.minItems !== undefined && data.length < schema.minItems)
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (schema.items) {
      data.forEach((el, i) =>
        errors.push(...validateSchema(el, schema.items, `${path}[${i}]`))
      );
    }
  }
  return errors;
}

/** Numeric closeness: 1 if within 1% or 0.01 absolute, else 0. */
function numClose(a, b) {
  if (typeof a !== "number" || typeof b !== "number") return a === b ? 1 : 0;
  const diff = Math.abs(a - b);
  return diff <= Math.max(0.01, Math.abs(b) * 0.01) ? 1 : 0;
}

/**
 * Score a structured (JSON) output: parse + schema validity + field accuracy
 * against the gold `expected` (scalar fields only; line_items not graded for
 * exactness, only via schema).
 */
export function scoreJson(raw, schema, expected) {
  const parsed = extractJson(raw);
  if (!parsed) {
    return {
      quality: 0,
      parsed: false,
      schemaValid: false,
      schemaErrors: ["could not parse any JSON object from output"],
      fieldAccuracy: 0,
      fallbackWorthy: true,
    };
  }
  const schemaErrors = validateSchema(parsed, schema);
  const schemaValid = schemaErrors.length === 0;

  // field accuracy over the scalar gold fields
  const fields = Object.keys(expected);
  let correct = 0;
  const fieldResults = {};
  for (const f of fields) {
    let ok;
    if (typeof expected[f] === "number") ok = numClose(parsed[f], expected[f]);
    else
      ok =
        String(parsed[f] ?? "").trim().toLowerCase() ===
        String(expected[f]).trim().toLowerCase()
          ? 1
          : 0;
    // supplier_name: allow substring match (minor punctuation/suffix drift)
    if (!ok && f === "supplier_name" && parsed[f]) {
      const p = String(parsed[f]).toLowerCase();
      const e = String(expected[f]).toLowerCase();
      if (p.includes(e) || e.includes(p)) ok = 1;
    }
    fieldResults[f] = ok === 1;
    correct += ok;
  }
  const fieldAccuracy = fields.length ? correct / fields.length : 1;

  // quality = 0.5 schema-valid + 0.5 field accuracy
  const quality = 0.5 * (schemaValid ? 1 : 0) + 0.5 * fieldAccuracy;

  return {
    quality: Number(quality.toFixed(3)),
    parsed: true,
    schemaValid,
    schemaErrors,
    fieldAccuracy: Number(fieldAccuracy.toFixed(3)),
    fieldResults,
    fallbackWorthy: !schemaValid || fieldAccuracy < 0.7,
  };
}

// ---------------- Embedding retrieval metrics ----------------

export function cosine(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Given query vectors, corpus vectors, and gold relevance, compute
 * precision@k, recall@k, MRR, and mean rank of the first relevant doc.
 */
export function retrievalMetrics({ queries, queryVecs, corpusIds, corpusVecs, k = 3 }) {
  let sumP = 0,
    sumR = 0,
    sumRR = 0,
    sumFirstRank = 0;
  const perQuery = [];
  for (let qi = 0; qi < queries.length; qi++) {
    const qv = queryVecs[qi];
    const scored = corpusIds
      .map((id, ci) => ({ id, score: cosine(qv, corpusVecs[ci]) }))
      .sort((a, b) => b.score - a.score);
    const relevant = new Set(queries[qi].relevant);
    const topK = scored.slice(0, k).map((s) => s.id);
    const hitsInK = topK.filter((id) => relevant.has(id)).length;
    const precision = hitsInK / k;
    const recall = relevant.size ? hitsInK / relevant.size : 0;
    const firstRank = scored.findIndex((s) => relevant.has(s.id)) + 1; // 1-based
    const rr = firstRank > 0 ? 1 / firstRank : 0;
    sumP += precision;
    sumR += recall;
    sumRR += rr;
    sumFirstRank += firstRank > 0 ? firstRank : corpusIds.length;
    perQuery.push({
      id: queries[qi].id,
      precisionAtK: Number(precision.toFixed(3)),
      recallAtK: Number(recall.toFixed(3)),
      firstRelevantRank: firstRank,
      topK,
    });
  }
  const n = queries.length;
  return {
    k,
    precisionAtK: Number((sumP / n).toFixed(3)),
    recallAtK: Number((sumR / n).toFixed(3)),
    mrr: Number((sumRR / n).toFixed(3)),
    meanFirstRelevantRank: Number((sumFirstRank / n).toFixed(2)),
    perQuery,
  };
}
