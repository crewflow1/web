# Integration tests — real Postgres (OQ-16)

These tests run against a **real database**, not mocked Supabase clients.
They apply the actual `supabase/migrations` and assert behaviour that unit
tests structurally cannot — Row-Level Security, `auth.*`, triggers,
constraints, and cross-tenant isolation.

This is the harness for **OQ-16** ("a real Postgres in CI") — the gap the
root CI (`.github/workflows/ci.yml`) documents but does not yet close, and
the prerequisite for IMPLEMENTATION-RULES gate #2 (Integration tests).

## How it runs

| Where | Database | Behaviour |
|-------|----------|-----------|
| CI | Supabase local stack (`supabase start`) | Required. A missing DB **fails** the run — no silent skips. |
| Local, DB configured | Whatever the env points at | Runs. |
| Local, no DB | — | Every suite **skips**, so `npm run test:integration` is safe anywhere. |

## Run locally

Requires Docker (for the Supabase stack) and the Supabase CLI:

```bash
supabase start            # boots Postgres + Auth + Storage, applies migrations
# export the URL + keys it prints (anon + service_role), then:
npm run test:integration
supabase stop
```

Without Docker the suite skips — that's expected; CI is the source of truth.

## Connection env

`SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`), `SUPABASE_ANON_KEY` (or
`NEXT_PUBLIC_SUPABASE_ANON_KEY`), and `SUPABASE_SERVICE_ROLE_KEY`.

## Writing a test

```ts
import { describeIntegration, serviceClient, anonClient } from "../_harness";
import { expect, it } from "vitest";

describeIntegration("my feature", () => {
  it("enforces RLS", async () => {
    const svc = serviceClient(); // bypasses RLS — set up fixtures
    const anon = anonClient(); // subject to RLS — assert denial
    // ...
  });
});
```

Use `serviceClient()` for fixtures/teardown, `anonClient()` / `userClient(jwt)`
to assert what each caller may see. Clean up rows you create — the database
persists across tests within a run.
