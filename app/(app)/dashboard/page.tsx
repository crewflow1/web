import { requireOrgContext } from "@/server/auth/session";

export default async function DashboardPage() {
  const { ctx } = await requireOrgContext();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          Welcome to {ctx.org.name}
        </h1>
        <p className="mt-1.5 text-sm text-slate-600">
          Your CrewFlow workspace. We&apos;re building features here through the
          week — your AI receptionist lands next.
        </p>
      </div>

      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6 text-amber-700"
            aria-hidden
          >
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92Z" />
          </svg>
        </div>
        <h2 className="mt-4 text-lg font-semibold text-slate-900">
          Your AI receptionist is on the way
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
          We&apos;re wiring up your phone number, voice, and call flow. You&apos;ll
          be able to take your first AI-handled call from this dashboard
          shortly.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FeatureCard
          title="Leads"
          body="Every inbound call becomes a structured lead in your inbox."
        />
        <FeatureCard
          title="Quotes"
          body="VAT-ready quotes drafted from a voice note. Send in minutes."
        />
        <FeatureCard
          title="Invoices"
          body="One-tap Stripe payment links, money straight into your account."
        />
      </div>
    </div>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="font-semibold text-slate-900">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}
