import Link from "next/link";

/**
 * Landing page — Block 1 minimal version.
 *
 * Block 7 replaces this with the full 12-section page from
 * docs/05_LANDING_PAGE_COPY.md. For now, hero + footer is enough
 * to prove the deploy and start collecting waitlist signups manually.
 */
export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="container py-6">
        <nav className="flex items-center justify-between">
          <Link href="/" className="text-xl font-semibold tracking-tight">
            CrewFlow
          </Link>
          <div className="flex items-center gap-2 sm:gap-4">
            <Link
              href="/login"
              className="text-sm font-medium text-slate-700 hover:text-slate-900"
            >
              Sign in
            </Link>
            <a
              href="mailto:hello@crewflow.uk?subject=Waitlist%20—%20CrewFlow"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Join the waitlist
            </a>
          </div>
        </nav>
      </header>

      <section className="container flex-1 py-16 sm:py-24">
        <p className="text-sm font-semibold uppercase tracking-wide text-amber-600">
          Built for UK construction companies
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-tight tracking-tight text-slate-900 sm:text-6xl">
          Never miss another construction lead.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-600 sm:text-xl">
          The AI receptionist that answers your calls, takes the details, sends
          instant texts back to missed callers, and turns your voice notes into
          ready-to-send quotes. Built for builders, not for software people.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          <a
            href="mailto:hello@crewflow.uk?subject=Waitlist%20—%20CrewFlow&body=Hi%20Moe%2C%20I%27d%20like%20to%20join%20the%20CrewFlow%20waitlist.%0A%0ACompany%3A%20%0AMobile%3A%20%0ATrade%3A%20%0AEmployees%3A%20"
            className="rounded-md bg-slate-900 px-5 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Join the waitlist
          </a>
          <a
            href="mailto:moe@crewflow.uk?subject=Quick%20chat%20about%20CrewFlow"
            className="rounded-md px-5 py-3 text-base font-semibold text-slate-700 transition hover:text-slate-900"
          >
            Or message Moe directly →
          </a>
        </div>

        <p className="mt-6 text-sm text-slate-500">
          Free for the first 25 Northern Ireland contractors. Live in 15 minutes.
        </p>

        <div className="mt-16 grid gap-6 sm:grid-cols-3">
          <Feature
            title="AI receptionist"
            body="Answers in your company name, takes the details, books a callback. Forward your number or get a new one."
          />
          <Feature
            title="Missed-call text-back"
            body="The second a call goes unanswered, the caller gets a personalised text from you. Lost leads, recovered."
          />
          <Feature
            title="Quotes from voice notes"
            body="Talk through the job — line items, materials, labour — and CrewFlow drafts a VAT-ready quote. Tap send."
          />
        </div>
      </section>

      <footer className="border-t border-slate-200">
        <div className="container flex flex-wrap items-center justify-between gap-4 py-8 text-sm text-slate-500">
          <span>CrewFlow · Belfast, Northern Ireland · hello@crewflow.uk</span>
          <span>© 2026 CrewFlow. Built in Belfast.</span>
        </div>
      </footer>
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
      <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}
