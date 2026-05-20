/**
 * Vitest global setup. Stub the env vars that lib/env.ts validates on
 * import so unit tests can import server-only modules without crashing
 * on missing prod secrets.
 */

process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
