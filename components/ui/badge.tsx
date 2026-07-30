import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { toneClass, type Tone, type ToneVariant } from "./tokens";

/**
 * Badge — the status pill.
 *
 * The single generic pill for the product. app/(app) hand-spells this shape 29
 * times with the identical geometry below and re-types the colour beside it
 * every time; the colour now comes from ./tokens and the geometry from here.
 *
 * Geometry is the dominant shipped idiom verbatim — `rounded-full px-2 py-0.5
 * text-xs font-medium` — so swapping a hand-rolled pill for a `<Badge>` is a
 * pixel-for-pixel change, not a restyle.
 *
 * This is the GENERIC pill only. Domain pills that encode wording as well as
 * colour (fleet's `CompliancePill` turns a day count into "12d late",
 * `OperationalPill` maps an enum to a label) keep their own components and are
 * free to render a `<Badge>` inside — the domain decides what it says, the
 * design system decides how a pill looks.
 *
 * ACCESSIBILITY: the tone is decoration. `children` must always name the state
 * in words, because colour alone is not a signal a screen reader or a
 * colour-blind operator receives. Every variant is AA-verified against its own
 * fill by __tests__/ui/tokens.test.ts.
 *
 *   <Badge tone="red">Overdue</Badge>                  // -100 fill, -800 text
 *   <Badge tone="blue" variant="soft">Due 12 Aug</Badge>
 *   <Badge tone="red" variant="solid">Blocked from issue</Badge>
 */

/** The pill geometry every badge shares. Colour comes from ./tokens. */
const BADGE_BASE =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium";

/**
 * Pure class builder — exported so the pill recipe can be unit-tested and so a
 * surface that must render its own element (a `<Link>` styled as a pill, say)
 * can borrow the exact classes instead of re-typing them.
 *
 * `className` is merged LAST through `cn` (tailwind-merge), so a caller can
 * override geometry — `font-semibold`, `tabular-nums` — without being able to
 * accidentally half-override a tone.
 */
export function badgeClass(
  t: Tone | null | undefined = "slate",
  variant: Extract<ToneVariant, "pill" | "soft" | "solid"> = "pill",
  className?: string,
): string {
  return cn(BADGE_BASE, toneClass(t, variant), className);
}

export function Badge({
  tone: t = "slate",
  variant = "pill",
  className,
  children,
}: {
  tone?: Tone;
  /** `pill` (default) · `soft` for low emphasis · `solid` when it blocks. */
  variant?: Extract<ToneVariant, "pill" | "soft" | "solid">;
  className?: string;
  /** Always the state in words — never colour alone. */
  children: ReactNode;
}) {
  return <span className={badgeClass(t, variant, className)}>{children}</span>;
}
