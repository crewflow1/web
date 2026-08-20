import { describe, it, expect, beforeAll } from "vitest";
import { SignedXml } from "xml-crypto";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { validateSamlResponse, decodeSamlResponse, toPem } from "@/lib/enterprise-sso/saml";

/**
 * SAML assertion validation — the SP trust boundary.
 *
 * These sign REAL SAML Responses with a throwaway RSA key and prove the
 * validator: accepts a genuine signed assertion, and rejects a TAMPERED one, a
 * WRONG-key signature, an UNSIGNED response, and every failed condition
 * (issuer / audience / expiry / recipient). Plus the signature-wrapping defence.
 */

const IDP_ENTITY_ID = "https://idp.example.com";
const SP_ENTITY_ID = "https://app.example.com/sp";
const ACS_URL = "https://app.example.com/api/sso/saml/ORG/acs";
const NOW = new Date("2026-06-01T00:00:00Z");

let privPem: string;
let pubPem: string;
let otherPubPem: string;

beforeAll(() => {
  const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privPem = (kp.privateKey as KeyObject).export({ type: "pkcs1", format: "pem" }) as string;
  pubPem = (kp.publicKey as KeyObject).export({ type: "spki", format: "pem" }) as string;
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  otherPubPem = (other.publicKey as KeyObject).export({ type: "spki", format: "pem" }) as string;
});

type AssertionOpts = {
  issuer?: string;
  audience?: string | null;
  nameId?: string;
  nameIdFormat?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  scdNotOnOrAfter?: string;
  recipient?: string | null;
  inResponseTo?: string | null;
  email?: string | null;
};

function buildResponseXml(o: AssertionOpts = {}): string {
  const issuer = o.issuer ?? IDP_ENTITY_ID;
  const audience = o.audience === undefined ? SP_ENTITY_ID : o.audience;
  const nameId = o.nameId ?? "user@example.com";
  const nameIdFormat = o.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
  const notBefore = o.notBefore ?? "2020-01-01T00:00:00Z";
  const notOnOrAfter = o.notOnOrAfter ?? "2099-01-01T00:00:00Z";
  const scdNoa = o.scdNotOnOrAfter ?? "2099-01-01T00:00:00Z";
  const recipient = o.recipient === undefined ? ACS_URL : o.recipient;
  const inResponseTo = o.inResponseTo ?? null;
  const email = o.email === undefined ? "user@example.com" : o.email;

  const audienceEl = audience
    ? `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    : `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"/>`;
  const scdAttrs = [
    `NotOnOrAfter="${scdNoa}"`,
    recipient ? `Recipient="${recipient}"` : "",
    inResponseTo ? `InResponseTo="${inResponseTo}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const emailAttr = email
    ? `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
    : "";

  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp1" Version="2.0" IssueInstant="2026-06-01T00:00:00Z"><saml:Assertion ID="_assert1" Version="2.0" IssueInstant="2026-06-01T00:00:00Z"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="${nameIdFormat}">${nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData ${scdAttrs}/></saml:SubjectConfirmation></saml:Subject>${audienceEl}${emailAttr}</saml:Assertion></samlp:Response>`;
}

function sign(xml: string): string {
  const sig = new SignedXml({ privateKey: privPem });
  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
  });
  sig.computeSignature(xml, {
    location: {
      reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
      action: "after",
    },
  });
  return sig.getSignedXml();
}

const opts = () => ({
  idpEntityId: IDP_ENTITY_ID,
  idpX509Cert: pubPem,
  spEntityId: SP_ENTITY_ID,
  acsUrl: ACS_URL,
  now: NOW,
});

describe("validateSamlResponse — happy path", () => {
  it("accepts a genuine signed assertion and extracts the email", () => {
    const res = validateSamlResponse(sign(buildResponseXml()), opts());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.email).toBe("user@example.com");
      expect(res.nameId).toBe("user@example.com");
    }
  });

  it("falls back to an email-format NameID when no email attribute is present", () => {
    const res = validateSamlResponse(sign(buildResponseXml({ email: null })), opts());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.email).toBe("user@example.com");
  });
});

describe("validateSamlResponse — signature rejections", () => {
  it("REJECTS a tampered assertion (email swapped after signing)", () => {
    const tampered = sign(buildResponseXml()).replace("user@example.com", "attacker@evil.com");
    const res = validateSamlResponse(tampered, opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("signature_invalid");
  });

  it("REJECTS a signature made with a different key (wrong configured cert)", () => {
    const res = validateSamlResponse(sign(buildResponseXml()), { ...opts(), idpX509Cert: otherPubPem });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("signature_invalid");
  });

  it("REJECTS an unsigned response", () => {
    const res = validateSamlResponse(buildResponseXml(), opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unsigned");
  });

  it("REJECTS a signature-wrapping attack: an unsigned assertion added alongside", () => {
    // Sign a legitimate assertion, then inject an EVIL unsigned assertion as a
    // sibling. Identity must come only from the SIGNED bytes, so the evil email
    // must be ignored (validator reads the real user, not the attacker).
    const signed = sign(buildResponseXml());
    const evil =
      '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_evil"><saml:Issuer>https://idp.example.com</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">attacker@evil.com</saml:NameID></saml:Subject></saml:Assertion>';
    const wrapped = signed.replace("</samlp:Response>", `${evil}</samlp:Response>`);
    const res = validateSamlResponse(wrapped, opts());
    // Either the signature no longer verifies over the mutated doc, or it does
    // and we still read ONLY the signed subject — never the attacker's.
    if (res.ok) {
      expect(res.email).toBe("user@example.com");
    } else {
      expect(res.email).toBeUndefined();
    }
  });
});

describe("validateSamlResponse — condition rejections", () => {
  it("REJECTS an issuer mismatch", () => {
    const res = validateSamlResponse(sign(buildResponseXml({ issuer: "https://evil.idp" })), opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("issuer_mismatch");
  });

  it("REJECTS an audience mismatch", () => {
    const res = validateSamlResponse(sign(buildResponseXml({ audience: "https://someone-else/sp" })), opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("audience_mismatch");
  });

  it("REJECTS an expired assertion (Conditions NotOnOrAfter passed)", () => {
    const res = validateSamlResponse(
      sign(buildResponseXml({ notOnOrAfter: "2021-01-01T00:00:00Z" })),
      opts(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
  });

  it("REJECTS a recipient mismatch", () => {
    const res = validateSamlResponse(
      sign(buildResponseXml({ recipient: "https://evil.example.com/acs" })),
      opts(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("recipient_mismatch");
  });

  it("REJECTS an InResponseTo mismatch when an expected value is supplied", () => {
    const res = validateSamlResponse(sign(buildResponseXml({ inResponseTo: "_wrong" })), {
      ...opts(),
      expectedInResponseTo: "_expected",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("in_response_to_mismatch");
  });
});

describe("helpers", () => {
  it("decodeSamlResponse base64-decodes XML", () => {
    const xml = "<x>hi</x>";
    expect(decodeSamlResponse(Buffer.from(xml).toString("base64"))).toBe(xml);
    expect(decodeSamlResponse("not-base64-xml***")).toBeNull();
  });

  it("toPem passes through a PEM public key and wraps bare base64", () => {
    expect(toPem(pubPem)).toContain("BEGIN");
    const wrapped = toPem("QUJDREVG");
    expect(wrapped).toContain("BEGIN CERTIFICATE");
    expect(wrapped).toContain("QUJDREVG");
  });
});
