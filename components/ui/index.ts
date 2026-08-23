/**
 * CrewFlow design system — one import surface.
 *
 *   import { Badge, StatTile, Table, toneClass } from "@/components/ui";
 *
 * Everything exported here is a server component or a pure function; nothing in
 * this barrel pulls in a client boundary, so it is safe to import from a server
 * component without turning the caller into one.
 *
 * `Modal` is the ONE primitive deliberately left out, because it is a client
 * component. Import it from its own module:
 *
 *   import { Modal } from "@/components/ui/modal";
 *
 * That is a measured rule, not a stylistic one. With `export { Modal } from
 * "./modal"` here, `next build` put /operations — a page that renders no dialog
 * and imports only { Badge, StatTile } — at 1.52 kB / 179 kB first load, against
 * 498 B / 171 kB on origin/main: barrel tracing dragged the client boundary into
 * every consumer of this file. Deleting the re-export returned it to 499 B /
 * 171 kB. __tests__/ui/design-system-adoption.test.ts pins it out.
 *
 * Every COMPONENT exported here is rendered by a real surface. A primitive
 * nobody renders is debt that still has to be reviewed, typechecked and kept
 * AA-correct, so it does not get a re-export to make it look load-bearing —
 * __tests__/ui/design-system-adoption.test.ts pins `Badge`, `StatTile`, `Table`
 * and `Modal` to real call sites and fails if the last consumer of one is
 * refactored away.
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

// Shell chrome (server components — safe in the barrel, no client boundary).
export { PageHeader } from "./page-header";
export { Breadcrumb, type Crumb } from "./breadcrumb";

// Table chrome. Server components, so this re-export costs nothing:
// /sites is 501 B / 171 kB after adoption, byte-identical to origin/main.
export {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  type Breakpoint,
} from "./table";

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
