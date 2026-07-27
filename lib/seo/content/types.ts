/**
 * Shared content types for the programmatic marketing surface.
 *
 * Pages are generated from this typed data, NOT hand-written per URL. The
 * uniqueness (and therefore the defence against thin/doorway-page penalties)
 * comes from genuinely different per-entity content: real module behaviour,
 * real competitor positioning, trade-specific workflows, local context. The
 * template is shared; the substance is not.
 */

export type Faq = { q: string; a: string };

export type Section = {
  h2: string;
  body: string;
  bullets?: string[];
};

export type Outcome = {
  stat?: string;
  label: string;
  body: string;
};

/** A product capability / module page → /features/[slug]. */
export type FeaturePage = {
  slug: string;
  /** Primary target keyword. */
  keyword: string;
  /** Secondary keywords this page should also satisfy. */
  secondaryKeywords?: string[];
  name: string;
  navLabel: string;
  /** <60 chars ideally. */
  title: string;
  /** 150–160 chars. */
  metaDescription: string;
  eyebrow: string;
  h1: string;
  /** Lead paragraphs (use \n\n to split). */
  intro: string;
  heroBullets: string[];
  problem: { heading: string; body: string };
  sections: Section[];
  outcomes: Outcome[];
  faqs: Faq[];
  /** Related feature slugs (internal links). */
  related: string[];
  /** Relevant industry slugs (internal links). */
  industries?: string[];
};

/** A competitor comparison page → /compare/[slug]. */
export type ComparisonPage = {
  slug: string; // e.g. "crewflow-vs-jobber"
  keyword: string;
  secondaryKeywords?: string[];
  competitor: {
    name: string;
    /** One honest, factual line about what they are. */
    oneLiner: string;
    /** Where they originate / who they're built for. */
    bestFor: string;
    origin?: string;
  };
  title: string;
  metaDescription: string;
  eyebrow: string;
  h1: string;
  intro: string;
  /** Honest positioning — sets the frame fairly. */
  positioning: string;
  /** Comparison table. Value is a short string ("✓ Included", "Add-on", etc.). */
  rows: { feature: string; crewflow: string; competitor: string }[];
  /** Honesty section — builds trust + E-E-A-T. */
  whereCompetitorWins: string[];
  whereCrewflowWins: string[];
  verdict: string;
  faqs: Faq[];
  related: string[]; // other comparison slugs
  /** ISO date the competitor positioning was last reviewed. */
  lastReviewed: string;
};

/** A trade / industry page → /industries/[slug]. */
export type IndustryPage = {
  slug: string;
  trade: string;
  keyword: string;
  secondaryKeywords?: string[];
  title: string;
  metaDescription: string;
  eyebrow: string;
  h1: string;
  intro: string;
  painPoints: string[];
  sections: Section[];
  /** Feature slugs most relevant to this trade. */
  featuredModules: string[];
  faqs: Faq[];
  related: string[]; // other industry slugs
};

/** A location page → /construction-software/[slug]. */
export type LocationPage = {
  slug: string;
  location: string;
  region: string;
  keyword: string;
  title: string;
  metaDescription: string;
  eyebrow: string;
  h1: string;
  intro: string;
  /** Genuine, non-fabricated local context (qualitative). */
  localContext: string;
  faqs: Faq[];
  related: string[]; // other location slugs
};

/** A blog post / guide → /blog/[slug]. */
export type BlogPost = {
  slug: string;
  keyword: string;
  title: string;
  metaDescription: string;
  h1: string;
  excerpt: string;
  datePublished: string; // ISO
  dateModified?: string;
  readMinutes: number;
  category: string;
  /** Ordered body blocks. */
  body: BlogBlock[];
  faqs?: Faq[];
  related: string[]; // other post slugs
  relatedFeatures?: string[];
};

export type BlogBlock =
  | { type: "p"; text: string }
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; text: string; cite?: string }
  | { type: "cta"; text: string };
