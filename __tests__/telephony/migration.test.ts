import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Phase 5A telephony migration contract.
 *
 * Pins the shape of 20260630000000_phase5a_telephony.sql:
 *   1. phone_numbers is created with org FK (cascade) and an HQ-only
 *      RLS posture (SELECT for members, NO write policies).
 *   2. e164 is UNIQUE (one number → one org) while org_id is NOT unique
 *      (one org → many numbers).
 *   3. The EXISTING calls table is only ALTERed (never recreated), gains
 *      phone_number_id, and a PARTIAL UNIQUE index for idempotent upserts.
 */

const ROOT = resolve(__dirname, "..", "..");
const SQL = readFileSync(
  resolve(ROOT, "supabase/migrations/20260630000000_phase5a_telephony.sql"),
  "utf8",
);

describe("phone_numbers table", () => {
  it("is created idempotently with an org FK that cascades", () => {
    expect(SQL).toMatch(/create table if not exists public\.phone_numbers/);
    expect(SQL).toMatch(
      /org_id\s+uuid not null references public\.organizations\(id\) on delete cascade/,
    );
  });

  it("makes e164 UNIQUE but org_id only indexed (one org → many numbers)", () => {
    expect(SQL).toMatch(
      /create unique index if not exists phone_numbers_e164_unique\s+on public\.phone_numbers \(e164\)/,
    );
    expect(SQL).toMatch(
      /create index if not exists phone_numbers_org_idx\s+on public\.phone_numbers \(org_id\)/,
    );
    // org_id must NOT be unique — that would forbid a second number.
    expect(SQL).not.toMatch(/unique index[^\n]*phone_numbers[^\n]*\(org_id\)/);
  });

  it("constrains provider + status to known values", () => {
    expect(SQL).toMatch(/provider[\s\S]*check \(provider in \('vapi', 'twilio'\)\)/);
    expect(SQL).toMatch(/status[\s\S]*check \(status in \('active', 'inactive'\)\)/);
  });

  it("bumps updated_at via the shared trigger", () => {
    expect(SQL).toMatch(/execute function public\.tg_set_updated_at\(\)/);
  });
});

describe("phone_numbers RLS — members read, service-role writes", () => {
  it("enables RLS and grants members SELECT on their own org", () => {
    expect(SQL).toMatch(
      /alter table public\.phone_numbers enable row level security/,
    );
    expect(SQL).toMatch(
      /create policy phone_numbers_select on public\.phone_numbers\s+for select to authenticated\s+using \(org_id in \(select public\.current_org_ids\(\)\)\)/,
    );
  });

  it("installs NO insert/update/delete policies (writes are service-role only)", () => {
    expect(SQL).not.toMatch(/create policy[^\n]*phone_numbers[^\n]*for insert/i);
    expect(SQL).not.toMatch(/create policy[^\n]*phone_numbers[^\n]*for update/i);
    expect(SQL).not.toMatch(/create policy[^\n]*phone_numbers[^\n]*for delete/i);
  });
});

describe("calls table — additive only, never recreated", () => {
  it("does NOT create (or replace) the calls table", () => {
    expect(SQL).not.toMatch(/create table[^\n]*\bcalls\b/i);
    expect(SQL).not.toMatch(/drop table[^\n]*\bcalls\b/i);
  });

  it("adds phone_number_id linking a call to the matched number (SET NULL)", () => {
    expect(SQL).toMatch(
      /alter table public\.calls\s+add column if not exists phone_number_id uuid\s+references public\.phone_numbers\(id\) on delete set null/,
    );
  });

  it("adds a PARTIAL unique index on (provider, provider_call_id) for idempotency", () => {
    expect(SQL).toMatch(
      /create unique index if not exists calls_provider_call_id_unique\s+on public\.calls \(provider, provider_call_id\)\s+where provider_call_id is not null/,
    );
  });
});
