import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Table — the dark data-table pattern, codified.
 *
 * Across HQ the same inline recipe repeated on every list: a horizontally
 * scrollable wrapper, an uppercase slate-500 header, slate-800 row
 * dividers, a hover wash, and right-aligned tabular-nums for numbers.
 * These primitives are that recipe as composable, server-rendered parts
 * (no client JS) so no surface hand-rolls table chrome again.
 *
 *   <Table>
 *     <THead>
 *       <TR>
 *         <TH>Company</TH>
 *         <TH numeric>MRR</TH>
 *       </TR>
 *     </THead>
 *     <TBody>
 *       {rows.map((r) => (
 *         <TR key={r.id}>
 *           <TD>{r.name}</TD>
 *           <TD numeric>{r.mrr}</TD>
 *         </TR>
 *       ))}
 *     </TBody>
 *   </Table>
 *
 * For a staggered entrance, wrap the table in <Stagger> and the rows in
 * <StaggerItem> (those carry the client motion boundary).
 */

export function Table({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="-mx-px overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)}>
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
        "border-b border-slate-200 text-[10px] font-medium uppercase tracking-wider text-slate-500 dark:border-slate-800",
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
  return (
    <tbody className={cn("divide-y divide-slate-200 dark:divide-slate-800", className)}>
      {children}
    </tbody>
  );
}

export function TR({
  className,
  hover = true,
  children,
}: {
  className?: string;
  /** Apply the row hover wash. Off for header rows. */
  hover?: boolean;
  children: ReactNode;
}) {
  return (
    <tr
      className={cn(
        hover && "transition-colors hover:bg-slate-50 dark:hover:bg-slate-900/50",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TH({
  numeric = false,
  className,
  children,
}: {
  numeric?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "px-4 py-2.5 font-medium",
        numeric ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({
  numeric = false,
  className,
  children,
}: {
  numeric?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <td
      className={cn(
        "px-4 py-3",
        numeric
          ? "text-right tabular-nums text-slate-900 dark:text-white"
          : "text-slate-700 dark:text-slate-300",
        className,
      )}
    >
      {children}
    </td>
  );
}
