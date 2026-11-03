"""WhatsApp messages through AiSensy (https://aisensy.stoplight.io).

Direct API (used when MCB_AISENSY_USERNAME is set):
  POST {direct}/users/regenrate-token   Basic auth username:password:projectId  -> JWT bearer token (kept until it expires)
  POST {direct}/messages                Authorization: Bearer <JWT>   -> send a template message
Partner API (otherwise), with the Partner API key:
  {base}/partner-apis/v1/partner/{partner_id}/...  and  {base}/project-apis/v1/project/{project_id}/messages
Messages are approved WhatsApp templates (settings.aisensy_templates, chosen by days to the due date); their
variables, in order, are settings.aisensy_template_params.
"""
from __future__ import annotations

import base64
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request

from .config import get_settings

log = logging.getLogger("mcb.whatsapp")

TOKEN_REUSE = 12 * 3600      # seconds a JWT is reused when it carries no expiry of its own
_token: dict = {"jwt": "", "until": 0.0}
_token_lock = threading.Lock()


class WhatsAppUnavailable(Exception):
    """AiSensy is not configured, or it refused or failed the request."""


def _http(method: str, url: str, headers: dict, body: dict | None = None) -> dict:
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        log.warning("AiSensy %s %s failed: %s %s", method, url, e.code, detail)
        raise WhatsAppUnavailable(f"AiSensy refused the request ({e.code}): {detail[:200]}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        log.warning("AiSensy %s %s unreachable: %s", method, url, e)
        raise WhatsAppUnavailable("AiSensy is unreachable") from None


def mode() -> str:
    """'direct' when the Direct API login is set, 'partner' when the Partner API key is, else ''."""
    s = get_settings()
    if s.aisensy_username and s.aisensy_password.get_secret_value():
        return "direct"
    if s.aisensy_partner_id and s.aisensy_partner_key.get_secret_value():
        return "partner"
    return ""


# ---------------- Direct API ----------------
def _jwt_expiry(jwt: str) -> float | None:
    """The token's own expiry time (epoch seconds), read from its payload, if it has one."""
    try:
        part = jwt.split(".")[1]
        return float(json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("exp"))
    except Exception:
        return None


TOKEN_APP = "aisensy"   # the token's row in portal.api_tokens


def _token_store():
    """The portal database (portal.api_tokens), or None when it is not reachable."""
    try:
        from .repository import optional_store
        return optional_store()
    except Exception:
        return None


def token(refresh: bool = False, rejected: str = "") -> str:
    """A JWT bearer token for the Direct API, shared through portal.api_tokens (app 'aisensy') so every worker uses the
    same one: a new token cancels the old one. A new one is asked for (username + password + project id) only when the
    stored one is missing, expired, or is `rejected` (refused by AiSensy); refresh=True always asks for a new one."""
    s = get_settings()
    with _token_lock:
        if not refresh and _token["jwt"] and _token["jwt"] != rejected and time.time() < _token["until"]:
            return _token["jwt"]
        store = _token_store()
        if not refresh and store:
            try:
                hit = store.get_token(TOKEN_APP)
            except Exception:
                log.exception("Stored AiSensy token unreadable")
                hit = None
            if hit and hit[0] != rejected and time.time() < hit[1]:
                _token.update(jwt=hit[0], until=hit[1])
                return hit[0]
        login = f"{s.aisensy_username}:{s.aisensy_password.get_secret_value()}"
        if s.aisensy_direct_project_id:      # AiSensy takes the project in the Basic login: username:password:projectId
            login += f":{s.aisensy_direct_project_id}"
        basic = base64.b64encode(login.encode()).decode()
        r = _http("POST", s.aisensy_direct_url.rstrip("/") + "/users/regenrate-token", {"Authorization": f"Basic {basic}"},
                  {"direct_api": True})
        users = r.get("users")               # AiSensy answers {"users": [{"token": "<JWT>"}]}
        jwt = users[0].get("token", "") if isinstance(users, list) and users and isinstance(users[0], dict) else ""
        jwt = jwt or next((r[k] for k in ("users", "token", "jwt", "access_token", "accessToken") if isinstance(r.get(k), str)), "")
        if not jwt and isinstance(r.get("data"), dict):
            jwt = next((v for k, v in r["data"].items() if isinstance(v, str) and v.count(".") == 2), "")
        if not jwt:
            raise WhatsAppUnavailable(f"AiSensy gave no token (reply fields: {', '.join(r) or 'none'})")
        exp = _jwt_expiry(jwt)
        _token.update(jwt=jwt, until=(exp - 300) if exp else time.time() + TOKEN_REUSE)
        if store:
            try:
                store.save_token(TOKEN_APP, jwt, _token["until"])
            except Exception:
                log.exception("AiSensy token could not be stored")
        log.info("AiSensy Direct API token obtained, valid until %s", time.strftime("%Y-%m-%d %H:%M", time.localtime(_token["until"])))
        return jwt


def _direct(method: str, path: str, body: dict | None = None) -> dict:
    s = get_settings()
    url = s.aisensy_direct_url.rstrip("/") + path
    jwt = token()
    try:
        return _http(method, url, {"Authorization": f"Bearer {jwt}"}, body)
    except WhatsAppUnavailable as e:
        if "(401)" not in str(e):
            raise
        # Refused: another worker may already have stored a newer token; otherwise a new one is asked for.
        return _http(method, url, {"Authorization": f"Bearer {token(rejected=jwt)}"}, body)


# ---------------- Partner API ----------------
def _partner(method: str, path: str, body: dict | None = None) -> dict:
    s = get_settings()
    return _http(method, s.aisensy_base_url.rstrip("/") + path,
                 {"X-AiSensy-Partner-API-Key": s.aisensy_partner_key.get_secret_value()}, body)


def _need_mode() -> str:
    m = mode()
    if not m:
        raise WhatsAppUnavailable("WhatsApp (AiSensy) is not configured: set MCB_AISENSY_USERNAME / MCB_AISENSY_PASSWORD")
    return m


# ---------------- messages ----------------
def phone(v: str | None) -> str | None:
    """A WhatsApp number as digits with country code (India assumed for 10-digit numbers), or None."""
    d = re.sub(r"\D", "", v or "")
    if len(d) == 10 and d[0] in "6789":
        return "91" + d
    if len(d) == 12 and d.startswith("91"):
        return d
    return d if 11 <= len(d) <= 15 and not d.startswith("0") else None


_tpl_cache: dict = {"at": 0.0, "by_name": {}}


def template_details() -> dict[str, dict]:
    """name -> {status, category, language, header, body, footer, buttons} of the account's WhatsApp templates
    (Direct API; cached 5 minutes)."""
    if time.time() - _tpl_cache["at"] < 300:
        return _tpl_cache["by_name"]
    if _need_mode() != "direct":
        return {}
    r = _direct("GET", "/get-templates?limit=200")
    out = {}
    for t in r.get("data", []) if isinstance(r, dict) else []:
        comps = {c.get("type"): c for c in t.get("components", []) if isinstance(c, dict)}
        out[t.get("name")] = {"status": t.get("status") or "", "category": t.get("category") or "",
                              "language": t.get("language") or "", "body": (comps.get("BODY") or {}).get("text") or "",
                              "header": (comps.get("HEADER") or {}).get("text") or "",
                              "footer": (comps.get("FOOTER") or {}).get("text") or "",
                              "buttons": [{"type": b.get("type") or "", "text": b.get("text") or ""}
                                          for b in (comps.get("BUTTONS") or {}).get("buttons", []) if isinstance(b, dict)]}
    _tpl_cache.update(at=time.time(), by_name=out)
    return out


def template_rules() -> list[tuple[int, str]]:
    """(days, template) pairs of settings.aisensy_templates, ascending: a due date `days` away or less uses that one."""
    pairs = []
    for part in get_settings().aisensy_templates.split(","):
        n, _, name = part.partition(":")
        if name.strip() and n.strip().lstrip("-").isdigit():
            pairs.append((int(n), name.strip()))
    return sorted(pairs)


def check() -> dict:
    """Proves the credentials work: Direct API -> a token is issued; Partner API -> the partner's projects."""
    s = get_settings()
    m = _need_mode()
    if m == "direct":
        jwt = token(refresh=True)
        return {"mode": m, "token": "ok", "valid_until": time.strftime("%Y-%m-%d %H:%M", time.localtime(_token["until"])),
                "token_length": len(jwt)}
    return {"mode": m, "projects": _partner("GET", f"/partner-apis/v1/partner/{s.aisensy_partner_id}/projects")}


def fee_template(days: int | None) -> str:
    """The fee-reminder template for a due date `days` away (negative = overdue; None = no date: the earliest one)."""
    pairs = template_rules()
    if not pairs:
        raise WhatsAppUnavailable("No WhatsApp templates set: MCB_AISENSY_TEMPLATES")
    return next((name for n, name in pairs if days is not None and days <= n), pairs[-1][1])


def send_text(to: str, body: str) -> dict:
    """A plain text message (allowed within 24 hours of the parent's last message or button tap)."""
    m = _need_mode()
    num = phone(to)
    if not num:
        raise WhatsAppUnavailable(f"Not a valid WhatsApp number: {to}")
    msg = {"to": num, "type": "text", "text": {"body": body, "preview_url": False}}
    if m == "direct":
        return _direct("POST", "/messages", msg)
    s = get_settings()
    return _partner("POST", f"/project-apis/v1/project/{s.aisensy_project_id}/messages", msg)


def webhook_events(payload) -> list[dict]:
    """Delivery statuses and incoming messages in a webhook payload (Meta's format, at any depth), one dict per event:
    {kind: status|message|other, message_id, phone, status, detail, context_id, event_at, payload}. A payload with
    neither is kept whole as one 'other' event."""
    out, stack = [], [payload]
    while stack:
        x = stack.pop()
        if isinstance(x, list):
            stack.extend(x)
            continue
        if not isinstance(x, dict):
            continue
        for st in x.get("statuses") or [] if isinstance(x.get("statuses"), list) else []:
            if isinstance(st, dict):
                errs = st.get("errors") if isinstance(st.get("errors"), list) else []
                out.append({"kind": "status", "message_id": st.get("id"), "phone": st.get("recipient_id"),
                            "status": st.get("status"), "context_id": None, "event_at": _epoch(st.get("timestamp")),
                            "detail": "; ".join(f"{e.get('code')} {e.get('title') or e.get('message') or ''}".strip()
                                                for e in errs if isinstance(e, dict)) or None, "payload": st})
        for m in x.get("messages") or [] if isinstance(x.get("messages"), list) else []:
            if isinstance(m, dict) and m.get("from"):
                t = m.get("type") or ""
                body = ((m.get("text") or {}).get("body") if isinstance(m.get("text"), dict) else None) \
                    or ((m.get("button") or {}).get("text") if isinstance(m.get("button"), dict) else None) \
                    or (((m.get("interactive") or {}).get("button_reply") or {}).get("title") if isinstance(m.get("interactive"), dict) else None)
                out.append({"kind": "message", "message_id": m.get("id"), "phone": m.get("from"), "status": t,
                            "detail": body, "context_id": (m.get("context") or {}).get("id") if isinstance(m.get("context"), dict) else None,
                            "event_at": _epoch(m.get("timestamp")), "payload": m})
        stack.extend(v for k, v in x.items() if k not in ("statuses", "messages") and isinstance(v, (dict, list)))
    return out or [{"kind": "other", "message_id": None, "phone": None, "status": None, "detail": None,
                    "context_id": None, "event_at": None, "payload": payload if isinstance(payload, dict) else {"body": payload}}]


def _epoch(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def button_taps(payload) -> list[dict]:
    """Button taps in a webhook payload (Meta's format, at any depth): [{id, from, text, context_id}]."""
    out, stack = [], [payload]
    while stack:
        x = stack.pop()
        if isinstance(x, list):
            stack.extend(x)
        elif isinstance(x, dict):
            frm = x.get("from") or x.get("waId") or x.get("wa_id")
            b = x.get("button") if isinstance(x.get("button"), dict) else None
            ir = (x.get("interactive") or {}).get("button_reply") if isinstance(x.get("interactive"), dict) else None
            if frm and (b or ir) and isinstance(frm, str):
                ctx = x.get("context") if isinstance(x.get("context"), dict) else {}
                out.append({"id": x.get("id") or "", "from": frm,
                            "text": (b or {}).get("text") or (b or {}).get("payload") or (ir or {}).get("title") or "",
                            "context_id": ctx.get("id") or ""})
                continue
            stack.extend(v for v in x.values() if isinstance(v, (dict, list)))
    return out


def send_template(to: str, values: dict[str, str], template: str, pay_code: str | None = None) -> dict:
    """Send a fee-reminder template to one number. `values` maps the variable names in
    settings.aisensy_template_params to their text; `pay_code` fills the Pay Now URL button (https://fee.s.gy/{{1}}).
    Returns AiSensy's answer (message id, status)."""
    s = get_settings()
    m = _need_mode()
    num = phone(to)
    if not num:
        raise WhatsAppUnavailable(f"Not a valid WhatsApp number: {to}")
    names = [n.strip() for n in s.aisensy_template_params.split(",") if n.strip()]
    body = {
        "to": num,
        "type": "template",
        "template": {
            "name": template,
            "language": {"code": s.aisensy_template_language},
            "components": [{"type": "body", "parameters": [{"type": "text", "text": str(values.get(n, ""))} for n in names]}],
        },
    }
    if pay_code:
        body["template"]["components"].append({"type": "button", "sub_type": "url", "index": "0",
                                               "parameters": [{"type": "text", "text": pay_code}]})
    if m == "direct":
        return _direct("POST", "/messages", body)
    if not s.aisensy_project_id:
        raise WhatsAppUnavailable("WhatsApp (AiSensy) is not configured: MCB_AISENSY_PROJECT_ID")
    return _partner("POST", f"/project-apis/v1/project/{s.aisensy_project_id}/messages", body)
