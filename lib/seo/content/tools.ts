import type { Faq } from "./types";

/**
 * Free SEO tools (calculators). Each is an indexable, genuinely useful page —
 * the interactive maths lives in a client component; this is the SEO content
 * (copy, FAQs, links) that wraps it. Tools are classic link magnets.
 */
export type ToolPage = {
  slug: string;
  name: string;
  navLabel: string;
  keyword: string;
  secondaryKeywords?: string[];
  title: string;
  metaDescription: string;
  eyebrow: string;
  h1: string;
  intro: string;
  /** Explains the formula / assumptions (trust + uniqueness). */
  howItWorks: { h2: string; body: string; bullets?: string[] };
  faqs: Faq[];
  /** Feature slugs to cross-link (turns tool traffic into product interest). */
  relatedFeatures: string[];
  relatedTools: string[];
};

export const TOOLS: ToolPage[] = [
  {
    slug: "markup-calculator",
    name: "Markup & Margin Calculator",
    navLabel: "Markup calculator",
    keyword: "construction markup calculator",
    secondaryKeywords: ["margin vs markup calculator", "construction margin calculator", "builder pricing calculator"],
    title: "Construction Markup & Margin Calculator",
    metaDescription:
      "Free construction markup and margin calculator. Enter your job cost and target margin (or markup) to get the price to quote, your profit, and the equivalent markup or margin.",
    eyebrow: "Free tool",
    h1: "Construction Markup & Margin Calculator",
    intro:
      "Markup and margin are the two most-confused numbers in construction pricing — and getting them mixed up is how jobs quietly lose money. Enter your cost and the margin or markup you want, and this tool gives you the price to quote, your profit, and the equivalent of whichever you didn't enter.",
    howItWorks: {
      h2: "Markup vs margin — the difference that costs builders money",
      body: "They are not the same. Markup is your profit as a percentage of cost; margin is your profit as a percentage of the price. A 50% markup is only a 33% margin. Pricing a job on 'add 20%' when you needed a 20% margin leaves money on the table on every single job.",
      bullets: [
        "Markup % = profit ÷ cost",
        "Margin % = profit ÷ sale price",
        "Price (from margin) = cost ÷ (1 − margin)",
        "Price (from markup) = cost × (1 + markup)",
      ],
    },
    faqs: [
      { q: "What's the difference between markup and margin?", a: "Markup is profit as a percentage of your cost; margin is profit as a percentage of the price you charge. They're always different numbers: a 50% markup equals a 33.3% margin. Confusing the two is one of the most common construction pricing mistakes." },
      { q: "What margin should a construction company aim for?", a: "It depends on your overheads and the type of work, so there's no universal figure — but you should set it deliberately to cover overheads and leave profit, not guess. This calculator helps you price from a target margin instead of a vague 'add a bit on top'." },
      { q: "How do I convert markup to margin?", a: "Margin = markup ÷ (1 + markup). For example, a 25% markup is a 20% margin. This tool shows the equivalent automatically when you enter either one." },
    ],
    relatedFeatures: ["quoting-software", "job-costing-software"],
    relatedTools: ["vat-calculator", "concrete-calculator", "brick-calculator"],
  },
  {
    slug: "vat-calculator",
    name: "VAT Calculator",
    navLabel: "VAT calculator",
    keyword: "VAT calculator UK",
    secondaryKeywords: ["add VAT calculator", "remove VAT calculator", "construction VAT calculator"],
    title: "UK VAT Calculator",
    metaDescription:
      "Free UK VAT calculator. Add VAT to a net figure or remove VAT from a gross figure at 20%, 5% or 0%. See the net, VAT and gross amounts instantly.",
    eyebrow: "Free tool",
    h1: "UK VAT Calculator",
    intro:
      "Add VAT to a net figure or strip it out of a gross one, at the 20% standard, 5% reduced or 0% rate. Useful for quoting, invoicing and checking a supplier's figures in seconds.",
    howItWorks: {
      h2: "How UK VAT is calculated",
      body: "To add VAT, multiply the net amount by the rate (20% → ×0.20) and add it on. To remove VAT from a gross amount, divide by 1 + the rate (gross ÷ 1.2 for 20%) to get the net, then the difference is the VAT. This tool does both.",
      bullets: [
        "Add VAT: VAT = net × rate; gross = net + VAT",
        "Remove VAT: net = gross ÷ (1 + rate); VAT = gross − net",
        "Standard rate 20%, reduced 5%, zero-rated 0%",
      ],
    },
    faqs: [
      { q: "How do I add 20% VAT to a price?", a: "Multiply the net price by 1.2. For example, £1,000 net becomes £1,200 gross, of which £200 is VAT. Enter the net figure and choose 'Add VAT' to see it." },
      { q: "How do I work out the VAT in a gross figure?", a: "Divide the gross amount by 1.2 (for 20%) to get the net, then subtract to find the VAT. £1,200 gross ÷ 1.2 = £1,000 net, so the VAT is £200. Choose 'Remove VAT' to do this automatically." },
      { q: "Does construction work always have 20% VAT?", a: "Not always — some construction work qualifies for reduced or zero rates, and the domestic reverse charge changes who accounts for the VAT on many B2B construction services. Check with your accountant or HMRC for your specific situation; this tool covers the standard, reduced and zero rates." },
    ],
    relatedFeatures: ["invoicing-software", "tax-software"],
    relatedTools: ["markup-calculator", "concrete-calculator", "brick-calculator"],
  },
  {
    slug: "concrete-calculator",
    name: "Concrete Calculator",
    navLabel: "Concrete calculator",
    keyword: "concrete calculator",
    secondaryKeywords: ["concrete volume calculator", "concrete bags calculator", "how much concrete do I need"],
    title: "Concrete Calculator (m³ & Bags)",
    metaDescription:
      "Free concrete calculator. Enter length, width and depth to get the volume in cubic metres, a 10% waste allowance, and an estimate of 20kg ready-mix bags needed.",
    eyebrow: "Free tool",
    h1: "Concrete Calculator",
    intro:
      "Work out how much concrete you need for a slab, base or footing. Enter the length, width and depth and get the volume in cubic metres, plus a sensible waste allowance and an estimate of how many 20kg bags of ready-mix that is.",
    howItWorks: {
      h2: "How the concrete volume is calculated",
      body: "Volume is simply length × width × depth, with the depth converted from millimetres to metres. We then add a 10% allowance for waste, spillage and uneven ground, and estimate bags using a yield of about 0.0095 m³ per 20kg bag of ready-mix concrete. For larger pours, ready-mixed delivery is usually cheaper than bags.",
      bullets: [
        "Volume (m³) = length × width × (depth ÷ 1000)",
        "+10% added for waste and uneven sub-base",
        "Bags estimated at ~0.0095 m³ per 20kg bag",
      ],
    },
    faqs: [
      { q: "How much concrete do I need for a slab?", a: "Multiply the slab's length × width × thickness (in metres) to get cubic metres. For a 5m × 3m slab at 100mm thick that's 1.5 m³. Always add ~10% for waste — this calculator does that for you." },
      { q: "How many 20kg bags of concrete in a cubic metre?", a: "Roughly 105–110 bags of 20kg ready-mix per cubic metre, depending on the mix. This tool uses about 0.0095 m³ per bag. For anything more than around half a cubic metre, ready-mixed delivery is usually more economical." },
      { q: "Should I add a waste allowance?", a: "Yes — always. Ground is rarely perfectly level and some concrete is lost to spillage and over-dig. A 10% allowance (included here) is a sensible default." },
    ],
    relatedFeatures: ["quoting-software", "expense-tracking"],
    relatedTools: ["brick-calculator", "markup-calculator", "vat-calculator"],
  },
  {
    slug: "brick-calculator",
    name: "Brick Calculator",
    navLabel: "Brick calculator",
    keyword: "brick calculator",
    secondaryKeywords: ["how many bricks per m2", "brick wall calculator", "bricks needed calculator"],
    title: "Brick Calculator (Bricks per m²)",
    metaDescription:
      "Free brick calculator. Enter wall length and height to get the number of standard UK bricks needed, for single or double skin, including a 10% wastage allowance.",
    eyebrow: "Free tool",
    h1: "Brick Calculator",
    intro:
      "Estimate how many bricks you need for a wall. Enter the length and height, choose single or double skin, and get the brick count for standard UK bricks — including a 10% allowance for cuts and breakages.",
    howItWorks: {
      h2: "How many bricks per square metre?",
      body: "For standard UK bricks (215 × 102.5 × 65mm) laid with 10mm mortar joints, you need about 60 bricks per square metre for a single-skin (half-brick) wall, and double that for a one-brick (double-skin) wall. We work out the wall area, apply 60 per m² per skin, and add 10% for waste.",
      bullets: [
        "Single skin: ~60 bricks per m²",
        "Double skin: ~120 bricks per m²",
        "+10% added for cuts and breakages",
      ],
    },
    faqs: [
      { q: "How many bricks are in a square metre?", a: "About 60 standard UK bricks per square metre for a single-skin wall (215 × 102.5 × 65mm bricks with 10mm joints), or roughly 120 per m² for a double-skin wall. This calculator applies that automatically." },
      { q: "Should I order extra bricks?", a: "Yes — always allow for waste from cuts, breakages and the odd reject. A 10% allowance is standard and is included in this calculator's total." },
      { q: "Does this work for blocks too?", a: "This tool is set up for standard UK bricks at 60 per m². Concrete blocks are larger (around 10 per m² for standard 440×215mm blocks), so a brick count won't apply — but the wall-area figure is still useful." },
    ],
    relatedFeatures: ["quoting-software", "job-costing-software"],
    relatedTools: ["concrete-calculator", "markup-calculator", "vat-calculator"],
  },
];

export const TOOL_BY_SLUG = new Map(TOOLS.map((t) => [t.slug, t]));

export function getTool(slug: string): ToolPage | undefined {
  return TOOL_BY_SLUG.get(slug);
}
