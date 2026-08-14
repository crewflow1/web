import "server-only";
import { randomUUID } from "node:crypto";

import { isMerchantConnectable, resolveMerchantConfig } from "../connect";
import { assertPublicWebhookUrl, WebhookUrlError } from "@/lib/webhooks/ssrf";
import {
  buildOrderRequestCxml,
  parseOrderResponseCxml,
  type CxmlOrderContext,
} from "../cxml";
import { parsePriceFileCsv } from "../price-file";
import type {
  MerchantAdapter,
  MerchantCatalogueInput,
  MerchantCatalogueResult,
  MerchantOrderInput,
  MerchantOrderResult,
} from "./types";
import { catalogueUnavailable, orderUnavailable } from "./types";
import type { MerchantProvider } from "../types";

/** Bound how much of a price file we ingest on a single import (dark). */
const MAX_PRICE_FILE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * cXML/OCI merchant adapter — the concrete, standards-based transport. DARK.
 *
 * This adapter is a SEAM, not a live integration. It serves the merchants whose
 * electronic ordering runs over the cXML (Ariba/Coupa) e-procurement standard —
 * the national merchants (Travis Perkins, Jewson) whose parent groups operate
 * cXML/OCI B2B gateways for trade accounts. The wire format (a cXML OrderRequest;
 * a CSV price file) is genuinely knowable and is built + parsed by the PURE
 * helpers (../cxml, ../price-file), unit-tested independently. This class only
 * adds the guarded TRANSPORT around them.
 *
 * It reports itself unavailable whenever the merchant is not connectable (which
 * is ALWAYS today) and fetches NOTHING. There is deliberately NO SDK import and
 * NO client construction at module scope: a credential alone could not cause a
 * network call, and the endpoint is operator-supplied config (no default host
 * exists anywhere in the build). Every `fetch` lives strictly AFTER the
 * `isAvailable()` guard AND after the endpoint passes the shared SSRF guard, so
 * it is structurally unreachable dark.
 *
 * ── COMMERCIAL BOUNDARY ─────────────────────────────────────────────────────
 * Even wired, this must NEVER contact a merchant before a trade-account
 * integration contract exists — the endpoint is provisioned by the merchant per
 * contract, not a public host. Activation is a configuration + COMMERCIAL act,
 * not code.
 */
export class CxmlMerchantAdapter implements MerchantAdapter {
  constructor(readonly provider: MerchantProvider) {}

  isAvailable(): boolean {
    return isMerchantConnectable(this.provider);
  }

  async importCatalogue(
    input: MerchantCatalogueInput,
  ): Promise<MerchantCatalogueResult> {
    // DARK GUARD FIRST. With no credentials we return without touching the
    // network. Everything below is unreachable until connectable.
    if (!this.isAvailable()) {
      return catalogueUnavailable(
        this.provider,
        `${this.provider} is not connected. Configure the credentials + endpoint ` +
          `(per a trade-account contract) to enable price-file import.`,
      );
    }
    const config = resolveMerchantConfig(this.provider);
    if (!config || !config.priceFileUrl) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `${this.provider} has no price-file URL configured.`,
      };
    }

    // SSRF GUARD on the operator-supplied URL BEFORE any fetch.
    let url: URL;
    try {
      url = assertPublicWebhookUrl(config.priceFileUrl);
    } catch (e) {
      const reason = e instanceof WebhookUrlError ? e.reason : "invalid-url";
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `price-file URL rejected by SSRF policy: ${reason}`,
      };
    }

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────────
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          accept: "text/csv,application/octet-stream",
          "x-account": input.accountHandle,
        },
      });
    } catch (e) {
      return this.catalogueNetworkError(e);
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        provider: this.provider,
        reason: "unauthorized",
        message: `${this.provider} rejected the credential (${res.status}).`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `${this.provider} price-file fetch returned ${res.status}`,
      };
    }
    const csv = (await res.text()).slice(0, MAX_PRICE_FILE_BYTES);
    try {
      const parsed = parsePriceFileCsv(csv);
      return { ok: true, provider: this.provider, items: parsed.items };
    } catch (e) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `price-file parse failed: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }
  }

  async submitPurchaseOrder(
    input: MerchantOrderInput,
  ): Promise<MerchantOrderResult> {
    // DARK GUARD FIRST.
    if (!this.isAvailable()) {
      return orderUnavailable(
        this.provider,
        `${this.provider} is not connected. Configure the credentials + endpoint ` +
          `(per a trade-account contract) to enable order submission.`,
      );
    }
    const config = resolveMerchantConfig(this.provider);
    if (!config) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `${this.provider} credentials are not resolvable.`,
      };
    }

    // SSRF GUARD on the operator-supplied endpoint BEFORE any fetch.
    let endpoint: URL;
    try {
      endpoint = assertPublicWebhookUrl(config.endpoint);
    } catch (e) {
      const reason = e instanceof WebhookUrlError ? e.reason : "invalid-url";
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `merchant endpoint rejected by SSRF policy: ${reason}`,
      };
    }

    // Build the cXML document via the PURE builder (deterministic ids supplied).
    let body: string;
    try {
      const ctx: CxmlOrderContext = {
        fromDomain: "NetworkID",
        fromIdentity: input.order.accountHandle,
        toDomain: "NetworkID",
        toIdentity: this.provider,
        senderIdentity: "crewflow",
        // The per-org account secret (decrypted) takes precedence; else the
        // deployment API key. Never logged.
        sharedSecret: input.accountSecret ?? config.apiKey,
        payloadId: `${input.order.purchaseOrderId}@crewflow`,
        timestamp: new Date().toISOString(),
      };
      body = buildOrderRequestCxml(input.order, ctx);
    } catch (e) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `could not build order document: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────────
    let res: Response;
    try {
      res = await fetch(endpoint.toString(), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "content-type": "application/xml",
          accept: "application/xml",
          "idempotency-key": input.order.purchaseOrderId || randomUUID(),
        },
        body,
      });
    } catch (e) {
      return this.orderNetworkError(e);
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        provider: this.provider,
        reason: "unauthorized",
        message: `${this.provider} rejected the credential (${res.status}).`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `${this.provider} order endpoint returned ${res.status}`,
      };
    }
    // cXML signals application-level status INSIDE a 200 — parse the embedded ack.
    const ack = parseOrderResponseCxml(await res.text());
    if (!ack.ok) {
      return {
        ok: false,
        provider: this.provider,
        reason: "rejected",
        message: `${this.provider} declined the order: ${ack.statusCode} ${ack.text}`.trim(),
      };
    }
    return {
      ok: true,
      provider: this.provider,
      externalOrderRef: ack.text || null,
      message: `order accepted by ${this.provider}`,
    };
  }

  private catalogueNetworkError(e: unknown): MerchantCatalogueResult {
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: `price-file fetch failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  private orderNetworkError(e: unknown): MerchantOrderResult {
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: `order submission failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }
}
