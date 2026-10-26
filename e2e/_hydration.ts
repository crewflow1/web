import { expect, type Locator } from "@playwright/test";

/**
 * Wait until React has HYDRATED a specific element — i.e. its event handlers and
 * its form-action dispatch are actually wired to the DOM node Playwright is
 * about to drive.
 *
 * WHY A GENERIC "the page loaded" WAIT IS NOT ENOUGH. These are streamed App
 * Router pages: `page.goto()` resolves on `load`, but React hydrates the tree
 * PROGRESSIVELY as Suspense boundaries arrive, so an early control can be
 * interactive while the one a step actually targets is still a server-rendered,
 * un-hydrated node. Driving it in that gap does not fail loudly — it does
 * something worse, silently:
 *   - a one-shot `onClick` that dispatches a DOM event (the /staff add-staff
 *     button → `crewflow:open-add-staff`) fires into a handler that is not
 *     attached yet; the event is lost and the dialog never opens → the follow-up
 *     `getByRole("dialog")` reports "element(s) not found" (F-E2);
 *   - a <StateForm> submit before its client dispatch is live falls back to a
 *     native form POST, which the component DELIBERATELY handles by re-rendering
 *     in place instead of navigating (see components/forms/StateForm.tsx) → the
 *     URL never changes and the `toHaveURL` after it times out (F-E3).
 * StateForm's own header says it plainly: "e2e clicks wait for hydration for
 * exactly this reason."
 *
 * The readiness SIGNAL is React's own fiber marker on the element. React 18
 * attaches a `__reactFiber$…` / `__reactProps$…` property to each hydrated host
 * node; its presence on THIS node means this subtree's commit has run and the
 * node's handlers/action are bound. This is a wait on a real completion
 * condition, not a sleep and not an action retry: `expect.poll` re-reads the
 * fiber marker until it appears, then the caller drives a node that is wired.
 *
 * Gate the EXACT element the step interacts with (the button it clicks, the form
 * it submits) rather than "some form on the page", because progressive hydration
 * is precisely what makes those two different.
 */
export async function waitForHydrated(target: Locator): Promise<void> {
  const el = target.first();
  // The node must exist before React can have hydrated it.
  await el.waitFor({ state: "attached" });
  await expect
    .poll(
      () =>
        el.evaluate((node) =>
          Object.keys(node).some(
            (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$"),
          ),
        ),
      { message: "element never hydrated (no React fiber attached)" },
    )
    .toBe(true);
}
