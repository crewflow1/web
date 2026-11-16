import Link from "next/link";

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
        Never miss another construction lead.
        <span className="mt-1 block">
          <a href="/privacy" className="underline underline-offset-2">Privacy</a>
          {" · "}
          <a href="/terms" className="underline underline-offset-2">Terms</a>
          {" · "}
          <a href="mailto:hello@crewflow.uk" className="underline underline-offset-2">hello@crewflow.uk</a>
        </span>
      </footer>
    </div>
  );
}
