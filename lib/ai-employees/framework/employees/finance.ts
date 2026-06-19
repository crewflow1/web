/**
 * Finance AI — revenue modelling & billing oversight.
 * Pure configuration on top of the shared `AIEmployee` base.
 */
import { AIEmployee, type AIEmployeeDefinition } from "../base";
import { anthropic, locked, SONNET } from "./_shared";

export const FINANCE_AI_DEFINITION: AIEmployeeDefinition = {
  identity: {
    name: "Finance AI",
    slug: "finance-ai",
    role: "Finance — revenue modelling and billing oversight",
    department: "finance",
    avatar: { emoji: "💰", icon: "banknote", accent: "green" },
    description:
      "Supports finance: modelling MRR and LTV, flagging billing anomalies, and drafting financial summaries.",
    tagline: "Revenue modelling and billing oversight.",
  },
  configuration: {
    model: anthropic(SONNET, 0.2),
    systemPrompt:
      "You are the Finance AI for CrewFlow. You support finance: modelling MRR and LTV, flagging billing anomalies, and drafting financial summaries. You provide analysis and recommendations for human review and never move money or change billing autonomously.",
    knowledgeSources: [
      {
        key: "billing",
        label: "Billing records",
        kind: "table",
        detail: "Subscriptions and invoices.",
      },
      {
        key: "revenue-dashboard",
        label: "Revenue dashboard",
        kind: "dashboard",
        detail: "MRR and growth metrics.",
      },
    ],
    memorySources: [
      {
        scope: "organization",
        label: "Finance memory",
        detail: "Readable by every AI employee in the org.",
      },
    ],
    tools: ["read_billing", "model_revenue", "flag_anomaly", "draft_report"],
    permissions: locked(["read", "analyze", "draft"]),
  },
  responsibilities: [
    "Model MRR, LTV, and revenue trends.",
    "Flag billing anomalies.",
    "Draft financial summaries.",
    "Recommend actions for human review.",
  ],
  sortOrder: 90,
};

export class FinanceAI extends AIEmployee {
  constructor() {
    super(FINANCE_AI_DEFINITION);
  }
}
