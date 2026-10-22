#!/usr/bin/env bash
#
# Boot the Supabase local stack for CI, retrying ONLY transient Docker
# image-registry / network pull failures.
#
# Why this exists
# ---------------
# The `integration` and `e2e` jobs each run `supabase start` in parallel, and
# each start pulls the full Supabase image set (postgres, gotrue, postgrest,
# realtime, storage-api, imgproxy, kong, edge-runtime, inbucket, pg-meta —
# ~10 images). GitHub-hosted runners share outbound IPs, so Docker Hub's
# anonymous pull-rate limit is consumed across many tenants and a pull can come
# back `toomanyrequests` (HTTP 429). When that happens the stack never boots and
# the whole REQUIRED job fails at "Start Supabase local stack" — before a single
# migration applies or a single test runs. That is an external-infrastructure
# flake, not a CrewFlow defect, and `supabase start` does not retry it itself.
#
# What this does — and deliberately does NOT do
# ---------------------------------------------
# It retries a SMALL, bounded number of times, with linear backoff, and ONLY
# when the captured output matches a NARROW set of registry/network signatures.
# Any other non-zero exit — a migration error, a config-parse error, a Postgres
# or Auth boot failure, a schema problem — is a REAL CI failure: it exits
# immediately, un-retried, with the start command's own status, so it stays
# loudly visible. This is explicitly NOT "retry until green": a genuine failure
# is never hidden, and even transient failures fail clearly once attempts are
# exhausted.
#
# Testability
# -----------
# Every external dependency is injectable so the four behaviours (success,
# retryable-then-retry, non-retryable-immediate-fail, exhaustion) can be proven
# locally without Docker and without real sleeps:
#   SUPABASE_START_CMD           command to boot the stack   (default: "supabase start")
#   SUPABASE_STOP_CMD            cleanup between attempts     (default: "supabase stop")
#   SUPABASE_START_MAX_ATTEMPTS  max attempts                 (default: 3)
#   SUPABASE_START_RETRY_BACKOFF backoff base seconds         (default: 15; delay = base*attempt)
set -uo pipefail

ATTEMPTS="${SUPABASE_START_MAX_ATTEMPTS:-3}"
BACKOFF="${SUPABASE_START_RETRY_BACKOFF:-15}"
START_CMD="${SUPABASE_START_CMD:-supabase start}"
STOP_CMD="${SUPABASE_STOP_CMD:-supabase stop}"

# Signatures that mean "the registry/network could not serve an image right now"
# — transient and safe to retry. Kept deliberately NARROW: none of these can be
# produced by a migration, SQL, config or application error.
RETRYABLE_REGEX='toomanyrequests|Too Many Requests|HTTP 429|statuscode: 429|status code 429|failed to pull docker image|error pulling image|pull access denied|download failed|manifest unknown: retry|TLS handshake timeout|i/o timeout|net/http: |connection reset by peer|unexpected EOF|dial tcp'

attempt=1
while : ; do
  echo "::group::supabase start (attempt ${attempt}/${ATTEMPTS})"
  out="$(mktemp)"
  # Stream to the log AND capture for classification. PIPESTATUS[0] is the
  # start command's own exit code (tee's success must not mask it).
  # shellcheck disable=SC2086
  ${START_CMD} 2>&1 | tee "${out}"
  status="${PIPESTATUS[0]}"
  echo "::endgroup::"

  if [ "${status}" -eq 0 ]; then
    rm -f "${out}"
    echo "supabase start succeeded on attempt ${attempt}."
    exit 0
  fi

  if grep -qiE "${RETRYABLE_REGEX}" "${out}"; then
    retryable=1
  else
    retryable=0
  fi
  rm -f "${out}"

  if [ "${retryable}" -eq 0 ]; then
    echo "supabase start failed (exit ${status}) with no transient registry/network signature."
    echo "Treating as a REAL failure (migration / config / database / application) — not retrying."
    exit "${status}"
  fi

  if [ "${attempt}" -ge "${ATTEMPTS}" ]; then
    echo "supabase start hit a transient registry/network failure on all ${ATTEMPTS} attempts (last exit ${status})."
    echo "Failing the job clearly rather than retrying indefinitely."
    exit "${status}"
  fi

  # Tear down any half-started stack so the retry begins from a clean slate.
  # shellcheck disable=SC2086
  ${STOP_CMD} >/dev/null 2>&1 || true

  delay="$(( BACKOFF * attempt ))"
  echo "Transient registry/network failure (exit ${status}) — retrying in ${delay}s (attempt $((attempt + 1))/${ATTEMPTS})."
  sleep "${delay}"
  attempt="$(( attempt + 1 ))"
done
