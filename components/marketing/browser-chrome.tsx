/**
 * The little browser chrome bar (traffic lights + URL) that frames every real
 * product screenshot. Shared by ProductFrame and the JobJourney filmstrip so
 * the "app in a browser" treatment is defined once.
 */
export function BrowserChrome({ url }: { url: string }) {
  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-2 border-b border-white/10 bg-navy-800 px-3.5 py-2.5"
    >
      <span className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
      </span>
      <span className="ml-2 truncate rounded-md bg-navy-950/60 px-2.5 py-1 font-mono text-[11px] text-ink-dim">
        {url}
      </span>
    </div>
  );
}
