# @crewflow/api-client

Official **TypeScript** client for the CrewFlow Public API (v1).

> Generated from the OpenAPI spec (`lib/public-api/openapi.ts`) by
> `npx tsx sdks/generate.ts`. Do not edit the generated sources by hand — run
> the generator and commit the result. A spec-consistency test fails on drift.

## Install & build

This package ships source; build the JS + types with:

```bash
cd sdks/typescript
npm install   # no runtime dependencies; dev-only TypeScript
npm run build
```

## Usage

```ts
import { CrewFlowClient } from "@crewflow/api-client";

const client = new CrewFlowClient({ apiKey: process.env.CREWFLOW_API_KEY! });

const jobs = await client.getJobs({ page: 1, per_page: 25 });
for (const job of jobs.data ?? []) {
  console.log(job.id, job.status);
}

const created = await client.postCustomers({ name: "Acme Ltd" });
console.log(created.data?.id);
```

Every method is Bearer-authenticated with your key and scoped server-side to the
key's organisation. Non-2xx responses throw `CrewFlowApiError` (carrying
`.status` and the parsed `.body`).

## Operations

| Method | HTTP | Scopes |
| --- | --- | --- |
| `getMe` | `GET /me` | — |
| `getJobs` | `GET /jobs` | `read:jobs` |
| `postJobs` | `POST /jobs` | `write:jobs` |
| `getJobsById` | `GET /jobs/{id}` | `read:jobs` |
| `patchJobsById` | `PATCH /jobs/{id}` | `write:jobs` |
| `getCustomers` | `GET /customers` | `read:customers` |
| `postCustomers` | `POST /customers` | `write:customers` |
| `getCustomersById` | `GET /customers/{id}` | `read:customers` |
| `patchCustomersById` | `PATCH /customers/{id}` | `write:customers` |
| `postLeads` | `POST /leads` | `write:leads` |
| `getInvoices` | `GET /invoices` | `read:invoices` |
| `getQuotes` | `GET /quotes` | `read:quotes` |
| `postQuotes` | `POST /quotes` | `write:quotes` |
