import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Wiring contract for the company-logo feature. These assert on source so the
 * end-to-end shape can't silently regress without a DB or a browser:
 *
 *   1. The settings UI no longer offers a free-text logo URL input, and the
 *      org server action neither accepts nor writes logo_url (req #11/#12).
 *   2. The settings page mounts the secure <LogoUpload> control.
 *   3. Every server-rendered display surface (quote/invoice PDFs, public quote
 *      page + PDF, customer portal shell + invoice PDF, email senders) resolves
 *      the logo through resolveOrgLogoSrc and selects logo_path (req #10).
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

describe("settings UI no longer takes a logo URL", () => {
  const forms = read("app/(app)/settings/_forms.tsx");
  const actions = read("app/(app)/settings/actions.ts");
  const page = read("app/(app)/settings/page.tsx");

  it("the org form renders no logo_url field and no url-type input", () => {
    expect(forms).not.toMatch(/name=["']logo_url["']/);
    expect(forms).not.toMatch(/type=["']url["']/);
    // The OrgDefaults type no longer carries logo_url.
    expect(forms).not.toMatch(/logo_url:\s*string/);
  });

  it("orgSchema does not define a logo_url field", () => {
    // A zod field would look like `logo_url: z.` / `logo_url: optional(`.
    expect(actions).not.toMatch(/logo_url:\s*(z\.|optional\()/);
  });

  it("the org UPDATE payload never writes logo_url (only ever cleared by the logo service)", () => {
    expect(actions).not.toMatch(/logo_url:\s*result\.data/);
  });

  it("the settings page mounts the secure LogoUpload control + resolves a preview", () => {
    expect(page).toMatch(/<LogoUpload/);
    expect(page).toMatch(/resolveOrgLogoSrc\(/);
    expect(page).toMatch(/logo_path/);
  });
});

describe("logo upload control is backed by the dedicated server actions", () => {
  const control = read("app/(app)/settings/_logo-upload.tsx");
  const logoActions = read("app/(app)/settings/logo-actions.ts");

  it("the client control calls uploadLogoAction + deleteLogoAction", () => {
    expect(control).toMatch(/uploadLogoAction/);
    expect(control).toMatch(/deleteLogoAction/);
    // It accepts a file input limited to the allowed image types.
    expect(control).toMatch(/LOGO_ACCEPT/);
  });

  it("the actions delegate to the company-logo service", () => {
    expect(logoActions).toMatch(/uploadCompanyLogo/);
    expect(logoActions).toMatch(/deleteCompanyLogo/);
  });
});

// Every server-rendered surface that previously read org.logo_url directly.
const PDF_AND_EMAIL_SITES = [
  "lib/email/send-quote.ts",
  "lib/email/send-invoice.ts",
  "lib/email/render-invoice-pdf.ts",
  "app/api/quotes/[id]/pdf/route.ts",
  "app/api/invoices/[id]/pdf/route.ts",
  "app/q/[token]/pdf/route.ts",
  "app/customer-portal/[token]/invoices/[id]/pdf/route.ts",
];

describe("PDF + email display sites resolve via resolveOrgLogoSrc", () => {
  it.each(PDF_AND_EMAIL_SITES)("%s imports + uses resolveOrgLogoSrc and selects logo_path", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/from\s+["']@\/server\/services\/company-logo["']/);
    // org_logo_url is now fed by the resolver, not a raw column pass-through.
    expect(src).toMatch(/org_logo_url:\s*await\s+resolveOrgLogoSrc\(/);
    expect(src).not.toMatch(/org_logo_url:\s*\w+\.org\?\.logo_url/);
    expect(src).toMatch(/logo_path/);
  });
});

describe("public quote page renders the resolved signed URL, not the raw column", () => {
  const page = read("app/q/[token]/page.tsx");
  it("resolves with the existing admin client and renders logoSrc", () => {
    expect(page).toMatch(/resolveOrgLogoSrc\(\s*org\s*,\s*admin\s*\)/);
    expect(page).toMatch(/src=\{logoSrc\}/);
    expect(page).not.toMatch(/src=\{org\.logo_url\}/);
    expect(page).toMatch(/logo_path/);
  });
});

describe("customer portal loader resolves the logo before handing it to the shell", () => {
  const helpers = read("app/customer-portal/_helpers.ts");
  it("selects logo_path and resolves into the logo_url field the shell already reads", () => {
    expect(helpers).toMatch(/logo_path/);
    expect(helpers).toMatch(/resolveOrgLogoSrc\(/);
    // The shell is unchanged: it still reads org.logo_url, now pre-resolved.
    const shell = read("app/customer-portal/[token]/_shell.tsx");
    expect(shell).toMatch(/org\.logo_url/);
  });
});

describe("onboarding + retention treat an uploaded logo as complete", () => {
  it("checklist completion accepts logo_path OR logo_url", () => {
    const checklist = read("lib/onboarding/checklist.ts");
    expect(checklist).toMatch(/snap\.org\.logo_path/);
    expect(checklist).toMatch(/snap\.org\.logo_url/);
    // CTA copy reflects upload, not a URL paste.
    expect(checklist).not.toMatch(/Add logo URL/);
  });

  it("retention 'logo' signal + completion accept either source", () => {
    const signals = read("lib/retention/signals.ts");
    expect(signals).toMatch(/snap\.org\.logo_path\s*\|\|\s*snap\.org\.logo_url/);
    expect(signals).toMatch(/!snap\.org\.logo_path\s*&&\s*!snap\.org\.logo_url/);
  });

  it("both onboarding snapshot producers select logo_path", () => {
    expect(read("server/services/onboarding-snapshot.ts")).toMatch(/logo_path/);
    expect(read("server/services/hq-onboarding-snapshot.ts")).toMatch(/logo_path/);
  });
});
