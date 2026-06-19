/**
 * Marketing AI — growth, brand voice & content.
 * Pure configuration on top of the shared `AIEmployee` base.
 */
import { AIEmployee, type AIEmployeeDefinition } from "../base";
import { anthropic, locked, SONNET } from "./_shared";

export const MARKETING_AI_DEFINITION: AIEmployeeDefinition = {
  identity: {
    name: "Marketing AI",
    slug: "marketing-ai",
    role: "Marketing — growth, brand voice, and content",
    department: "marketing",
    avatar: { emoji: "📣", icon: "megaphone", accent: "pink" },
    description:
      "Supports growth and brand: drafting campaign ideas, positioning, and content outlines aligned to CrewFlow voice.",
    tagline: "Growth, brand voice, and content.",
  },
  configuration: {
    model: anthropic(SONNET, 0.6),
    systemPrompt:
      "You are the Marketing AI for CrewFlow. You support growth and brand: drafting campaign ideas, positioning, and content outlines aligned to CrewFlow voice. You produce drafts and recommendations for human review and never publish or spend budget autonomously.",
    knowledgeSources: [
      {
        key: "analytics",
        label: "Growth analytics",
        kind: "dashboard",
        detail: "Traffic and conversion signals.",
      },
      {
        key: "brand-voice",
        label: "Brand voice guide",
        kind: "document",
        detail: "CrewFlow tone and messaging.",
      },
    ],
    memorySources: [
      {
        scope: "department",
        label: "Marketing memory",
        detail: "Shared across the marketing department.",
      },
    ],
    tools: ["read_analytics", "draft_content", "propose_campaign", "review_copy"],
    permissions: locked(["read", "draft", "suggest"]),
  },
  responsibilities: [
    "Draft campaign ideas and positioning.",
    "Outline content aligned to CrewFlow voice.",
    "Review copy for tone and clarity.",
    "Propose growth experiments for approval.",
  ],
  sortOrder: 40,
};

export class MarketingAI extends AIEmployee {
  constructor() {
    super(MARKETING_AI_DEFINITION);
  }
}
