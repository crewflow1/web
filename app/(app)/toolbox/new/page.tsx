import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { createToolboxTalk } from "../actions";
import { loadToolboxFormOptions } from "../_form-options";
import { TalkForm } from "../_talk-form";

const ERROR_MAP: Record<string, string> = {
  record_failed: "Couldn't save the talk. Try again.",
  validation: "Please check the form and try again.",
};

type SP = Promise<{ error?: string; job?: string }>;

export default async function NewToolboxTalkPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const options = await loadToolboxFormOptions(ctx.org.id);

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/toolbox" className="hover:text-slate-900">
          Toolbox talks
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-slate-900">Record a toolbox talk</h1>
        <p className="mt-1 text-sm text-slate-600">
          Save it as a draft, then deliver it to freeze the record and get a reference. Operatives can acknowledge a delivered talk.
        </p>
      </div>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <TalkForm
        action={createToolboxTalk}
        options={options}
        defaults={{ job_id: sp.job ?? null }}
        submitLabel="Save draft"
        cancelHref="/toolbox"
      />
    </div>
  );
}
