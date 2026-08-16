"""
CrewFlow API client — GENERATED, DO NOT EDIT.
Regenerate with `npx tsx sdks/generate.ts` (source of truth:
lib/public-api/openapi.ts). Edits are overwritten and the
spec-consistency test (__tests__/openapi-sdk) will fail on drift.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, TypedDict, Union

__all__ = [
    "Job",
    "JobList",
    "Customer",
    "CustomerList",
    "Invoice",
    "InvoiceList",
    "Quote",
    "QuoteList",
    "Lead",
    "CustomerWriteInput",
    "CustomerUpdateInput",
    "LeadWriteInput",
    "JobWriteInput",
    "JobUpdateInput",
    "QuoteLineItemInput",
    "QuoteWriteInput",
    "GetMeResponse",
    "PostJobsResponse",
    "GetJobsByIdResponse",
    "PatchJobsByIdResponse",
    "PostCustomersResponse",
    "GetCustomersByIdResponse",
    "PatchCustomersByIdResponse",
    "PostLeadsResponse",
    "PostQuotesResponse",
]


class Job(TypedDict, total=False):
    id: Optional[str]
    status: Optional[str]
    scheduled_date: Optional[str]
    site_postcode: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]


class JobList(TypedDict, total=False):
    """Required keys: data, pagination."""
    data: List["Job"]
    pagination: Dict[str, Any]


class Customer(TypedDict, total=False):
    id: Optional[str]
    name: Optional[str]
    city: Optional[str]
    county: Optional[str]
    postcode: Optional[str]
    country: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]


class CustomerList(TypedDict, total=False):
    """Required keys: data, pagination."""
    data: List["Customer"]
    pagination: Dict[str, Any]


class Invoice(TypedDict, total=False):
    id: Optional[str]
    number: Optional[str]
    status: Optional[str]
    amount: Optional[float]
    vat_total: Optional[float]
    total: Optional[float]
    due_date: Optional[str]
    sent_at: Optional[str]
    paid_at: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]


class InvoiceList(TypedDict, total=False):
    """Required keys: data, pagination."""
    data: List["Invoice"]
    pagination: Dict[str, Any]


class Quote(TypedDict, total=False):
    id: Optional[str]
    number: Optional[str]
    status: Optional[str]
    currency: Optional[str]
    subtotal: Optional[float]
    vat_total: Optional[float]
    total: Optional[float]
    valid_until: Optional[str]
    sent_at: Optional[str]
    accepted_at: Optional[str]
    declined_at: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]


class QuoteList(TypedDict, total=False):
    """Required keys: data, pagination."""
    data: List["Quote"]
    pagination: Dict[str, Any]


class Lead(TypedDict, total=False):
    id: Optional[str]
    source: Optional[str]
    service: Optional[str]
    status: Optional[str]
    urgency: Optional[str]
    estimated_value: Optional[float]
    postcode: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]


class CustomerWriteInput(TypedDict, total=False):
    """Required keys: name."""
    name: str
    email: str
    phone: str
    address_line1: str
    address_line2: str
    city: str
    county: str
    postcode: str
    country: str
    notes: str


class CustomerUpdateInput(TypedDict, total=False):
    """At least one field must be provided. Omitted fields are left unchanged."""
    name: str
    email: str
    phone: str
    address_line1: str
    address_line2: str
    city: str
    county: str
    postcode: str
    country: str
    notes: str


class LeadWriteInput(TypedDict, total=False):
    """At least one of contact_email or contact_phone is required. Required keys: contact_name, source."""
    contact_name: str
    contact_email: str
    contact_phone: str
    source: Literal["phone", "web", "referral", "walk_in", "social", "repeat", "portal", "other"]
    service: str
    urgency: Literal["low", "normal", "high", "urgent"]
    postcode: str
    estimated_value: float
    notes: str
    customer_id: str


class JobWriteInput(TypedDict, total=False):
    status: Literal["new", "in-progress", "completed", "blocked"]
    scheduled_date: str
    customer_id: str
    notes: str
    site_address_line1: str
    site_address_line2: str
    site_city: str
    site_county: str
    site_postcode: str
    site_country: str


class JobUpdateInput(TypedDict, total=False):
    """At least one field must be provided. Omitted fields are left unchanged."""
    status: Literal["new", "in-progress", "completed", "blocked"]
    scheduled_date: str
    customer_id: str
    notes: str
    site_address_line1: str
    site_address_line2: str
    site_city: str
    site_county: str
    site_postcode: str
    site_country: str


class QuoteLineItemInput(TypedDict, total=False):
    """Required keys: description, qty, unit_price, vat_rate."""
    description: str
    qty: float
    unit: str
    unit_price: float
    vat_rate: Literal[0, 5, 20]


class QuoteWriteInput(TypedDict, total=False):
    """Totals (subtotal, vat_total, total) are computed server-side from the line items — never send them. Required keys: customer_id, line_items."""
    customer_id: str
    property_id: str
    lead_id: str
    valid_until: str
    notes: str
    terms: str
    line_items: List["QuoteLineItemInput"]


class GetMeResponse(TypedDict, total=False):
    org_id: str
    key_prefix: str
    scopes: List[str]


class PostJobsResponse(TypedDict, total=False):
    data: "Job"


class GetJobsByIdResponse(TypedDict, total=False):
    data: "Job"


class PatchJobsByIdResponse(TypedDict, total=False):
    data: "Job"


class PostCustomersResponse(TypedDict, total=False):
    data: "Customer"


class GetCustomersByIdResponse(TypedDict, total=False):
    data: "Customer"


class PatchCustomersByIdResponse(TypedDict, total=False):
    data: "Customer"


class PostLeadsResponse(TypedDict, total=False):
    data: "Lead"


class PostQuotesResponse(TypedDict, total=False):
    data: "Quote"
