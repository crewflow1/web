import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { signOut } from "@/app/(auth)/actions";
import { Sidebar } from "./_components/sidebar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, ctx } = await requireOrgContext();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="container flex h-14 items-center justify-between">
          <div className="flex items-center gap-3 truncate">
            <Link
              href="/dashboard"
              className="text-base font-semibold tracking-tight text-slate-900"
            >
              CrewFlow
            </Link>
            <span className="text-slate-300" aria-hidden>
              /
            </span>
            <span className="truncate text-sm text-slate-600">
              {ctx.org.name}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:inline">
              {user.email}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="flex">
        <Sidebar />
        <main className="container flex-1 py-6 sm:py-10">{children}</main>
      </div>
    </div>
  );
}
