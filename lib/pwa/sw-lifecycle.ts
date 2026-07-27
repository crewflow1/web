/**
 * PWA service-worker lifecycle policy (Programme F) — pure, DOM-free, so the reload
 * decision is unit-testable in the node test env (mirrors lib/pwa/cache-policy.ts).
 *
 * The service worker's first-install `clients.claim()` and a user-accepted update's
 * `SKIP_WAITING` claim BOTH dispatch the same `controllerchange` event — the event
 * alone can't tell them apart. So the registrar reloads ONLY when the user accepted
 * an update (clicked Refresh), never on the silent first-install claim.
 */

/**
 * Reload the page on `controllerchange` iff the user accepted an update and we have
 * not already reloaded. First-install claim (`userAccepted === false`) → no reload.
 */
export function shouldReloadOnControllerChange(userAccepted: boolean, alreadyReloaded: boolean): boolean {
  return userAccepted && !alreadyReloaded;
}
