/**
 * CrewFlow design system — one import surface.
 *
 *   import { Badge, StatTile, toneClass } from "@/components/ui";
 *
 * Everything exported here is a server component or a pure function; nothing in
 * this barrel pulls in a client boundary, so it is safe to import from a server
 * component without turning the caller into one.
 *
 * Every COMPONENT exported here is rendered by a real surface. A primitive
 * nobody renders is debt that still has to be reviewed, typechecked and kept
 * AA-correct, so it does not get a re-export to make it look load-bearing —
 * __tests__/ui/design-system-adoption.test.ts pins `Badge` and `StatTile` to
 * real call sites and fails if the last consumer of one is refactored away.
 *
 * The token exports are the deliberate exception: `toneClass` currently has no
 * caller outside this directory, because Badge and StatTile resolve colour on a
 * surface's behalf. It stays exported as the documented extension point for the
 * next primitive and for a surface that must style its own element as a pill,
 * and the token map is verified directly by __tests__/ui/tokens.test.ts rather
 * than by a call site.
 */

// Tokens — the colour source of truth.
export {
  TONE,
  TONES,
  tone,
  toneClass,
  type Tone,
  type ToneClasses,
  type ToneVariant,
} from "./tokens";

// Atoms.
export { Badge, badgeClass } from "./badge";
export { StatTile } from "./stat-tile";

// Pre-existing primitives, re-exported so `@/components/ui` is the one door.
export {
  Button,
  ButtonLink,
  buttonClass,
  type ButtonVariant,
  type ButtonSize,
} from "./button";
export {
  Skeleton,
  SkeletonTileRow,
  SkeletonTable,
  SkeletonDetail,
  SkeletonHeader,
} from "./skeleton";

// The tailwind-aware className merger every primitive above composes with.
export { cn } from "@/lib/utils";
