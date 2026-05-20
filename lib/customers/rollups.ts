/**
 * Pure roll-up helpers for the customer profile page. Mostly exists so we
 * can unit-test the math without spinning up a full Next.js page renderer.
 */

export type InvoiceForRollup = {
  status: string;
  total: number | string | null;
};

export type PaymentForRollup = {
  amount: number | string | null;
};

export type CustomerRollups = {
  totalInvoiced: number;
  totalPaid: number;
  outstanding: number;
  lifetimeRevenue: number;
};

export function computeCustomerRollups(
  invoices: InvoiceForRollup[],
  payments: PaymentForRollup[],
): CustomerRollups {
  const totalInvoiced = sum(invoices.map((i) => Number(i.total ?? 0)));
  const totalPaid = sum(payments.map((p) => Number(p.amount ?? 0)));
  const outstanding = Math.max(0, totalInvoiced - totalPaid);
  const lifetimeRevenue = sum(
    invoices.filter((i) => i.status === "paid").map((i) => Number(i.total ?? 0)),
  );
  return {
    totalInvoiced: round2(totalInvoiced),
    totalPaid: round2(totalPaid),
    outstanding: round2(outstanding),
    lifetimeRevenue: round2(lifetimeRevenue),
  };
}

function sum(arr: number[]): number {
  return arr.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type TimelineSource = {
  when: string;
  kind: string;
  label: string;
};

export function sortTimelineDesc<T extends TimelineSource>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.when < b.when ? 1 : -1));
}
