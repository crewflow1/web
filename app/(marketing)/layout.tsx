import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/site-footer";
import { BookDemoModal } from "@/app/(public)/_book-demo-modal";
import { JsonLd } from "@/components/seo/json-ld";
import {
  organizationSchema,
  websiteSchema,
  softwareApplicationSchema,
} from "@/lib/seo/schema";
import { MotionProvider } from "@/app/_marketing/motion";

/**
 * Shared chrome for the whole public marketing surface. The BookDemoModal is
 * mounted once here so every BookDemoButton across the marketing pages works.
 *
 * Site-wide entity graph (Organization + WebSite + SoftwareApplication) is
 * injected here rather than the root layout because the homepage already
 * emits its own copy — scoping it to the (marketing) group means every
 * marketing page gets the entity graph with zero duplication on any page.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <JsonLd
        data={[organizationSchema(), websiteSchema(), softwareApplicationSchema()]}
      />
      {/* No-JS / pre-hydration safety: framer renders reveal wrappers with
          inline opacity:0; force them visible if scripts never run. */}
      <noscript>
        <style>{`.mkt-reveal{opacity:1!important;transform:none!important;filter:none!important}`}</style>
      </noscript>
      <SiteHeader />
      <main className="flex-1">
        <MotionProvider>{children}</MotionProvider>
      </main>
      <SiteFooter />
      <BookDemoModal />
    </div>
  );
}
