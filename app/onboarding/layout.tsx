import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrgForUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { signOut } from "@/app/(auth)/actions";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  // Defense-in-depth: an HQ super-admin must never create a customer company
  // against their own account. requireOrgContext() already bounces them out of
  // the (app) group, but onboarding lives in its OWN route group with its own
  // layout, so it needs the same guard at this chokepoint.
  if (isSuperAdminEmail(user.email)) redirect("/admin/organizations");

  const ctx = await getOrgForUser(user.id);

  // Already onboarded — send them to the app.
  if (ctx) redirect("/dashboard");

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="container flex h-14 items-center justify-between">
        <Link href="/" className="text-lg font-semibold tracking-tight text-slate-900">
          CrewFlow
        </Link>
        <form action={signOut}>
          <button
            type="submit"
            className="text-xs font-medium text-slate-500 hover:text-slate-900"
          >
            Sign out
          </button>
        </form>
      </header>

      <main className="container flex flex-1 items-start justify-center px-4 pb-12 sm:items-center">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
