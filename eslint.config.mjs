import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * CEO Directive 007.6 — the Final Design Rule, made executable.
 *
 *   "No engineer should ever write: bg-*-500/15 / text-*-300 / ring-*-400/30
 *    inside the HQ unless that combination originates from the design token
 *    system. Everything must come from the canonical tokens. One source.
 *    Forever."
 *
 * This inline plugin flags any single string that hand-spells the canonical
 * status-pill recipe — a bare (not `dark:`/`hover:`-prefixed) `bg-{hue}-500/15`
 * + `text-{hue}-300` + `ring-{hue}-400/30` for one matching hue — so the only
 * legal source of that combination is `pill()` / `accent().chip` / `ACCENT` in
 * components/ui/tokens.ts.
 *
 * Why each guard is shaped the way it is:
 *   • Per *string literal* (not per line): the canonical recipe ships as one
 *     contiguous className string. Legitimately *split* class composition — a
 *     local map that keeps `text`, `glow` and `chip` as separate properties —
 *     never gathers the full trio into a single literal, so it isn't flagged.
 *   • Bare-only (negative lookbehind for `:`): the tokens are theme-aware
 *     (`bg-X-50 … dark:bg-X-500/15`). The `dark:`-prefixed halves are the
 *     *source* of the combination, so they're exempt by construction — which is
 *     why components/ui/tokens.ts and components/ui/badge.tsx need no
 *     special-casing.
 *   • Skip `hover:bg-`: interactive action-chips (status *buttons* with a
 *     `hover:bg-*-500/25` state and per-site focus rings) are a different
 *     primitive than the static status pill. They are tracked as a future
 *     `actionChip()` token — surfaced in the Phase 7 report, not silently
 *     blessed.
 *
 * File-level exemptions (below) cover the surfaces that still hold a local
 * accent map pending CEO Directive 008 (AI Workforce roster + CEO cockpit):
 * knowingly deferred, not overlooked.
 */
const STATUS_PILL_HUES = [
  "indigo",
  "emerald",
  "amber",
  "orange",
  "sky",
  "violet",
  "cyan",
  "fuchsia",
  "rose",
  "red",
  "slate",
];

const STATUS_PILL_PATTERNS = STATUS_PILL_HUES.map((hue) => ({
  hue,
  bg: new RegExp(`(?<!:)bg-${hue}-500/15(?!\\d)`),
  fg: new RegExp(`(?<!:)text-${hue}-300(?!\\d)`),
  ring: new RegExp(`(?<!:)ring-${hue}-400/30(?!\\d)`),
}));

/** The hue whose full hand-spelled pill recipe `text` carries, or null. */
function rawStatusPillHue(text) {
  // Interactive action-chips (hover state) are a separate primitive — skip.
  if (text.includes("hover:bg-")) return null;
  for (const p of STATUS_PILL_PATTERNS) {
    if (p.bg.test(text) && p.fg.test(text) && p.ring.test(text)) return p.hue;
  }
  return null;
}

const hqDesign = {
  rules: {
    "no-raw-status-pill": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Status-pill colours must originate from the design token system (pill()/accent().chip/ACCENT in components/ui/tokens.ts), never hand-spelled.",
        },
        messages: {
          raw: 'Hand-spelled "{{hue}}" status-pill recipe (bg-{{hue}}-500/15 + text-{{hue}}-300 + ring-{{hue}}-400/30). Route it through pill("{{hue}}") / accent("{{hue}}").chip from @/components/ui — one source of truth (CEO Directive 007.6, the Final Design Rule).',
        },
        schema: [],
      },
      create(context) {
        const flag = (node, text) => {
          const hue = rawStatusPillHue(text);
          if (hue) context.report({ node, messageId: "raw", data: { hue } });
        };
        return {
          Literal(node) {
            if (typeof node.value === "string") flag(node, node.value);
          },
          TemplateElement(node) {
            const text =
              node.value && node.value.cooked != null
                ? node.value.cooked
                : node.value
                  ? node.value.raw
                  : "";
            if (text) flag(node, text);
          },
        };
      },
    },
  },
};

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "dist/**",
      "next-env.d.ts",
      "supabase/migrations/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // CEO Directive 007.6 — enforce the Final Design Rule across the HQ and the
  // shared design system. The canonical status-pill recipe may only originate
  // from the token layer.
  {
    files: [
      "app/admin/**/*.{ts,tsx}",
      "components/**/*.{ts,tsx}",
      "lib/**/*.{ts,tsx}",
      "server/**/*.{ts,tsx}",
    ],
    plugins: { "hq-design": hqDesign },
    rules: { "hq-design/no-raw-status-pill": "error" },
  },
  // One justified exemption: the AI-employee roster icon palette
  // (ACCENT_CLASSES) is a richer, employee-specific vocabulary — hover rings +
  // glow shadows, plus pink / green / blue, three hues the shared token system
  // doesn't define. Its status pills + dots already come from the tokens
  // (pill() / statusDot() / pillMap()); only the icon-tile palette stays local,
  // pending the token-palette expansion CEO Directive 008 (AI Workforce) will
  // settle. Tracked, not overlooked.
  {
    files: ["components/ai-employees/styles.ts"],
    rules: { "hq-design/no-raw-status-pill": "off" },
  },
];

export default config;
