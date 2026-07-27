/**
 * Vitest setup for INTEGRATION tests.
 *
 * Deliberately does NOT inject fake Supabase credentials the way the unit
 * setup (__tests__/setup.ts) does. Integration tests need REAL connection
 * details from the environment:
 *
 *   SUPABASE_URL              (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_ANON_KEY         (or NEXT_PUBLIC_SUPABASE_ANON_KEY)
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * In CI these are exported from `supabase start`. Locally, if they are
 * absent the harness skips every integration test (see _harness.ts).
 */
import { vi } from "vitest";

// Let integration tests import server-only app modules without the
// "server-only" import guard throwing inside the Node test runner.
vi.mock("server-only", () => ({}));
