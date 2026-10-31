"use client";

import { signOut } from "@/app/(auth)/actions";

/**
 * HQ sign-out control.
 *
 * CrewFlow HQ (/admin/*) lives OUTSIDE the (app) route group, so it never
 * inherited the workspace layout's `SignOutButton`. A super-admin lands on
 * /admin/organizations by default (see lib/supabase/middleware.ts), and from
 * there — with no logout control anywhere under /admin — there was no way to
 * sign out of HQ at all. This is that missing control.
 *
 * It posts to the same `signOut()` server action the workspace uses (Supabase
 * signOut + cookie clear + redirect to /login). No offline-queue purge here:
 * HQ is not an offline-capable workspace, so there is nothing device-local to
 * clear — the lean form is correct, and it still works with JavaScript off.
 */
export function HqSignOut({ className }: { className?: string }) {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className={
          className ??
          "w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-left text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        }
      >
        Sign out
      </button>
    </form>
  );
}
