import { ImageResponse } from "next/og";

/**
 * Default Open Graph / Twitter share image (1200x630) for the whole site.
 *
 * Next.js auto-detects this file and injects <meta property="og:image"> +
 * <meta name="twitter:image"> pointing at the generated route — so shares
 * on LinkedIn / WhatsApp / Slack get a branded card instead of a blank
 * preview. Rendered with next/og (Satori); no remote fonts are fetched,
 * so the build can never fail on a font download.
 *
 * NOTE: the /opengraph-image route is excluded from the auth middleware
 * matcher (see middleware.ts) so it is served publicly.
 *
 * The mark mirrors the in-app LogoMark + favicon: three descending gold
 * (#f9a826) bars on a navy (#16213e) tile, bar widths in 52/44/33 ratio.
 */

export const alt =
  "CrewFlow, the operating system for UK construction companies";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  const bar = (width: number) => ({
    width,
    height: 15,
    borderRadius: 8,
    background: "#f9a826",
  });

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0f172a 0%, #16213e 100%)",
          color: "#f8fafc",
          fontFamily: "sans-serif",
          padding: "0 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
          <div
            style={{
              width: 132,
              height: 132,
              borderRadius: 30,
              background: "#16213e",
              border: "1px solid rgba(255,255,255,0.10)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              paddingLeft: 36,
              gap: 6,
            }}
          >
            <div style={bar(69)} />
            <div style={bar(58)} />
            <div style={bar(44)} />
          </div>
          <div style={{ display: "flex", fontSize: 92, fontWeight: 700, letterSpacing: -2 }}>
            CrewFlow
          </div>
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 34,
            fontSize: 40,
            color: "#cbd5e1",
            textAlign: "center",
            maxWidth: 920,
          }}
        >
          The operating system for UK construction companies.
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 42,
            fontSize: 26,
            color: "#f9a826",
            fontWeight: 600,
          }}
        >
          crewflow.uk
        </div>
      </div>
    ),
    { ...size },
  );
}
