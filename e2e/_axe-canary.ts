import type { AxeResults } from "axe-core";

/**
 * Under-scan canary for axe color-contrast.
 *
 * A hermetically reproduced anomaly (2026-07-29, blueprint-pins session, 3/3
 * on pre-fix colours): axe can return zero violations AND zero incomplete
 * while its color-contrast rule evaluated only the ~40 app-shell nodes —
 * the entire streamed <main> subtree never entered rule candidacy, so a page
 * full of sub-AA text green-lit. On branches where the colours are already
 * fixed, that failure mode is invisible through `violations` alone: a correct
 * scan and an under-scan both report zero.
 *
 * So the sweep specs also assert HOW MUCH the rule audited: passes +
 * violations + incomplete node count for color-contrast must reach a floor
 * derived from content the seeds guarantee to render. A shell-only under-scan
 * (~40 nodes behind the app shell, fewer behind the admin/portal shells)
 * then fails loudly instead of green-lighting a page axe never audited.
 * If a floor starts failing after a legitimate shell/layout slim-down,
 * recalibrate it against the seeded content of that route — a false red here
 * is cheap; the false green it replaces is not.
 */
export function contrastCandidacy(results: AxeResults): number {
  return [...results.passes, ...results.violations, ...results.incomplete]
    .filter((r) => r.id === "color-contrast")
    .reduce((n, r) => n + r.nodes.length, 0);
}
