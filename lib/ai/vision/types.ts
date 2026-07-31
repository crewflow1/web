/**
 * Shared vision door — the contract.
 *
 * A deliberate mirror of ../text/types.ts, because the two doors exist for the
 * same reason and must be reasoned about the same way: the caller describes the
 * WORK, the factory decides the VENDOR, and the governor decides whether the
 * call may happen at all. Nothing here imports an SDK or reads an environment
 * variable, so this file is safe to import from anywhere.
 */

/** Which vendor+model actually ran. Matches `TextModelInfo` field-for-field. */
export type VisionModelInfo = {
  /** Vendor id, lowercase. */
  provider: string;
  /** Model id as the vendor names it. */
  model: string;
};

/**
 * ONE document handed to a vision model, already base64-encoded.
 *
 * `kind` is explicit rather than sniffed from `mediaType`, because the two
 * vendors' request shapes differ by document CLASS (a PDF is a `document` block,
 * an image is an `image` block) and guessing that from a MIME string is how the
 * two former OCR paths each grew their own `mimeType === "application/pdf"`
 * branch. The caller already knows which it has.
 */
export type VisionDocument = {
  kind: "pdf" | "image";
  /** e.g. `application/pdf`, `image/jpeg`. */
  mediaType: string;
  /** The document's bytes, base64. Never logged, never stored by this layer. */
  base64: string;
};

/** What one extraction asks for. Every field is a COST or SAFETY bound. */
export type VisionExtractOptions = {
  /** The fixed framing. No document content may reach it. */
  system: string;
  /** The instruction that accompanies the document. */
  instruction: string;
  /** Output cap. Required — an uncapped vision call has no cost bound. */
  maxTokens: number;
  /** Caller-supplied abort/timeout. */
  signal?: AbortSignal;
};

/** The vendor's answer plus the counts it says it billed. */
export type VisionResult = {
  /** Every text block, concatenated and trimmed. */
  text: string;
  /** The model the vendor reports, which may differ from the one asked for. */
  model: string;
  /** Billed prompt tokens — provider truth, never an estimate. */
  inputTokens: number;
  /** Billed completion tokens — provider truth. */
  outputTokens: number;
};

/**
 * A vision provider. `extract` THROWS on any vendor failure: the caller (and
 * therefore the governor wrapping it) owns the degraded path, exactly as
 * `TextProvider.generate` does.
 */
export type VisionProvider = {
  info: VisionModelInfo;
  extract(doc: VisionDocument, opts: VisionExtractOptions): Promise<VisionResult>;
};
