"""
CrewFlow API client — GENERATED, DO NOT EDIT.
Regenerate with `npx tsx sdks/generate.ts` (source of truth:
lib/public-api/openapi.ts). Edits are overwritten and the
spec-consistency test (__tests__/openapi-sdk) will fail on drift.
"""

from .client import CrewFlowApiError, CrewFlowClient, DEFAULT_BASE_URL
from .operations import OPERATIONS

__version__ = "1.0.0"

__all__ = [
    "CrewFlowClient",
    "CrewFlowApiError",
    "DEFAULT_BASE_URL",
    "OPERATIONS",
    "__version__",
]
