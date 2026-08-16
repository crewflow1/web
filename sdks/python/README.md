# crewflow-api (Python)

Official **Python** client for the CrewFlow Public API (v1). Standard library only — no
runtime dependencies.

> Generated from the OpenAPI spec (`lib/public-api/openapi.ts`) by
> `npx tsx sdks/generate.ts`. Do not edit the generated sources by hand — run
> the generator and commit the result. A spec-consistency test fails on drift.

## Install

```bash
cd sdks/python
pip install -e .
```

## Usage

```python
import os
from crewflow_api import CrewFlowClient

client = CrewFlowClient(api_key=os.environ["CREWFLOW_API_KEY"])

jobs = client.getJobs(page=1, per_page=25)
for job in jobs["data"]:
    print(job["id"], job["status"])
```

Every method is Bearer-authenticated with your key and scoped server-side to the
key's organisation. Non-2xx responses raise `CrewFlowApiError` (carrying
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
