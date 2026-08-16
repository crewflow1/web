# CrewFlow SDKs

Official client SDKs for the [CrewFlow public API](../lib/public-api/openapi.ts),
**generated from the OpenAPI 3.1 spec** — never hand-written per endpoint.

| Language | Package | Path |
| --- | --- | --- |
| TypeScript | `@crewflow/api-client` | [`typescript/`](./typescript) |
| Python | `crewflow-api` | [`python/`](./python) |

Both clients are zero-runtime-dependency: the TypeScript client uses the
platform `fetch`, the Python client uses only the standard library.

## How it works

`lib/public-api/openapi.ts` (`buildOpenApiDocument()`) is the single source of
truth. The generator reads that document and emits the complete client packages:

```
lib/public-api/openapi.ts  ──►  sdks/src/generator.ts  ──►  sdks/typescript/**
      (OpenAPI 3.1)              (pure, deterministic)        sdks/python/**
```

The generator (`sdks/src/generator.ts`) is **pure** — no env, no I/O, no clock.
The only thing that touches the filesystem is the CLI, `sdks/generate.ts`.

## Regenerate

After any change to the API spec, regenerate and commit:

```bash
npx tsx sdks/generate.ts
```

Verify there is no uncommitted drift (used in CI/dev):

```bash
npx tsx sdks/generate.ts --check
```

## Consistency guarantee

The everything-generated design means the checked-in clients can never silently
diverge from the API. The vitest spec-consistency smoke test
(`__tests__/openapi-sdk/spec-consistency.test.ts`) enforces this on every run:

- **Drift** — regenerates every file in-memory and asserts byte-equality with
  what is committed.
- **Typed paths** — asserts both clients' operation maps cover *exactly* the
  method + path set the OpenAPI `paths` describe.
- **Models** — asserts every component schema has a generated type in both
  clients.

## Publishing

Publishing to npm / PyPI is a **release step** and is intentionally out of scope
here — this workspace only holds the generated, buildable clients in-repo.
