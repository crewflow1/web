import {
  ArrowRight,
  Building2,
  Globe,
  Hash,
  Palette,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import {
  ACCENTS,
  accent,
  Alert,
  AnimatedNumber,
  Badge,
  Button,
  Card,
  Chip,
  ChipList,
  Dot,
  EmptyState,
  FadeIn,
  Fact,
  Field,
  GlowHeader,
  Input,
  LiveDot,
  Logo,
  Meter,
  Panel,
  Select,
  Shimmer,
  ShimmerLines,
  ShimmerStatRow,
  Stagger,
  StaggerItem,
  StatTile,
  Surface,
  TrendBadge,
  Wordmark,
} from "@/components/ui";

/**
 * CrewFlow HQ — Design System (CEO Directive 006).
 *
 * The living reference for the one design language the whole platform shares:
 * tokens, surfaces, atoms, forms, feedback, loading and motion, every example
 * rendered from the same components production uses. If it isn't here, it isn't
 * in the system. Super-admin only (the /admin layout gates the route).
 */

export const metadata = { title: "Design System · CrewFlow HQ" };

export default function DesignSystemPage() {
  return (
    <Surface>
      <GlowHeader
        icon={<Palette className="h-6 w-6" strokeWidth={1.75} />}
        eyebrow="CrewFlow design system"
        title="One language, every screen"
        subtitle="The single source of truth for surfaces, colour, type, motion and the component library the whole platform is built from."
        actions={
          <Badge accent="emerald" soft>
            <LiveDot />
            Directive 006
          </Badge>
        }
      />

      <div className="space-y-6 p-5 sm:p-7">
        {/* Brand ------------------------------------------------------------ */}
        <Panel
          title="Brand mark"
          subtitle="One logo everywhere — monochrome, theme-agnostic, no gold."
          icon={<Sparkles className="h-4 w-4" />}
          accent="indigo"
        >
          <div className="flex flex-wrap items-center gap-8">
            <div className="flex items-center gap-4">
              <Logo size={48} />
              <Logo size={32} />
              <Logo size={24} />
            </div>
            <div className="h-10 w-px bg-slate-800" />
            <Wordmark size={32} textClassName="text-white" />
            <Wordmark size={24} textClassName="text-slate-300" />
          </div>
        </Panel>

        {/* Accents ---------------------------------------------------------- */}
        <Panel
          title="Accent palette"
          subtitle="Nine accents, one token map. A foreground, a chip, a soft pill, a bar and a glow — defined once, reused everywhere."
          icon={<Palette className="h-4 w-4" />}
          accent="violet"
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {ACCENTS.map((a) => {
              const c = accent(a);
              return (
                <div
                  key={a}
                  className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-semibold capitalize ${c.text}`}>
                      {a}
                    </span>
                    <Dot accent={a} />
                  </div>
                  <div className="mt-2.5 flex items-center gap-2">
                    <span
                      className={`flex h-7 w-7 items-center justify-center rounded-lg ${c.chip}`}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                    </span>
                    <Chip accent={a}>chip</Chip>
                  </div>
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div className={`h-full w-3/4 rounded-full ${c.bar}`} />
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        {/* Typography ------------------------------------------------------- */}
        <Panel title="Typography" subtitle="Inter, tightened tracking on display sizes." accent="sky">
          <div className="space-y-2">
            <p className="text-3xl font-bold tracking-tight text-white">
              Display — the Stripe of construction software
            </p>
            <p className="text-xl font-bold tracking-tight text-white">
              Heading — built for UK construction companies
            </p>
            <p className="text-sm font-semibold text-white">Title — section label</p>
            <p className="text-sm text-slate-300">
              Body — calm, high-contrast slate on the dark canvas. Comfortable to
              read across long reports and dense tables alike.
            </p>
            <p className="text-xs text-slate-500">
              Caption — secondary detail and metadata.
            </p>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Eyebrow — uppercase micro-label
            </p>
          </div>
        </Panel>

        {/* Buttons ---------------------------------------------------------- */}
        <Panel title="Buttons" subtitle="One component. Light variants for the product, dark variants for HQ." accent="indigo">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="accent">
                <Sparkles className="h-4 w-4" />
                Accent
              </Button>
              <Button variant="glass">Glass</Button>
              <Button variant="subtle">Subtle</Button>
              <Button variant="accent" disabled>
                Disabled
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="accent" size="sm">
                Small
              </Button>
              <Button variant="accent" size="md">
                Medium
              </Button>
              <Button variant="accent" size="lg">
                Large
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Panel>

        {/* Badges & chips --------------------------------------------------- */}
        <Panel title="Badges, chips & status" subtitle="The high-frequency atoms." accent="emerald">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge accent="indigo">Indigo</Badge>
              <Badge accent="emerald">Live</Badge>
              <Badge accent="amber">Pending</Badge>
              <Badge accent="rose">Failed</Badge>
              <Badge accent="sky" soft>
                Soft
              </Badge>
              <Badge accent="emerald" soft>
                <LiveDot />
                Streaming
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <TrendBadge trend={{ direction: "up", pct: 12 }} />
              <TrendBadge trend={{ direction: "down", pct: 4 }} />
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                <Dot accent="emerald" pulse /> Online
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                <Dot accent="amber" /> Degraded
              </span>
            </div>
            <ChipList
              items={["Groundworks", "Drainage", "Civils", "Reinforced concrete"]}
              accent="slate"
            />
          </div>
        </Panel>

        {/* Stat tiles + animated numbers ------------------------------------ */}
        <Panel
          title="Stat tiles"
          subtitle="KPIs that count up as they scroll into view. The Command Centre metric card, generalised."
          icon={<Building2 className="h-4 w-4" />}
          accent="emerald"
        >
          <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StaggerItem>
              <StatTile
                label="Pipeline"
                accent="indigo"
                value={<AnimatedNumber value={486000} format="currency" decimals={0} />}
                sub="Across 38 open quotes"
                trend={{ direction: "up", pct: 9 }}
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Win rate"
                accent="emerald"
                value={<AnimatedNumber value={62} format="percent" />}
                sub="Last 90 days"
                trend={{ direction: "up", pct: 5 }}
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Active jobs"
                accent="sky"
                value={<AnimatedNumber value={124} />}
                sub="On site this week"
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Companies"
                accent="violet"
                value={<AnimatedNumber value={12800} format="compact" />}
                sub="In the research index"
                trend={{ direction: "down", pct: 2 }}
              />
            </StaggerItem>
          </Stagger>
        </Panel>

        {/* Cards ------------------------------------------------------------ */}
        <Panel title="Cards" subtitle="Glass tiles that lift on hover. Add a corner glow for emphasis." accent="cyan">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card accent="indigo" glow>
              <p className="text-sm font-semibold text-white">Glowing card</p>
              <p className="mt-1 text-xs text-slate-400">
                A blurred accent in the corner. Hover to feel it lift.
              </p>
            </Card>
            <Card>
              <p className="text-sm font-semibold text-white">Plain glass</p>
              <p className="mt-1 text-xs text-slate-400">
                The default surface for grouped content.
              </p>
            </Card>
            <Card hover={false}>
              <p className="text-sm font-semibold text-white">Static</p>
              <p className="mt-1 text-xs text-slate-400">
                Hover disabled for non-interactive content.
              </p>
            </Card>
          </div>
        </Panel>

        {/* Definition rows -------------------------------------------------- */}
        <Panel title="Definition list" subtitle="Key/value rows that hide themselves when a value is unknown." accent="slate">
          <dl>
            <Fact label="Industry" value="Construction — groundworks" />
            <Fact label="Headcount" value="Small (10–49)" />
            <Fact label="Region" value="North West England" />
            <Fact label="Revenue" value={null} />
          </dl>
        </Panel>

        {/* Forms ------------------------------------------------------------ */}
        <Panel title="Forms" subtitle="Inputs, selects and fields on the dark canvas." accent="indigo">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Company name" icon={<Search />}>
              <Input placeholder="e.g. Pennine Groundworks Ltd" />
            </Field>
            <Field label="Website" icon={<Globe />}>
              <Input placeholder="company.co.uk" inputMode="url" />
            </Field>
            <Field label="Companies House" hint="(optional)" icon={<Hash />}>
              <Input placeholder="08123456" />
            </Field>
            <Field label="Segment">
              <Select defaultValue="">
                <option value="" disabled>
                  Choose a segment…
                </option>
                <option>Groundworks</option>
                <option>Roofing</option>
                <option>Electrical</option>
              </Select>
            </Field>
          </div>
        </Panel>

        {/* Feedback --------------------------------------------------------- */}
        <Panel title="Feedback" subtitle="Alerts, meters and empty states." accent="amber">
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Alert tone="info" title="Heads up">
                Research reads public sources only and drafts outreach for review.
              </Alert>
              <Alert tone="success" title="Saved">
                Your changes are live across the workspace.
              </Alert>
              <Alert tone="warning" title="Approaching limit">
                You have used 80% of this month&apos;s research runs.
              </Alert>
              <Alert tone="danger" title="Couldn&apos;t reach the site">
                We&apos;ll keep the partial profile and retry shortly.
              </Alert>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <p className="mb-1.5 text-xs text-slate-400">Strong fit</p>
                <Meter value={84} accent="emerald" />
              </div>
              <div>
                <p className="mb-1.5 text-xs text-slate-400">Partial</p>
                <Meter value={46} accent="amber" />
              </div>
              <div>
                <p className="mb-1.5 text-xs text-slate-400">Unknown</p>
                <Meter value={null} />
              </div>
            </div>
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title="No decision-makers yet"
              description="Run research on a company and verified contacts will appear here."
              action={
                <Button variant="accent" size="sm">
                  <Sparkles className="h-4 w-4" />
                  Research a company
                </Button>
              }
            />
          </div>
        </Panel>

        {/* Loading ---------------------------------------------------------- */}
        <Panel title="Loading" subtitle="Premium shimmer on the dark canvas while data resolves." accent="sky">
          <div className="space-y-4">
            <ShimmerStatRow count={4} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ShimmerLines lines={4} />
              <div className="flex items-center gap-3">
                <Shimmer className="h-12 w-12 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Shimmer className="h-3 w-1/2" />
                  <Shimmer className="h-3 w-2/3" />
                </div>
              </div>
            </div>
          </div>
        </Panel>

        {/* Motion ----------------------------------------------------------- */}
        <Panel title="Motion" subtitle="Everything fades and rises into view. Respects reduced-motion." accent="fuchsia">
          <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {["Fade", "Rise", "Stagger", "Spring"].map((label) => (
              <StaggerItem key={label}>
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-center text-sm font-medium text-slate-200">
                  {label}
                </div>
              </StaggerItem>
            ))}
          </Stagger>
          <FadeIn className="mt-3" delay={0.1}>
            <p className="text-xs text-slate-500">
              This line fades up on its own as it enters the viewport.
            </p>
          </FadeIn>
        </Panel>
      </div>
    </Surface>
  );
}
