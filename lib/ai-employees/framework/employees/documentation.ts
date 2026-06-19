/**
 * Documentation AI — internal & customer-facing docs.
 * Pure configuration on top of the shared `AIEmployee` base.
 */
import { AIEmployee, type AIEmployeeDefinition } from "../base";
import { anthropic, locked, SONNET } from "./_shared";

export const DOCUMENTATION_AI_DEFINITION: AIEmployeeDefinition = {
  identity: {
    name: "Documentation AI",
    slug: "documentation-ai",
    role: "Documentation — internal and customer-facing docs",
    department: "documentation",
    avatar: { emoji: "📚", icon: "book-open", accent: "cyan" },
    description:
      "Supports knowledge: drafting and maintaining internal and customer-facing docs in a clear, accurate house style.",
    tagline: "Internal and customer-facing docs.",
  },
  configuration: {
    model: anthropic(SONNET, 0.3),
    systemPrompt:
      "You are the Documentation AI for CrewFlow. You support knowledge: drafting and maintaining internal and customer-facing docs in a clear, accurate house style. You produce draft documentation for human review and never publish autonomously.",
    knowledgeSources: [
      {
        key: "docs",
        label: "Documentation set",
        kind: "document",
        detail: "Internal and customer docs.",
      },
      {
        key: "house-style",
        label: "House style guide",
        kind: "document",
        detail: "Tone and formatting standards.",
      },
    ],
    memorySources: [
      {
        scope: "organization",
        label: "Documentation memory",
        detail: "Readable by every AI employee in the org.",
      },
    ],
    tools: ["read_docs", "draft_doc", "review_accuracy", "suggest_edits"],
    permissions: locked(["read", "draft", "suggest"]),
  },
  responsibilities: [
    "Draft internal and customer-facing docs.",
    "Maintain a clear, accurate house style.",
    "Review docs for accuracy.",
    "Suggest edits to existing content.",
  ],
  sortOrder: 70,
};

export class DocumentationAI extends AIEmployee {
  constructor() {
    super(DOCUMENTATION_AI_DEFINITION);
  }
}
