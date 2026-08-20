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
    "TimeEntry",
    "TimeEntryList",
    "StaffMember",
    "StaffMemberList",
    "Expense",
    "ExpenseList",
    "MaterialRequest",
    "MaterialRequestList",
    "CustomerWriteInput",
    "CustomerUpdateInput",
    "LeadWriteInput",
    "JobWriteInput",
    "JobUpdateInput",
    "QuoteLineItemInput",
    "QuoteWriteInput",
    "ExpenseWriteInput",
    "ExpenseUpdateInput",
    "InvoiceUpdateInput",
    "GetMeResponse",
    "PostJobsResponse",
    "GetJobsByIdResponse",
    "PatchJobsByIdResponse",
    "PostCustomersResponse",
    "GetCustomersByIdResponse",
    "PatchCustomersByIdResponse",
    "PostLeadsResponse",
    "GetInvoicesByIdResponse",
    "PatchInvoicesByIdResponse",
    "PostQuotesResponse",
    "PostExpensesResponse",
    "GetExpensesByIdResponse",
    "PatchExpensesByIdResponse",
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


class TimeEntry(TypedDict, total=False):
    id: Optional[str]
    started_at: Optional[str]
    ended_at: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]


class TimeEntryList(TypedDict, total=False):
    """Required keys: data, pagination."""
    data: List["TimeEntry"]
    pagination: Dict[str, Any]


class StaffMember(TypedDict, total=False):
    id: Optional[str]
    role: Optional[str]
    created_at: Optional[str]


class StaffMemberList(TypedDict, total=False):
    """Required keys: data, pagination."""
    data: List["StaffMember"]
    pagination: Dict[str, Any]


class Expense(TypedDict, total=False):
    id: Optional[str]
    amount: Optional[float]
    currency: Optional[str]
    vat_rate: Optional[float]
    vat_total: Optional[float]
    category: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]


class ExpenseList(TypedDict, total=False):
    """Required keys: data, pagination."""
    data: List["Expense"]
    pagination: Dict[str, Any]


class MaterialRequest(TypedDict, total=False):
    id: Optional[str]
    number: Optional[str]
    status: Optional[str]
    priority: Optional[str]
    needed_by: Optional[str]
    submitted_at: Optional[str]
    decided_at: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]


class MaterialRequestList(TypedDict, total=False):
    """Required keys: data, pagination."""
    data: List["MaterialRequest"]
    pagination: Dict[str, Any]


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


class ExpenseWriteInput(TypedDict, total=False):
    """Record a cost. vat_total is computed server-side (amount * vat_rate) and can never be sent. Currency is fixed to GBP. Required keys: amount."""
    amount: float
    vat_rate: Literal[0, 5, 20]
    category: str
    notes: str
    job_id: str


class ExpenseUpdateInput(TypedDict, total=False):
    """At least one field must be provided. Omitted fields are left unchanged. job_id and vat_total are not updatable."""
    amount: float
    vat_rate: Literal[0, 5, 20]
    category: str
    notes: str


class InvoiceUpdateInput(TypedDict, total=False):
    """Update invoice status and metadata. Money columns (amount, vat_total, total, number) are not writable. 'overdue' is derived, not stored, and is rejected. At least one field must be provided."""
    status: Literal["draft", "sent", "awaiting_payment", "partially_paid", "paid"]
    due_date: str
    notes: str


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


class GetInvoicesByIdResponse(TypedDict, total=False):
    data: "Invoice"


class PatchInvoicesByIdResponse(TypedDict, total=False):
    data: "Invoice"


class PostQuotesResponse(TypedDict, total=False):
    data: "Quote"


class PostExpensesResponse(TypedDict, total=False):
    data: "Expense"


class GetExpensesByIdResponse(TypedDict, total=False):
    data: "Expense"


class PatchExpensesByIdResponse(TypedDict, total=False):
    data: "Expense"
