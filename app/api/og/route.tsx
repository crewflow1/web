import { ImageResponse } from "next/og";

/**
 * Dynamic OpenGraph / Twitter card renderer.
 *
 *   /api/og?title=Quoting%20software&eyebrow=Feature
 *
 * buildMetadata() (lib/seo/metadata.ts) points every page's OG + Twitter
 * image here, so each of the hundreds of marketing/blog URLs gets a unique,
 * on-brand 1200×630 card with zero per-page asset work. Excluded from the
 * Supabase auth middleware (see middleware.ts matcher) so it's public.
 *
 * Edge runtime + system font (no network font fetch) = fast and reliable.
 */

export const runtime = "edge";

const SIZE = { width: 1200, height: 630 };

export function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const title = (searchParams.get("title") ?? "The operating system for UK construction companies")
    .slice(0, 130);
  const eyebrow = (searchParams.get("eyebrow") ?? "").slice(0, 60);

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0F172A",
          backgroundImage:
            "radial-gradient(circle at 78% 8%, rgba(251,191,36,0.22), transparent 46%)",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Brand row */}
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              display: "flex",
              width: 64,
              height: 64,
              borderRadius: 16,
              backgroundColor: "#fbbf24",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ width: 30, height: 4, borderRadius: 4, background: "#0F172A" }} />
              <div style={{ width: 22, height: 4, borderRadius: 4, background: "#0F172A" }} />
              <div style={{ width: 14, height: 4, borderRadius: 4, background: "#0F172A" }} />
            </div>
          </div>
          <div style={{ fontSize: 38, fontWeight: 700, color: "white", letterSpacing: -1 }}>
            CrewFlow
          </div>
        </div>

        {/* Title block */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {eyebrow ? (
            <div
              style={{
                fontSize: 24,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 4,
                color: "#fbbf24",
                marginBottom: 24,
              }}
            >
              {eyebrow}
            </div>
          ) : null}
          <div
            style={{
              fontSize: title.length > 70 ? 58 : 72,
              fontWeight: 800,
              color: "white",
              lineHeight: 1.08,
              letterSpacing: -2,
              maxWidth: 1000,
            }}
          >
            {title}
          </div>
        </div>

        {/* Footer row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 26, color: "#94a3b8" }}>crewflow.uk</div>
          <div style={{ fontSize: 24, color: "#cbd5e1", fontWeight: 600 }}>
            Built for UK construction
          </div>
        </div>
      </div>
    ),
    SIZE,
  );
}
