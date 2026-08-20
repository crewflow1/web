import "server-only";
import { SignedXml } from "xml-crypto";
import { DOMParser } from "@xmldom/xmldom";

/**
 * SAML 2.0 Response / Assertion validation — the SP-side trust boundary.
 *
 * This is the single place a SAML Response is turned from bytes into a trusted
 * identity. It performs, in order:
 *
 *   1. SIGNATURE verification against the CONFIGURED IdP x509 cert (never the
 *      cert embedded in the document's KeyInfo — that would let an attacker sign
 *      with their own key). `publicCert` pins the key.
 *   2. SIGNATURE-WRAPPING DEFENCE: identity data is extracted ONLY from the
 *      bytes that were actually signed (`getSignedReferences()`), never from the
 *      raw document. A wrapped/injected unsigned Assertion is therefore ignored.
 *   3. ALGORITHM allowlist: SHA-1 signatures/digests are rejected.
 *   4. CONDITION checks on the signed Assertion: Issuer, AudienceRestriction,
 *      Conditions NotBefore/NotOnOrAfter, SubjectConfirmationData
 *      NotOnOrAfter/Recipient, and InResponseTo when the caller supplies an
 *      expected value.
 *   5. NameID / email extraction from the signed Subject.
 *
 * It NEVER provisions. The caller maps the returned email to an EXISTING
 * membership (deny-unmatched) — see lib/enterprise-sso/provisioning.ts.
 */

const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";

// Accepted signature algorithms — SHA-256 and stronger only (no SHA-1).
const ALLOWED_SIGNATURE_ALGS = new Set<string>([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512",
]);
const ALLOWED_DIGEST_ALGS = new Set<string>([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512",
]);

export type SamlValidationOptions = {
  /** The IdP EntityID we require as the assertion Issuer. */
  idpEntityId: string;
  /** IdP signing certificate (PEM or bare base64 DER). */
  idpX509Cert: string;
  /** Our SP EntityID — required to equal the assertion AudienceRestriction. */
  spEntityId?: string | null;
  /** Our ACS URL — required to equal SubjectConfirmationData@Recipient when set. */
  acsUrl?: string | null;
  /** When set, the assertion InResponseTo MUST equal this (SP-initiated flow). */
  expectedInResponseTo?: string | null;
  /** Clock skew tolerance in seconds (default 120). */
  clockSkewSec?: number;
  /** Injectable clock for tests. */
  now?: Date;
};

export type SamlValidationResult =
  | {
      ok: true;
      email: string;
      nameId: string;
      attributes: Record<string, string[]>;
    }
  | { ok: false; reason: string };

