/**
 * CrewFlow design system — one import surface.
 *
 *   import { Surface, Panel, StatTile, Badge, AnimatedNumber } from "@/components/ui";
 *
 * Static primitives are server components; the animation layer in ./motion is
 * client-only (it carries its own "use client"). Importing a motion primitive
 * into a server component is fine — React treats it as a client boundary.
 */

export { cn } from "@/lib/utils";

// Tokens
export {
  ACCENT,
  ACCENTS,
  accent,
  pill,
  pillSoft,
  statusDot,
  type Accent,
  type AccentClasses,
} from "./tokens";

// Structure
export { Surface, Panel, GlowHeader, SectionHeading } from "./surface";
export { Card } from "./card";
export { StatTile, Fact } from "./stat-tile";
export { Table, THead, TBody, TR, TH, TD } from "./table";

// Atoms
export { Badge, TrendBadge, Chip, ChipList, Dot, LiveDot, type Trend } from "./badge";
export {
  Button,
  ButtonLink,
  buttonClass,
  type ButtonVariant,
  type ButtonSize,
} from "./button";
export { Input, Textarea, Select, Label, Field } from "./input";
export { Alert, EmptyState, Meter, type AlertTone } from "./feedback";
export { Logo, Wordmark } from "./logo";

// Loading
export {
  Skeleton,
  SkeletonTileRow,
  SkeletonTable,
  SkeletonHeader,
  Shimmer,
  ShimmerLines,
  ShimmerStat,
  ShimmerStatRow,
  ShimmerPanel,
} from "./skeleton";

// Overlays (client)
export { Modal, ModalFooter } from "./modal";
export { Tooltip } from "./tooltip";

// Motion (client)
export {
  FadeIn,
  Stagger,
  StaggerItem,
  HoverLift,
  Pop,
  AnimatedBar,
  AnimatedNumber,
  type NumberFormat,
} from "./motion";
export { PageTransition } from "./page-transition";
