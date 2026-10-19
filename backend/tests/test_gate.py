"""Tests run without an API key: FunctionModel stands in for Claude."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelResponse, RetryPromptPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

import main
from models import SLOT_KEYS


def _slots(**overrides):
    status = {k: "missing" for k in SLOT_KEYS}
    status.update(overrides)
    return [{"key": k, "status": v, "evidence": None if v == "missing" else "x"} for k, v in status.items()]


def _payload(verdict, slots, follow_ups=()):
    return {
        "verdict": verdict,
        "score": 40,
        "slots": slots,
        "follow_ups": list(follow_ups),
        "customer_message": "msg",
        "engineer_summary": "summary",
        "suggested_priority": "P3",
        "resolver_group": "Virtualisation",
    }


VAGUE = _payload(
    "needs_more_context",
    _slots(affected_object="found", symptom="partial"),
    [{"key": "start_time", "question": "When did it start?", "why": "To match logs."}],
)
GOOD_SLOTS = _slots(
    affected_object="found", symptom="found", start_time="found", impact="found",
    error_details="found", recent_changes="found",
)
DRAFT = {
    "category": "virtual_machine",
    "affected_object": "ZAJHBVM0142",
    "environment": "production",
    "description": "server is slow",
}


def model_returning(*responses):
    """A fake model that returns each payload in turn; records retry prompts it receives."""
    calls = {"n": 0, "retries": []}

    def fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        for part in messages[-1].parts:
            if isinstance(part, RetryPromptPart):
                calls["retries"].append(str(part.content))
        payload = responses[min(calls["n"], len(responses) - 1)]
        calls["n"] += 1
        return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, payload)])

    return FunctionModel(fn), calls


client = TestClient(main.app)


def test_vague_incident_gets_follow_ups():
    model, _ = model_returning(VAGUE)
    with main.agent.override(model=model):
        r = client.post("/api/assess", json=DRAFT)
    assert r.status_code == 200
    body = r.json()
    assert body["verdict"] == "needs_more_context"
    assert body["follow_ups"][0]["key"] == "start_time"


def test_validator_rejects_gate_opening_without_core_context():
    # First answer wrongly opens the gate with impact missing; the validator should push back.
    wrong = _payload("enough_context", _slots(affected_object="found", symptom="found", start_time="found",
                                                error_details="found", steps_taken="found"))
    model, calls = model_returning(wrong, VAGUE)
    with main.agent.override(model=model):
        r = client.post("/api/assess", json=DRAFT)
    assert r.status_code == 200
    assert r.json()["verdict"] == "needs_more_context"
    assert any("enough_context" in m for m in calls["retries"])


def test_complete_incident_opens_gate_and_clears_questions():
    stray = [{"key": "steps_taken", "question": "Tried anything?", "why": "x"}]
    model, _ = model_returning(_payload("enough_context", GOOD_SLOTS, stray))
    with main.agent.override(model=model):
        r = client.post("/api/assess", json=DRAFT)
    assert r.json()["verdict"] == "enough_context"
    assert r.json()["follow_ups"] == []


def test_missing_slot_entries_trigger_retry():
    incomplete = _payload("needs_more_context", _slots()[:5], VAGUE["follow_ups"])
    model, calls = model_returning(incomplete, VAGUE)
    with main.agent.override(model=model):
        r = client.post("/api/assess", json=DRAFT)
    assert r.status_code == 200
    assert calls["retries"]


def test_bad_input_rejected():
    r = client.post("/api/assess", json={**DRAFT, "category": "mainframe"})
    assert r.status_code == 422


def test_rate_limit():
    model, _ = model_returning(VAGUE)
    main._hits.clear()
    headers = {"x-forwarded-for": "10.9.9.9"}
    with main.agent.override(model=model):
        codes = [client.post("/api/assess", json=DRAFT, headers=headers).status_code
                 for _ in range(main.RATE_LIMIT + 1)]
    assert codes[-1] == 429 and codes[0] == 200
    main._hits.clear()
