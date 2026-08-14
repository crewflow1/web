/**
 * cXML OrderRequest builder + ack parser — the pure, knowable PO-submission wire
 * format.
 *
 * There is no single proprietary REST API published by the named merchants, but
 * cXML (the Ariba/Coupa open e-procurement standard, and the OCI cousin) IS the
 * genuinely knowable, documented format UK builders' merchants accept for
 * electronic purchase orders. So THIS is the real, testable half of the
 * PO-submission flow: it turns a provider-agnostic {@link PurchaseOrderPayload}
 * into a cXML `OrderRequest` document, and reads the merchant's `Response`
 * status back. The adapter's only job is to POST the bytes (guarded) — the
 * document lives here, once, unit-tested (as the banking mapper does).
 *
 * Pure by design: no `server-only`, no network, no env. Deterministic given its
 * inputs plus an explicit `payloadId`/`timestamp` (the caller supplies these so
 * the output is reproducible in tests — never `Date.now()` inside).
 *
 * SECURITY: every value that lands in the XML is XML-escaped, so a description,
 * reference or address line cannot inject markup / break out of an element. The
 * shared-secret credential goes in the `<Credential>` `SharedSecret`, never in a
 * log line — the adapter passes it in and never prints the returned document.
 */

import type { PurchaseOrderPayload } from "./types";

/** XML-escape a text value for safe insertion between/inside elements + attrs. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type CxmlOrderContext = {
  /** The buyer identity domain/id the merchant issued (e.g. "DUNS" / account). */
  fromDomain: string;
  fromIdentity: string;
  /** The merchant (supplier) identity domain/id. */
  toDomain: string;
  toIdentity: string;
  /** The sender identity + shared secret (the credential — never logged). */
  senderIdentity: string;
  sharedSecret: string;
  /** Deterministic ids the CALLER supplies (so the document is reproducible). */
  payloadId: string;
  timestamp: string;
};

/**
 * Build a cXML `OrderRequest` document for a purchase order. Pure + deterministic.
 * Throws when the payload has no lines — an empty order is never submittable.
 */
export function buildOrderRequestCxml(
  po: PurchaseOrderPayload,
  ctx: CxmlOrderContext,
): string {
  if (po.lines.length === 0) {
    throw new Error("cannot build an OrderRequest for a purchase order with no lines");
  }

  const total = po.lines.reduce(
    (sum, l) => sum + (l.unitPricePence ?? 0) * l.quantity,
    0,
  );
  const money = (pence: number) => (pence / 100).toFixed(2);

  const shipTo =
    po.deliveryLines.length > 0
      ? `        <ShipTo>
          <Address addressID="ship">
            <Name xml:lang="en">${xmlEscape(po.reference)}</Name>
            <PostalAddress>
${po.deliveryLines
  .map((line) => `              <Street>${xmlEscape(line)}</Street>`)
  .join("\n")}
            </PostalAddress>
          </Address>
        </ShipTo>\n`
      : "";

  const items = po.lines
    .map((line, i) => {
      const lineNo = i + 1;
      const price = line.unitPricePence ?? 0;
      return `      <ItemOut quantity="${xmlEscape(String(line.quantity))}" lineNumber="${lineNo}">
        <ItemID>
          <SupplierPartID>${xmlEscape(line.sku)}</SupplierPartID>
        </ItemID>
        <ItemDetail>
          <UnitPrice>
            <Money currency="${xmlEscape(po.currency)}">${money(price)}</Money>
          </UnitPrice>
          <Description xml:lang="en">${xmlEscape(line.description)}</Description>
          <UnitOfMeasure>${xmlEscape(line.unit ?? "EA")}</UnitOfMeasure>
        </ItemDetail>
      </ItemOut>`;
    })
    .join("\n");

  const orderDate = po.requestedDeliveryDate
    ? ` requestedDeliveryDate="${xmlEscape(po.requestedDeliveryDate)}"`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<cXML payloadID="${xmlEscape(ctx.payloadId)}" timestamp="${xmlEscape(ctx.timestamp)}">
  <Header>
    <From><Credential domain="${xmlEscape(ctx.fromDomain)}"><Identity>${xmlEscape(ctx.fromIdentity)}</Identity></Credential></From>
    <To><Credential domain="${xmlEscape(ctx.toDomain)}"><Identity>${xmlEscape(ctx.toIdentity)}</Identity></Credential></To>
    <Sender>
      <Credential domain="NetworkID"><Identity>${xmlEscape(ctx.senderIdentity)}</Identity><SharedSecret>${xmlEscape(ctx.sharedSecret)}</SharedSecret></Credential>
      <UserAgent>CrewFlow</UserAgent>
    </Sender>
  </Header>
  <Request>
    <OrderRequest>
      <OrderRequestHeader orderID="${xmlEscape(po.reference)}" orderDate="${xmlEscape(ctx.timestamp)}" type="new"${orderDate}>
        <Total><Money currency="${xmlEscape(po.currency)}">${money(total)}</Money></Total>
${shipTo}        <Extrinsic name="AccountNumber">${xmlEscape(po.accountHandle)}</Extrinsic>
        <Extrinsic name="CrewFlowOrderId">${xmlEscape(po.purchaseOrderId)}</Extrinsic>
      </OrderRequestHeader>
${items}
    </OrderRequest>
  </Request>
</cXML>`;
}

export type CxmlAck =
  | { ok: true; statusCode: number; text: string }
  | { ok: false; statusCode: number; text: string };

/**
 * Parse a cXML `Response` document's `<Status code=.. text=..>`. cXML signals
 * application-level success as `code="200"` INSIDE a 200 HTTP response, so the
 * transport status alone is not enough — this reads the embedded status. Returns
 * a structured ack; a document without a Status is treated as a failure (a
 * merchant that accepted the order always returns one).
 */
export function parseOrderResponseCxml(xml: string): CxmlAck {
  const tag = /<Status\b[^>]*>/i.exec(xml);
  if (!tag) {
    return { ok: false, statusCode: 0, text: "no Status element in cXML response" };
  }
  const codeM = /\bcode="(\d+)"/i.exec(tag[0]);
  if (!codeM) {
    return { ok: false, statusCode: 0, text: "cXML Status element carries no code" };
  }
  const statusCode = Number(codeM[1]);
  const textM = /\btext="([^"]*)"/i.exec(tag[0]);
  const text = textM ? textM[1]! : "";
  return statusCode >= 200 && statusCode < 300
    ? { ok: true, statusCode, text }
    : { ok: false, statusCode, text };
}
