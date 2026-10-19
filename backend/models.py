"""Data shapes shared by the API and the context-gate agent."""

from typing import Literal

from pydantic import BaseModel, Field

Category = Literal["virtual_machine", "windows_server", "linux_server", "storage"]
Environment = Literal["production", "uat", "development", "dr"]

# The seven pieces of context an engineer needs before picking up a ticket.
SlotKey = Literal[
    "affected_object",
    "symptom",
    "start_time",
    "impact",
    "error_details",
    "recent_changes",
    "steps_taken",
]
SLOT_KEYS: tuple[str, ...] = SlotKey.__args__  # type: ignore[attr-defined]

# Without these an engineer cannot start work, so the gate never opens without them.
CORE_SLOTS = {"affected_object", "symptom", "start_time", "impact"}


class FollowUpAnswer(BaseModel):
    question: str = Field(max_length=300)
    answer: str = Field(max_length=1000)


class IncidentDraft(BaseModel):
    """What the customer has filled in so far."""

    category: Category
    affected_object: str = Field(min_length=1, max_length=120)
    environment: Environment
    description: str = Field(min_length=1, max_length=4000)
    follow_up_answers: list[FollowUpAnswer] = Field(default_factory=list, max_length=10)


class ContextSlot(BaseModel):
    key: SlotKey
    status: Literal["found", "partial", "missing"]
    evidence: str | None = Field(
        default=None,
        description="Short paraphrase (max ~15 words) of what the customer said for this slot. Null when missing.",
    )


class FollowUp(BaseModel):
    key: SlotKey = Field(description="The slot this question fills.")
    question: str = Field(description="One plain-language question for a non-technical customer.")
    why: str = Field(description="One short sentence on why the engineer needs this.")


class ContextAssessment(BaseModel):
    """The gate's verdict on whether an incident has enough context to be logged."""

    verdict: Literal["enough_context", "needs_more_context"]
    score: int = Field(ge=0, le=100, description="How complete the context is, 0-100.")
    slots: list[ContextSlot] = Field(description="Exactly one entry for each of the seven slot keys.")
    follow_ups: list[FollowUp] = Field(
        default_factory=list,
        max_length=3,
        description="Up to 3 questions, most important first. Empty when verdict is enough_context.",
    )
    customer_message: str = Field(description="One or two friendly sentences to the customer about the result.")
    engineer_summary: str = Field(
        description="A crisp 2-3 sentence summary an on-call engineer could act on, using only facts given."
    )
    suggested_priority: Literal["P1", "P2", "P3", "P4"]
    resolver_group: Literal[
        "Virtualisation", "Windows Server", "Linux", "Storage & Backup"
    ] = Field(description="Which Compute Services team should pick this up.")
