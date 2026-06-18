import { Badge, ButtonLink, GlowHeader, Panel, Surface } from "@/components/ui";

/**
 * Stub for HQ sections that haven't yet shipped a dedicated page.
 *
 * NEVER a dead end (directive rule 5). Each stub:
 *   - says exactly what's coming
 *   - says which sprint ships it
 *   - links the user to the nearest working surface that's already
 *     live (usually /admin/organizations or /admin/overview).
 */
export function ComingSoonStub({
  title,
  sprint,
  body,
  primaryHref,
  primaryLabel,
}: {
  title: string;
  sprint: "HQ-2" | "HQ-3" | "HQ-4" | "HQ-5" | "HQ-6";
  body: string;
  primaryHref?: string;
  primaryLabel?: string;
}) {
  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title={title}
        actions={<Badge accent="amber">Ships in {sprint}</Badge>}
      />

      <div className="p-5 sm:p-7">
        <Panel>
          <p className="text-sm text-slate-300">{body}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {primaryHref ? (
              <ButtonLink href={primaryHref} variant="accent">
                {primaryLabel ?? "Use the legacy view"}
              </ButtonLink>
            ) : null}
            <ButtonLink href="/admin/overview" variant="glass">
              Back to overview
            </ButtonLink>
          </div>
        </Panel>
      </div>
    </Surface>
  );
}