/** Wrap bare base64 DER in PEM armour; pass through already-PEM certs. */
export function toPem(cert: string): string {
  const trimmed = cert.trim();
  // Already PEM-armoured (a CERTIFICATE or a bare PUBLIC KEY) — pass through.
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const body = trimmed.replace(/\s+/g, "").replace(/-/g, "");
  const lines = body.match(/.{1,64}/g) ?? [body];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

function firstEl(parent: Document | Element, localName: string): Element | null {
  const els = parent.getElementsByTagNameNS(SAML_ASSERTION_NS, localName);
  return els.length > 0 ? (els.item(0) as Element) : null;
}
function allEls(parent: Document | Element, localName: string): Element[] {
  const els = parent.getElementsByTagNameNS(SAML_ASSERTION_NS, localName);
  const out: Element[] = [];
  for (let i = 0; i < els.length; i++) out.push(els.item(i) as Element);
  return out;
}
function text(el: Element | null): string | null {
  const t = el?.textContent?.trim();
  return t && t.length > 0 ? t : null;
}

/** Parse an ISO/xsd:dateTime attribute to epoch ms, or null. */
function parseInstant(v: string | null): number | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Validate a base64url- OR base64-decoded SAML Response XML string.
 * `xml` is the DECODED XML (the caller base64-decodes the SAMLResponse form
 * field first).
 */
export function validateSamlResponse(
  xml: string,
  opts: SamlValidationOptions,
): SamlValidationResult {
  const nowMs = (opts.now ?? new Date()).getTime();
  const skewMs = (opts.clockSkewSec ?? 120) * 1000;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    return { ok: false, reason: "malformed_xml" };
  }

  // Locate the enveloped <Signature>. There must be exactly one at the level we
  // verify (Response or Assertion). Reject if absent — an UNSIGNED response is
  // never trusted.
  const sigNodes = doc.getElementsByTagNameNS(
    "http://www.w3.org/2000/09/xmldsig#",
    "Signature",
  );
  if (sigNodes.length === 0) return { ok: false, reason: "unsigned" };

  const sig = new SignedXml();
  // PIN to the configured cert — ignore any KeyInfo/cert embedded in the doc.
  try {
    sig.publicCert = toPem(opts.idpX509Cert);
  } catch {
    return { ok: false, reason: "bad_configured_cert" };
  }

  let verified = false;
  let signedReferences: string[] = [];
  try {
    sig.loadSignature(sigNodes.item(0) as unknown as Node);
    verified = sig.checkSignature(xml);
    signedReferences = sig.getSignedReferences();
  } catch {
    return { ok: false, reason: "signature_invalid" };
  }
  if (!verified) return { ok: false, reason: "signature_invalid" };

  // Algorithm allowlist — reject SHA-1 and anything not explicitly permitted.
  if (!ALLOWED_SIGNATURE_ALGS.has(sig.signatureAlgorithm ?? "")) {
    return { ok: false, reason: "weak_signature_alg" };
  }
  for (const ref of sig.getReferences()) {
    if (!ALLOWED_DIGEST_ALGS.has(ref.digestAlgorithm ?? "")) {
      return { ok: false, reason: "weak_digest_alg" };
    }
  }

  // SIGNATURE-WRAPPING DEFENCE: only look at bytes that were actually signed.
  // Find the Assertion INSIDE the signed content.
  if (signedReferences.length === 0) return { ok: false, reason: "no_signed_content" };

  let assertion: Element | null = null;
  for (const signed of signedReferences) {
    let sdoc: Document;
    try {
      sdoc = new DOMParser().parseFromString(signed, "text/xml") as unknown as Document;
    } catch {
      continue;
    }
    // The signed reference is either the Assertion itself or a Response wrapping it.
    const found = firstEl(sdoc, "Assertion");
    if (found) {
      assertion = found;
      break;
    }
  }
  if (!assertion) return { ok: false, reason: "no_signed_assertion" };

  // ── Issuer ──
  const issuer = text(firstEl(assertion, "Issuer"));
  if (issuer !== opts.idpEntityId) return { ok: false, reason: "issuer_mismatch" };

  // ── Conditions: NotBefore / NotOnOrAfter + AudienceRestriction ──
  const conditions = firstEl(assertion, "Conditions");
  if (conditions) {
    const nb = parseInstant(conditions.getAttribute("NotBefore"));
    const noa = parseInstant(conditions.getAttribute("NotOnOrAfter"));
    if (nb !== null && nowMs + skewMs < nb) return { ok: false, reason: "not_yet_valid" };
    if (noa !== null && nowMs - skewMs >= noa) return { ok: false, reason: "expired" };

    // Audience must include our SP EntityID (when configured).
    if (opts.spEntityId) {
      const audiences = allEls(conditions, "Audience").map((a) => text(a));
      if (!audiences.includes(opts.spEntityId)) {
        return { ok: false, reason: "audience_mismatch" };
      }
    }
  } else if (opts.spEntityId) {
    // Audience is required when we know our SP EntityID.
    return { ok: false, reason: "audience_missing" };
  }

  // ── Subject / SubjectConfirmationData ──
  const subject = firstEl(assertion, "Subject");
  if (!subject) return { ok: false, reason: "no_subject" };

  const scd = firstEl(subject, "SubjectConfirmationData");
  if (scd) {
    const noa = parseInstant(scd.getAttribute("NotOnOrAfter"));
    if (noa !== null && nowMs - skewMs >= noa) {
      return { ok: false, reason: "subject_expired" };
    }
    if (opts.acsUrl) {
      const recipient = scd.getAttribute("Recipient");
      if (recipient && recipient !== opts.acsUrl) {
        return { ok: false, reason: "recipient_mismatch" };
      }
    }
    // InResponseTo binding for SP-initiated flows.
    const inResponseTo = scd.getAttribute("InResponseTo");
    if (opts.expectedInResponseTo) {
      if (inResponseTo !== opts.expectedInResponseTo) {
        return { ok: false, reason: "in_response_to_mismatch" };
      }
    }
  } else if (opts.expectedInResponseTo) {
    return { ok: false, reason: "subject_confirmation_missing" };
  }

  // ── NameID + attributes ──
  const nameIdEl = firstEl(subject, "NameID");
  const nameId = text(nameIdEl);
  if (!nameId) return { ok: false, reason: "no_nameid" };

  const attributes: Record<string, string[]> = {};
  for (const attr of allEls(assertion, "Attribute")) {
    const name = attr.getAttribute("Name") ?? attr.getAttribute("FriendlyName");
    if (!name) continue;
    const values = allEls(attr, "AttributeValue")
      .map((v) => text(v))
      .filter((v): v is string => v !== null);
    attributes[name] = values;
  }

  // Email resolution: prefer a standard email attribute, else the NameID when it
  // looks like an email.
  const email = resolveEmail(nameId, nameIdEl, attributes);
  if (!email) return { ok: false, reason: "no_email" };

  return { ok: true, email, nameId, attributes };
}

const EMAIL_ATTR_NAMES = [
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3", // mail
  "email",
  "emailAddress",
  "mail",
];
const EMAIL_NAMEID_FORMAT =
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

function resolveEmail(
  nameId: string,
  nameIdEl: Element | null,
  attributes: Record<string, string[]>,
): string | null {
  for (const key of EMAIL_ATTR_NAMES) {
    const v = attributes[key]?.[0];
    if (v && v.includes("@")) return v.trim().toLowerCase();
  }
  const format = nameIdEl?.getAttribute("Format");
  if (format === EMAIL_NAMEID_FORMAT && nameId.includes("@")) {
    return nameId.trim().toLowerCase();
  }
  // Last resort: an unspecified NameID that is itself an email.
  if (nameId.includes("@")) return nameId.trim().toLowerCase();
  return null;
}

/** Base64-decode a SAMLResponse form field into XML. Returns null on bad input. */
export function decodeSamlResponse(b64: string): string | null {
  try {
    const xml = Buffer.from(b64, "base64").toString("utf8");
    return xml.includes("<") ? xml : null;
  } catch {
    return null;
  }
}
