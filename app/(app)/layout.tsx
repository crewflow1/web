import Link from "next/link";
import { NOINDEX_METADATA } from "@/lib/seo/metadata";
import { requireOrgContext, listOrgsForUser } from "@/server/auth/session";
import { SignOutButton } from "./_components/sign-out-button";
import { createClient } from "@/lib/supabase/server";
import { getActiveImpersonation } from "@/server/services/impersonation";
import { endImpersonation } from "@/app/admin/impersonation/actions";
import { Sidebar } from "./_components/sidebar";
import { OrgSwitcher } from "./_components/org-switcher";
import { BottomNav } from "./_components/bottom-nav";
import { NotificationsBell, type Notification } from "./_components/notifications";
import { SearchPalette } from "./_components/search-palette";

// Authenticated product — never index (defence in depth on robots.txt + auth).
export const metadata = NOINDEX_METADATA;

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, ctx } = await requireOrgContext();
  const impersonation = await getActiveImpersonation(user.email ?? null);
  const [orgs, notificationsRes] = await Promise.all([
    listOrgsForUser(user.id),
    (async () => {
      const supabase = await createClient();
      return supabase
        .from("notifications")
        .select("id, type, title, body, action_url, read_at, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(30);
    })(),
  ]);
  const notifications: Notification[] = (notificationsRes.data ?? []) as Notification[];

  return (
    <div className="min-h-screen bg-slate-50">
      {impersonation ? (
        <div className="border-b-2 border-red-400 bg-red-600 text-white">
          <div className="container flex h-10 flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold">
              🛡 IMPERSONATING {impersonation.target_org_name ?? "customer"}
              {impersonation.reason ? ` · ${impersonation.reason}` : ""}
            </span>
            <div className="flex items-center gap-2">
              <Link
                href="/admin/impersonation"
                className="rounded-md border border-red-300 bg-red-700 px-2 py-1 font-medium text-white hover:bg-red-800"
              >
                Manage
              </Link>
              <form action={endImpersonation}>
                <button
                  type="submit"
                  className="rounded-md bg-white px-3 py-1 font-semibold text-red-700 hover:bg-red-50"
                >
                  Exit impersonation
                </button>
              </form>
            </div>
          </div>
        </div>
      ) : null}
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
            <OrgSwitcher
              current={{ id: ctx.org.id, name: ctx.org.name }}
              orgs={orgs}
            />
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <SearchPalette />
            <NotificationsBell initial={notifications} />
            <span className="hidden text-xs text-slate-500 md:inline">
              {user.email}
            </span>
            <SignOutButton className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50" />
          </div>
        </div>
      </header>

      <div className="flex">
        <Sidebar role={ctx.membership.role} />
        {/* Bottom-padding reserves room for the mobile bottom-nav (md:hidden). */}
        <main className="container flex-1 py-6 pb-24 sm:py-10 md:pb-10">
          {children}
        </main>
      </div>
      <BottomNav role={ctx.membership.role} />
    </div>
  );
}
