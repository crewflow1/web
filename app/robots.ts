import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo/site";

/**
 * robots.txt (generated).
 *
 * Public marketing surface (/, /features/*, /compare/*, /industries/*,
 * /construction-software/*, /pricing, /blog/*, /privacy, /terms) is fully
 * crawlable. Everything authenticated or transactional is disallowed — it's
 * already behind the auth gate, but an explicit Disallow stops crawl-budget
 * waste and keeps login/portal URLs out of the index.
 *
 * Marketing feature pages are deliberately namespaced under /features/* so
 * they never collide with the bare app routes (/jobs, /quotes, /invoices…).
 */

const PRIVATE_PATHS = [
  "/api/",
  "/admin",
  "/dashboard",
  "/jobs",
  "/quotes",
  "/invoices",
  "/customers",
  "/leads",
  "/staff",
  "/payroll",
  "/payments",
  "/finances",
  "/expenses",
  "/suppliers",
  "/compliance",
  "/tax",
  "/reports",
  "/insights",
  "/inbox",
  "/activity",
  "/notifications",
  "/settings",
  "/support",
  "/qa",
  "/reviews",
  "/me",
  "/onboarding",
  "/login",
  "/check-email",
  "/auth",
  "/customer-portal",
  "/payment",
  "/access-pending",
  "/q/",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: PRIVATE_PATHS,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
