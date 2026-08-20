import "server-only";
import { env } from "@/lib/env";

/**
 * The Marketplace / partner-platform ON/OFF switch (Phase 14).
 *
 * DARK BY DEFAULT. When this returns false the marketplace surfaces must
 * behave as if they do not exist — the developer console and the tenant
 * discovery page 404, and the install / uninstall / listing actions refuse.
 * The whole engineering (partner identity, listings, the review/approval
 * workflow, consent-scoped installs that mint an install-bound API key and
 * route webhooks to the install, uninstall that revokes the entitlement + the
 * bound key) is built and tested BEHIND this flag.
 *
 * Going live is NOT just flipping this bit: a live marketplace also needs
 * external partner onboarding — real commercial agreements and developer
 * vetting — which is deliberately out of this repo's scope. This flag is the
 * in-repo half of that decision; the external half keeps monetary/commercial
 * activation dark regardless.
 *
 * Server-only: the flag never rides into a client bundle.
 */
export function isMarketplaceEnabled(): boolean {
  return env.FEATURE_MARKETPLACE === "true";
}
