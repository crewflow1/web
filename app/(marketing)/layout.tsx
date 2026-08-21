import { clashDisplay, satoshi } from "@/app/_marketing/fonts";
import { SiteNav } from "@/components/marketing/nav";
import { SiteFooterDark } from "@/components/marketing/footer";
import { BookDemoModal } from "@/app/(public)/_book-demo-modal";
import { JsonLd } from "@/components/seo/json-ld";
import {
  organizationSchema,
  websiteSchema,
  softwareApplicationSchema,
} from "@/lib/seo/schema";

/**
 * Shared chrome for the legacy marketing surface (compare / industries /
 * features / locations / blog / tools). Migrated onto the unified dark
 * "Setting-Out" system: same SiteNav, dark footer, skip link, single <main>
 * and brand fonts as the (site) group, so there is no dark-home / light-subpage
 * split. The BookDemoModal is mounted once here so every BookDemoButton works.
 *
 * Site-wide entity graph is injected here (scoped to the group); pages in the
 * (site) group get their own copy from that layout, no page double-emits.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      data-marketing="true"
      className={`${clashDisplay.variable} ${satoshi.variable} flex min-h-screen flex-col bg-navy-950 font-body text-ink`}
    >
      <JsonLd
        data={[organizationSchema(), websiteSchema(), softwareApplicationSchema()]}
      />
      <a
        href="#main"
        className="sr-only rounded-md bg-gold-500 px-4 py-2 font-semibold text-navy-950 focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-[70]"
      >
        Skip to content
      </a>
      <SiteNav />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooterDark />
      <BookDemoModal />
    </div>
  );
}
