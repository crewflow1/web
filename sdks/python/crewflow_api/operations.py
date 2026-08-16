"""
CrewFlow API client — GENERATED, DO NOT EDIT.
Regenerate with `npx tsx sdks/generate.ts` (source of truth:
lib/public-api/openapi.ts). Edits are overwritten and the
spec-consistency test (__tests__/openapi-sdk) will fail on drift.
"""

from __future__ import annotations

from typing import Dict, List, TypedDict


class OperationDescriptor(TypedDict):
    """One operation the API exposes: HTTP method, templated path, scopes."""

    method: str
    path: str
    scopes: List[str]


#: Every operation, keyed by operationId (mirrors the OpenAPI paths).
OPERATIONS: Dict[str, OperationDescriptor] = {
    "getMe": {"method": "get", "path": "/me", "scopes": []},
    "getJobs": {"method": "get", "path": "/jobs", "scopes": ["read:jobs"]},
    "postJobs": {"method": "post", "path": "/jobs", "scopes": ["write:jobs"]},
    "getJobsById": {"method": "get", "path": "/jobs/{id}", "scopes": ["read:jobs"]},
    "patchJobsById": {"method": "patch", "path": "/jobs/{id}", "scopes": ["write:jobs"]},
    "getCustomers": {"method": "get", "path": "/customers", "scopes": ["read:customers"]},
    "postCustomers": {"method": "post", "path": "/customers", "scopes": ["write:customers"]},
    "getCustomersById": {"method": "get", "path": "/customers/{id}", "scopes": ["read:customers"]},
    "patchCustomersById": {"method": "patch", "path": "/customers/{id}", "scopes": ["write:customers"]},
    "postLeads": {"method": "post", "path": "/leads", "scopes": ["write:leads"]},
    "getInvoices": {"method": "get", "path": "/invoices", "scopes": ["read:invoices"]},
    "getQuotes": {"method": "get", "path": "/quotes", "scopes": ["read:quotes"]},
    "postQuotes": {"method": "post", "path": "/quotes", "scopes": ["write:quotes"]},
}
