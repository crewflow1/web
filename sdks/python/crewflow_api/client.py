"""
CrewFlow API client — GENERATED, DO NOT EDIT.
Regenerate with `npx tsx sdks/generate.ts` (source of truth:
lib/public-api/openapi.ts). Edits are overwritten and the
spec-consistency test (__tests__/openapi-sdk) will fail on drift.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

from .models import (
    GetMeResponse,
    JobList,
    JobWriteInput,
    PostJobsResponse,
    GetJobsByIdResponse,
    JobUpdateInput,
    PatchJobsByIdResponse,
    CustomerList,
    CustomerWriteInput,
    PostCustomersResponse,
    GetCustomersByIdResponse,
    CustomerUpdateInput,
    PatchCustomersByIdResponse,
    LeadWriteInput,
    PostLeadsResponse,
    InvoiceList,
    QuoteList,
    QuoteWriteInput,
    PostQuotesResponse,
)
from .operations import OPERATIONS

DEFAULT_BASE_URL = "https://app.crewflow.uk/api/v1"


class CrewFlowApiError(Exception):
    """Raised on any non-2xx response; carries the status and parsed body."""

    def __init__(self, status: int, body: Any, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class CrewFlowClient:
    """Official Python client for the CrewFlow public API.

    One method per OpenAPI operation, generated from the spec. Bearer-
    authenticated with your API key; every request is scoped server-side to
    the key's organisation. Uses only the Python standard library.
    """

    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL) -> None:
        if not api_key:
            raise ValueError("CrewFlowClient requires an api_key.")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    def getMe(self) -> GetMeResponse:
        """GET /me — The identity the API key carries."""
        return self._request(OPERATIONS["getMe"]["method"], "/me", None, None)  # type: ignore[return-value]

    def getJobs(self, page: Optional[int] = None, per_page: Optional[int] = None) -> JobList:
        """GET /jobs — List jobs. Requires scope: read:jobs."""
        return self._request(OPERATIONS["getJobs"]["method"], "/jobs", {"page": page, "per_page": per_page}, None)  # type: ignore[return-value]

    def postJobs(self, body: JobWriteInput) -> PostJobsResponse:
        """POST /jobs — Create a job. Requires scope: write:jobs."""
        return self._request(OPERATIONS["postJobs"]["method"], "/jobs", None, body)  # type: ignore[return-value]

    def getJobsById(self, id: str) -> GetJobsByIdResponse:
        """GET /jobs/{id} — Fetch a single job by id. Requires scope: read:jobs."""
        return self._request(OPERATIONS["getJobsById"]["method"], f"/jobs/{urllib.parse.quote(str(id))}", None, None)  # type: ignore[return-value]

    def patchJobsById(self, id: str, body: JobUpdateInput) -> PatchJobsByIdResponse:
        """PATCH /jobs/{id} — Update a job. Requires scope: write:jobs."""
        return self._request(OPERATIONS["patchJobsById"]["method"], f"/jobs/{urllib.parse.quote(str(id))}", None, body)  # type: ignore[return-value]

    def getCustomers(self, page: Optional[int] = None, per_page: Optional[int] = None) -> CustomerList:
        """GET /customers — List customers. Requires scope: read:customers."""
        return self._request(OPERATIONS["getCustomers"]["method"], "/customers", {"page": page, "per_page": per_page}, None)  # type: ignore[return-value]

    def postCustomers(self, body: CustomerWriteInput) -> PostCustomersResponse:
        """POST /customers — Create a customer. Requires scope: write:customers."""
        return self._request(OPERATIONS["postCustomers"]["method"], "/customers", None, body)  # type: ignore[return-value]

    def getCustomersById(self, id: str) -> GetCustomersByIdResponse:
        """GET /customers/{id} — Fetch a single customer by id. Requires scope: read:customers."""
        return self._request(OPERATIONS["getCustomersById"]["method"], f"/customers/{urllib.parse.quote(str(id))}", None, None)  # type: ignore[return-value]

    def patchCustomersById(self, id: str, body: CustomerUpdateInput) -> PatchCustomersByIdResponse:
        """PATCH /customers/{id} — Update a customer. Requires scope: write:customers."""
        return self._request(OPERATIONS["patchCustomersById"]["method"], f"/customers/{urllib.parse.quote(str(id))}", None, body)  # type: ignore[return-value]

    def postLeads(self, body: LeadWriteInput) -> PostLeadsResponse:
        """POST /leads — Capture a lead. Requires scope: write:leads."""
        return self._request(OPERATIONS["postLeads"]["method"], "/leads", None, body)  # type: ignore[return-value]

    def getInvoices(self, page: Optional[int] = None, per_page: Optional[int] = None) -> InvoiceList:
        """GET /invoices — List invoices. Requires scope: read:invoices."""
        return self._request(OPERATIONS["getInvoices"]["method"], "/invoices", {"page": page, "per_page": per_page}, None)  # type: ignore[return-value]

    def getQuotes(self, page: Optional[int] = None, per_page: Optional[int] = None) -> QuoteList:
        """GET /quotes — List quotes. Requires scope: read:quotes."""
        return self._request(OPERATIONS["getQuotes"]["method"], "/quotes", {"page": page, "per_page": per_page}, None)  # type: ignore[return-value]

    def postQuotes(self, body: QuoteWriteInput) -> PostQuotesResponse:
        """POST /quotes — Create a draft quote. Requires scope: write:quotes."""
        return self._request(OPERATIONS["postQuotes"]["method"], "/quotes", None, body)  # type: ignore[return-value]

    def _request(
        self,
        method: str,
        path: str,
        query: Optional[dict] = None,
        body: Any = None,
    ) -> Any:
        """Execute one request, applying auth, query, body and error mapping."""
        url = self.base_url + path
        if query:
            filtered = {k: v for k, v in query.items() if v is not None}
            if filtered:
                url = url + "?" + urllib.parse.urlencode(filtered)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
        }
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            url, data=data, headers=headers, method=method.upper()
        )
        try:
            with urllib.request.urlopen(request) as response:  # noqa: S310
                text = response.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8") if exc.fp is not None else ""
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = raw
            raise CrewFlowApiError(
                exc.code,
                parsed,
                f"CrewFlow API {method.upper()} {path} failed with {exc.code}",
            ) from exc
