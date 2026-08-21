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
 * Dark shell for the redesigned marketing pages (the unified "Blueprint"
 * system). Applies the brand fonts (Clash + Satoshi) here so the whole group
 * uses them; provides the accessible global nav, dark footer, a skip link and
 * a single <main> landmark — the a11y foundation the old surface lacked.
 *
 * Lives in its own route group so it can go fully dark without disturbing the
 * legacy light (marketing) pages until they are migrated across.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
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
