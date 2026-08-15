import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { INBOX_CHANNELS, INBOX_CHANNEL_LABELS } from "@/lib/inbox/channels";
import { startConversation } from "../actions";

/**
 * /inbox/conversations/new — start a new outbound conversation with a contact.
 *
 * The first message rides the dark-safe send: on a channel with no configured provider it
 * is queued (recorded, not sent). Re-messaging a known contact folds into their existing
 * thread (the upsert on the contact-identity key).
 */

export const dynamic = "force-dynamic";

const ERROR_MAP: Record<string, string> = {
  invalid_input: "Check the fields and try again.",
  create_failed: "Couldn't start the conversation. Try again.",
};

type SP = Promise<{ error?: string }>;

export default async function NewConversationPage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;
  const error = sp.error ? ERROR_MAP[sp.error] ?? "Something went wrong." : null;

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <Link href="/inbox/conversations" className="text-sm text-slate-500 hover:text-slate-800">
          ← All conversations
        </Link>
      </div>
      <header>
        <h1 className="text-2xl font-bold text-slate-900">New message</h1>
        <p className="mt-1 text-sm text-slate-600">
          Start a conversation with a customer on any channel.
        </p>
      </header>

      {error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <form action={startConversation} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <label htmlFor="channel" className="block text-sm font-medium text-slate-700">
            Channel
          </label>
          <select
            id="channel"
            name="channel"
            defaultValue="email"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            {INBOX_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {INBOX_CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="contact" className="block text-sm font-medium text-slate-700">
            To
          </label>
          <input
            id="contact"
            name="contact"
            required
            maxLength={320}
            placeholder="email address or phone number"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="contact_name" className="block text-sm font-medium text-slate-700">
            Contact name <span className="text-slate-400">(optional)</span>
          </label>
          <input
            id="contact_name"
            name="contact_name"
            maxLength={200}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="subject" className="block text-sm font-medium text-slate-700">
            Subject <span className="text-slate-400">(optional — email)</span>
          </label>
          <input
            id="subject"
            name="subject"
            maxLength={200}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="body" className="block text-sm font-medium text-slate-700">
            Message
          </label>
          <textarea
            id="body"
            name="body"
            required
            minLength={1}
            maxLength={10_000}
            rows={5}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          <Link href="/inbox/conversations" className="text-sm font-medium text-slate-600 hover:text-slate-900">
            Cancel
          </Link>
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
