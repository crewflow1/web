import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Table — the product's data-table chrome, codified.
 *
 * 29 files under app/(app) hand-roll the identical recipe: a horizontally
 * scrollable wrapper, an uppercase slate-500 header band on slate-50,
 * `divide-y` rows, a hover wash, and right-aligned `tabular-nums` for figures.
 * These are that recipe as composable parts. Server components — no client JS,
 * exactly like the rest of the design system.
 *
 * GEOMETRY IS THE DOMINANT SHIPPED IDIOM, MEASURED — NOT INVENTED. The counts
 * below are `grep`s over app/(app) at the time of writing, and every class here
 * is whichever string won:
 *
 *   thead   `bg-slate-50 text-left text-xs font-semibold uppercase
 *            tracking-wide text-slate-500`            20 of 26 theads
 *   table   `min-w-full divide-y divide-slate-200`    20 of 29
 *   tbody   `divide-y divide-slate-100`               25 of 26
 *   th      `px-4 py-3`                               35 (next: px-4 py-2, 15)
 *   td      `px-4 py-3`                               18, +11 with text-slate-600
 *   row     `hover:bg-slate-50`                       229 sitewide vs 17 for -100
 *   wrapper `overflow-x-auto`                         the only form used
 *
 * This matters because the primitive recovered from the stranded branch shipped
 * a DIFFERENT recipe (no header fill, `text-[10px] font-medium tracking-wider`,
 * `divide-slate-200` rows, `border-collapse`, `px-4 py-2.5`). Adopting that
 * would restyle 29 surfaces one at a time — a redesign wearing a
 * consolidation's clothes. Same reasoning as ./tokens.ts, which kept the branch's
 * idea and replaced every value.
 *
 * LIGHT ONLY. `.dark` is applied nowhere in app/, and app/(app) contains not one
 * `dark:` class, so the branch's `dark:` halves are dropped rather than carried
 * as strings that can never activate.
 *
 * COLOUR IS NOT A PROP. Nothing here takes a `tone`: a table cell's colour is
 * slate chrome, identical for every row, so it needs no entry in ./tokens.ts.
 * A cell that must carry status renders a `<Badge>` inside it, where the tone is
 * AA-verified.
 *
 *   <Table>
 *     <THead>
 *       <TR hover={false}>
 *         <TH>Name</TH>
 *         <TH hideBelow="md">Where</TH>
 *         <TH numeric>In use by</TH>
 *       </TR>
 *     </THead>
 *     <TBody>
 *       {rows.map((r) => (
 *         <TR key={r.id}>
 *           <TD><Link href={`/x/${r.id}`}>{r.name}</Link></TD>
 *           <TD muted hideBelow="md">{r.where}</TD>
 *           <TD numeric muted>{r.count}</TD>
 *         </TR>
 *       ))}
 *     </TBody>
 *   </Table>
 */

/**
 * Responsive hiding, as whole literal class strings.
 *
 * Tailwind's scanner cannot see `hidden ${bp}:table-cell`, so the three shipped
 * breakpoints are spelled out and callers pick one — the same rule ./tokens.ts
 * enforces for colour. `table-cell`, never `block`: restoring a `<th>`/`<td>` to
 * `display: block` would drop it out of the table's column model and the row
 * would stop aligning.
 *
 * A hidden column MUST be hidden on both the `<th>` and every matching `<td>` at
 * the same breakpoint, which is the bug this prop exists to make hard: pass the
 * same `hideBelow` to the pair and the column can no longer half-hide.
 */
const HIDE_BELOW = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
} as const;

export type Breakpoint = keyof typeof HIDE_BELOW;

/**
 * The scroll wrapper + the table. The wrapper is not optional: a table narrower
 * than its content is how a phone-width page gains a horizontal scrollbar on
 * `<html>` instead of inside the card.
 *
 * Chrome only — the surrounding card (`rounded-xl border border-slate-200
 * bg-white shadow-sm`) stays on the surface, because whether the table sits in a
 * card, a section with a heading band, or nothing at all is a page decision.
 */
export function Table({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("min-w-full divide-y divide-slate-200 text-sm", className)}>
        {children}
      </table>
    </div>
  );
}

export function THead({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <thead
      className={cn(
        // slate-500 on slate-50 is 4.53:1 — AA for normal text, and these are
        // uppercase text-xs so the large-text exemption does not apply.
        "bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500",
        className,
      )}
    >
      {children}
    </thead>
  );
}

export function TBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <tbody className={cn("divide-y divide-slate-100", className)}>{children}</tbody>;
}

export function TR({
  hover = true,
  className,
  children,
}: {
  /** The row hover wash. Pass `false` for a header row or a totals row. */
  hover?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <tr className={cn(hover && "hover:bg-slate-50", className)}>{children}</tr>
  );
}

export function TH({
  numeric = false,
  hideBelow,
  className,
  children,
}: {
  /** Right-align, because the figures below it are right-aligned. */
  numeric?: boolean;
  /** Hide this column below a breakpoint. Must match the column's `<TD>`s. */
  hideBelow?: Breakpoint;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "px-4 py-3",
        numeric && "text-right",
        hideBelow && HIDE_BELOW[hideBelow],
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({
  numeric = false,
  muted = false,
  hideBelow,
  className,
  children,
}: {
  /**
   * A figure: right-aligned with `tabular-nums` so digits sit in a column.
   * Deliberately carries NO colour — the shipped numeric cells are variously
   * `text-slate-600`, `font-medium text-slate-900` and inherited, so forcing one
   * would restyle two thirds of them. Pair with `muted` or a `className`.
   */
  numeric?: boolean;
  /** The secondary-information colour: `text-slate-600` (7.06:1 on white). */
  muted?: boolean;
  /** Hide below a breakpoint. Must match this column's `<TH>`. */
  hideBelow?: Breakpoint;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <td
      className={cn(
        "px-4 py-3",
        numeric && "text-right tabular-nums",
        muted && "text-slate-600",
        hideBelow && HIDE_BELOW[hideBelow],
        className,
      )}
    >
      {children}
    </td>
  );
}
