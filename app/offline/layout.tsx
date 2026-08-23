import type { Metadata } from "next";

/**
 * The /offline route is the PWA offline application shell — a precached fallback,
 * not a landing page. It must never be indexed (it renders per-device local state
 * and would be an empty, confusing search result). The page itself is a client
 * component and so cannot export metadata; this server layout supplies the
 * robots directive for the route.
 */
export const metadata: Metadata = {
  title: "Offline — CrewFlow",
  robots: { index: false, follow: false },
};

export default function OfflineLayout({ children }: { children: React.ReactNode }) {
  return children;
}
