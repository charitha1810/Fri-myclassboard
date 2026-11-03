"""AI suggestions (Claude API): turn the portal's live figures into prioritised actions that grow
fee payments through active MCB-partner gateways — the flow MCB earns commission on.

Claude only sees the aggregates built here (no student or parent data). Answers are structured JSON,
validated with pydantic, and reused while the data snapshot and inputs are unchanged.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from datetime import datetime

import anthropic
from pydantic import BaseModel, ValidationError

from .config import Settings
from .schemas import Suggestion, SuggestionsOut

log = logging.getLogger("mcb.ai")

SYSTEM = """You are a revenue analyst for MyClassBoard (MCB), a school ERP whose fee module lets institutes collect fees online.

How MCB earns: MCB earns a commission only on fee payments that flow through ACTIVE MCB-PARTNER payment gateways (gateway master: IsActive = 1 and IsMCBPartner = 1). Online payments through non-partner, inactive or unlisted gateways earn MCB nothing. Cash, card swipe at the counter, cheque, demand draft and direct bank transfers (NEFT/RTGS/UPI to the school's account) earn MCB nothing.

The business goal: increase the value of fee payments that go through active MCB-partner gateways. The levers are:
1. Convert offline fees (cash, card swipe, cheque, DD) at institutes already live on a partner gateway — pay-link reminders before due dates, UPI QR at the fee counter, EMI options for large fees.
2. Move institutes (or branches) using non-partner gateways to an MCB-partner gateway.
3. Onboard branches marked N/A at institutes where other branches already use a partner gateway.
4. Onboard institutes not using MCB gateways at all (N/A).
5. Loan / EMI partners for high-fee institutes; re-engage institutes whose collections stopped.

Rules:
- Use only the figures in the data provided. Never invent institutes, gateways, amounts or percentages. If something you would need is missing, say so in data_notes.
- Quantify each suggestion with the numbers given: expected_volume_cr is extra annual partner-gateway volume in ₹ crore; expected_commission_lakh_yr is MCB commission per year in ₹ lakh at the commission rate provided (volume × rate). Use 0 when it cannot be estimated from the data.
- Name institutes exactly as they appear in the data (at most 8 per suggestion), biggest opportunity first.
- Write for an MCB account manager in India: concrete, specific, short. Use ₹ Cr / ₹ L. No generic advice that would apply to any company.
- Order suggestions by expected commission, highest first. Give 3 to 6 suggestions."""

SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "description": "One sentence: the single most important thing to do to grow commission."},
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "lever": {"type": "string", "enum": ["convert_offline", "switch_gateway", "onboard_branches", "onboard_na", "loan_emi", "re_engage", "other"]},
                    "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                    "why": {"type": "string", "description": "The evidence from the data, with numbers."},
                    "action": {"type": "string", "description": "What the account manager should do next, concretely."},
                    "institutes": {"type": "array", "items": {"type": "string"}},
                    "expected_volume_cr": {"type": "number"},
                    "expected_commission_lakh_yr": {"type": "number"},
                },
                "required": ["title", "lever", "priority", "why", "action", "institutes", "expected_volume_cr", "expected_commission_lakh_yr"],
                "additionalProperties": False,
            },
        },
        "data_notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["headline", "suggestions", "data_notes"],
    "additionalProperties": False,
}


class _Answer(BaseModel):
    headline: str
    suggestions: list[Suggestion]
    data_notes: list[str] = []


class AIUnavailable(Exception):
    """No credentials or the API could not answer — shown to the user as a plain message (details are logged)."""


SETUP_MSG = "AI suggestions are being set up by your administrator. Please try again later."


class Advisor:
    def __init__(self, s: Settings) -> None:
        self.s = s
        key = s.anthropic_api_key.get_secret_value()
        opts: dict = {"timeout": 180.0, "max_retries": 2}
        if s.anthropic_workspace_id:
            # Keys not scoped to a workspace must name one on every request.
            opts["default_headers"] = {"anthropic-workspace-id": s.anthropic_workspace_id}
        try:
            # Explicit key from backend/.env, else the SDK's own resolution (ANTHROPIC_API_KEY / `ant auth login` profile).
            self.client = anthropic.Anthropic(api_key=key, **opts) if key else anthropic.Anthropic(**opts)
        except Exception as exc:  # no credentials anywhere
            log.warning("Claude API client not configured: %s", exc)
            self.client = None
        self._cache: dict[str, tuple[float, SuggestionsOut]] = {}
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        """True when a key is configured (backend/.env, or the SDK's ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)."""
        return self.client is not None and bool(
            self.s.anthropic_api_key.get_secret_value() or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))

    def suggest(self, scope: str, context: dict, snapshot: str, refresh: bool = False) -> SuggestionsOut:
        if not self.client:
            log.error("AI suggestions: no API client (set MCB_ANTHROPIC_API_KEY in backend/.env)")
            raise AIUnavailable(SETUP_MSG)
        payload = json.dumps(context, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        key = hashlib.sha256(f"{self.s.ai_model}|{self.s.ai_effort}|{scope}|{payload}".encode()).hexdigest()
        with self._lock:
            hit = self._cache.get(key)
            if hit and not refresh and time.time() - hit[0] < self.s.ai_cache_minutes * 60:
                return hit[1].model_copy(update={"cached": True})

        try:
            resp = self.client.beta.messages.create(
                model=self.s.ai_model,
                max_tokens=16000,
                # Server-side refusal fallback: a declined request is re-run on Anthropic's recommended model.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
                output_config={"effort": self.s.ai_effort, "format": {"type": "json_schema", "schema": SCHEMA}},
                messages=[{"role": "user", "content": f"Scope: {scope}\n\nLive data from the MCB revenue portal (JSON):\n{payload}"}],
            )
        # Users see plain messages; the technical cause (key, workspace, model, status) goes to the server log.
        except anthropic.AuthenticationError as exc:
            log.error("AI suggestions: API key rejected (check MCB_ANTHROPIC_API_KEY): %s", exc.message)
            raise AIUnavailable(SETUP_MSG) from exc
        except anthropic.PermissionDeniedError as exc:
            log.error("AI suggestions: key has no access to model %s: %s", self.s.ai_model, exc.message)
            raise AIUnavailable(SETUP_MSG) from exc
        except anthropic.RateLimitError as exc:
            log.warning("AI suggestions: rate limited: %s", exc.message)
            raise AIUnavailable("Too many requests just now. Please try again in a minute.") from exc
        except anthropic.BadRequestError as exc:
            hint = " — set MCB_ANTHROPIC_WORKSPACE_ID in backend/.env or use a workspace-scoped key" if "workspace" in str(exc.message).lower() else ""
            log.error("AI suggestions: request rejected%s: %s", hint, exc.message)
            raise AIUnavailable(SETUP_MSG) from exc
        except anthropic.APIStatusError as exc:
            log.error("AI suggestions: API error %s: %s", exc.status_code, exc.message)
            raise AIUnavailable("The suggestion service had a problem. Please try again shortly.") from exc
        except anthropic.APIConnectionError as exc:
            log.error("AI suggestions: cannot reach the API from this server: %s", exc)
            raise AIUnavailable("The suggestion service could not be reached. Please try again shortly.") from exc
        except TypeError as exc:  # the SDK found no credentials at all
            log.error("AI suggestions: no credentials (set MCB_ANTHROPIC_API_KEY in backend/.env)")
            raise AIUnavailable(SETUP_MSG) from exc

        if resp.stop_reason == "refusal":
            log.warning("AI suggestions: request declined (request %s)", getattr(resp, "_request_id", "?"))
            raise AIUnavailable("No suggestions could be produced for this view. Try different filters.")
        if resp.stop_reason == "max_tokens":
            raise AIUnavailable("The answer was cut off. Try a narrower filter.")
        text = next((b.text for b in resp.content if b.type == "text"), "")
        try:
            ans = _Answer.model_validate_json(text)
        except ValidationError as exc:
            log.error("Unparseable AI answer (request %s): %s", getattr(resp, "_request_id", "?"), exc)
            raise AIUnavailable("The AI answer could not be read. Try again.") from exc
        log.info("AI suggestions: scope=%s model=%s in=%s out=%s request=%s", scope, resp.model,
                 resp.usage.input_tokens, resp.usage.output_tokens, getattr(resp, "_request_id", "?"))
        out = SuggestionsOut(scope=scope, headline=ans.headline, suggestions=ans.suggestions, data_notes=ans.data_notes,
                             model=resp.model, generated_at=datetime.now().isoformat(timespec="seconds"), snapshot=snapshot)
        with self._lock:
            self._cache[key] = (time.time(), out)
            for k in [k for k, (t, _) in self._cache.items() if time.time() - t > self.s.ai_cache_minutes * 60]:
                self._cache.pop(k, None)
        return out
