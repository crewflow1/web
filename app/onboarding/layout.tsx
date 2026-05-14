import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrgForUser } from "@/server/auth/session";
import { signOut } from "@/app/(auth)/actions";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
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
