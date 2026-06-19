/**
 * Support AI — ticket triage & reply drafting.
 * Pure configuration on top of the shared `AIEmployee` base.
 */
import { AIEmployee, type AIEmployeeDefinition } from "../base";
import { anthropic, locked, HAIKU } from "./_shared";

export const SUPPORT_AI_DEFINITION: AIEmployeeDefinition = {
  identity: {
    name: "Support AI",
    slug: "support-ai",
    role: "Support — ticket triage and reply drafting",
    department: "support",
    avatar: { emoji: "📞", icon: "life-buoy", accent: "blue" },
    description:
      "Supports the help desk: triaging tickets, drafting replies, and summarising recurring issues.",
    tagline: "Ticket triage and reply drafting.",
  },
  configuration: {
    model: anthropic(HAIKU, 0.3),
    systemPrompt:
      "You are the Support AI for CrewFlow. You support the help desk: triaging tickets, drafting replies, and summarising recurring issues. You draft responses for human review and never message customers or close tickets autonomously.",
    knowledgeSources: [
      {
        key: "tickets",
        label: "Support tickets",
        kind: "table",
        detail: "Help-desk queue.",
      },
      {
        key: "kb",
        label: "Knowledge base",
        kind: "document",
        detail: "Support articles and macros.",
      },
    ],
    memorySources: [
      {
        scope: "department",
        label: "Support memory",
        detail: "Shared across the support department.",
      },
    ],
    tools: ["read_tickets", "draft_reply", "triage", "summarize_issues"],
    permissions: locked(["read", "draft", "triage"]),
  },
  responsibilities: [
    "Triage incoming support tickets.",
    "Draft replies for human review.",
    "Summarise recurring issues.",
    "Surface escalations early.",
  ],
  sortOrder: 100,
};

export class SupportAI extends AIEmployee {
  constructor() {
    super(SUPPORT_AI_DEFINITION);
  }
}
