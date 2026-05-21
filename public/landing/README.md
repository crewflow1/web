# Landing page hero image

Drop a real CrewFlow dashboard screenshot into this folder to replace
the CSS-drawn mockup on the landing page hero.

## Naming

Use one of these exact names (first match wins, in order):

- `hero-dashboard.webp` ← preferred (smallest)
- `hero-dashboard.png`
- `hero-dashboard.jpg`

## Spec

| Property | Value |
|---|---|
| Aspect ratio | 1200×750 (~1.6:1) |
| Format | WebP at quality 80, or PNG with `tinypng` |
| Max size | 300 KB |
| Content | One real CrewFlow dashboard view, browser chrome optional |
| Sensitive data | None — use a seeded demo org, not a real customer's account |

## Deploy

Drop the file in, commit, and push. The landing page auto-detects on
the next build (the resolver runs at module load via `node:fs`).

If nothing happens, check the build log for "resolveHeroImage" — the
function silently returns `null` if `fs.existsSync` throws (e.g. in
edge runtimes).
