import Link from "next/link";
import { CookieSettingsButton } from "@/app/_components/cookie-settings-button";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="container py-5">
        <Link href="/" className="text-lg font-semibold tracking-tight text-slate-900">
          CrewFlow
        </Link>
      </header>

      <main className="container flex flex-1 items-start justify-center px-4 pb-12 sm:items-center">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          {children}
        </div>
      </main>

      <footer className="container py-4 text-center text-xs text-slate-500">
        <p>Never miss another construction lead.</p>
        <p className="mt-2">
          <Link href="/privacy" className="underline underline-offset-2 hover:text-slate-700">
            Privacy
          </Link>
          <span aria-hidden="true"> · </span>
          <CookieSettingsButton className="rounded underline underline-offset-2 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400" />
        </p>
      </footer>
    </div>
  );
}
