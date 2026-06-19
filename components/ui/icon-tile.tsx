import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { accent, type Accent } from "./tokens";

/**
 * IconTile — the accent icon tile.
 *
 * A centered, rounded square that holds an icon (or a short glyph/number) and
 * carries the canonical chip colour. It is the *one* place the icon-tile look
 * is defined: the radial-header tiles, the Panel/GlowHeader leading icon, and
 * the inline list-row icons all resolve here.
 *
 * Colour comes from `accent(tone).chip` — the same token the status pills use —
 * so HQ (rooted in `.dark`) renders byte-identical to the legacy hand-spelled
 * `bg-{c}-500/15 text-{c}-300 ring-1 ring-inset ring-{c}-400/30` recipe these
 * tiles each grew, while the customer product gets the legible light treatment.
 * Layout (size, rounding) lives here too, so a tile is never re-spelled by hand.
 */

const ICON_TILE_SIZE = {
  xs: "h-8 w-8",
  sm: "h-9 w-9",
  md: "h-10 w-10",
  lg: "h-11 w-11",
} as const;

export type IconTileSize = keyof typeof ICON_TILE_SIZE;

/**
 * Pure class builder for an icon tile — layout (size + rounding) plus the
 * canonical chip token. `className` is merged *before* the colour token (via
 * tailwind-merge) so callers can override rounding (`rounded-lg`/`rounded-full`)
 * or add structural utilities (`shrink-0`, `relative`, `mt-0.5`) without ever
 * touching the colour. Exported so it can be unit-tested like `pill()`.
 */
export function iconTileClass(
  tone: Accent | null | undefined = "indigo",
  size: IconTileSize = "lg",
  className?: string,
): string {
  return cn(
    "flex items-center justify-center rounded-xl",
    ICON_TILE_SIZE[size],
    className,
    accent(tone).chip,
  );
}

export function IconTile({
  accent: tone = "indigo",
  size = "lg",
  className,
  children,
}: {
  accent?: Accent;
  size?: IconTileSize;
  className?: string;
  children: ReactNode;
}) {
  return <span className={iconTileClass(tone, size, className)}>{children}</span>;
}
