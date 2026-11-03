"""Sign-in: Google account, allowed only for active MCBMaster staff (the same rule as the Admin MIS dashboard).

The browser gets a Google ID token from Google Sign-In and posts it to /api/auth/google. The token is verified with
Google here on the server, its email is looked up in dbo.Users (Status = 1), and a signed HttpOnly session cookie is set.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import text

from .config import get_settings
from .db import get_engine

log = logging.getLogger("mcb.auth")
router = APIRouter(prefix="/api/auth")

COOKIE_NAME = "mcb_session"
GOOGLE_TOKENINFO = "https://oauth2.googleapis.com/tokeninfo"
GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")
# Reachable without a session: the sign-in page, its API and the static assets (no figures in any of them).
PUBLIC_PREFIXES = ("/api/auth/", "/api/wa-hook/", "/css/", "/js/", "/vendor/", "/a/")   # /a/<version>/… = the same assets, versioned
PUBLIC_PATHS = ("/login", "/favicon.ico")

_fallback_secret = secrets.token_bytes(32)


def _secret() -> bytes:
    s = get_settings().session_secret.get_secret_value()
    return s.encode() if s else _fallback_secret


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(body: str) -> str:
    return _b64(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())


def create_session(email: str, name: str) -> str:
    exp = int(time.time()) + get_settings().session_hours * 3600
    body = _b64(json.dumps({"email": email, "name": name, "exp": exp}, separators=(",", ":")).encode())
    return f"{body}.{_sign(body)}"


def read_session(token: str) -> Optional[dict]:
    """The signed-in user ({email, name}) or None when the cookie is missing, tampered with or expired."""
    try:
        body, sig = token.split(".")
        if not hmac.compare_digest(sig, _sign(body)):
            return None
        data = json.loads(_unb64(body))
        if int(data["exp"]) < time.time():
            return None
        return {"email": str(data["email"]), "name": str(data.get("name") or "")}
    except Exception:
        return None


def is_public(path: str) -> bool:
    return path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES)


def request_user(request: Request) -> Optional[dict]:
    return read_session(request.cookies.get(COOKIE_NAME, ""))


def _google_email(credential: str) -> tuple[str, str]:
    """Verify a Google ID token with Google and return (email, name)."""
    client_id = get_settings().google_client_id
    try:
        with urllib.request.urlopen(f"{GOOGLE_TOKENINFO}?{urllib.parse.urlencode({'id_token': credential})}", timeout=10) as r:
            claims = json.loads(r.read())
    except urllib.error.HTTPError:
        raise HTTPException(401, "Google sign-in could not be verified. Please try again.")
    except Exception as exc:
        log.error("Google token check failed: %s", exc)
        raise HTTPException(503, "Google could not be reached to verify the sign-in. Please retry in a moment.")
    if claims.get("aud") != client_id or claims.get("iss") not in GOOGLE_ISSUERS:
        raise HTTPException(401, "Google sign-in could not be verified. Please try again.")
    if str(claims.get("email_verified")).lower() != "true" or not claims.get("email"):
        raise HTTPException(401, "Your Google account has no verified email address.")
    return str(claims["email"]).strip().lower(), str(claims.get("name") or "")


def _staff_name(email: str) -> Optional[str]:
    """Name if this email is an active MCBMaster user of an allowed type (Users.Status = 1, UserTypeID in
    MCB_LOGIN_USER_TYPE_IDS), else None."""
    type_ids = get_settings().allowed_user_type_ids
    with get_engine().connect() as c:
        row = c.execute(text("SELECT TOP 1 Name FROM dbo.Users WHERE LOWER(LTRIM(RTRIM(EmailID))) = :email AND Status = 1 "
                             f"AND UserTypeID IN ({', '.join(str(i) for i in type_ids)})"),
                        {"email": email}).fetchone()
    return (row[0] or "").strip() if row else None


class GoogleLogin(BaseModel):
    credential: str


@router.get("/config")
def auth_config():
    return {"google_client_id": get_settings().google_client_id}


@router.post("/google")
def google_login(body: GoogleLogin, response: Response):
    email, google_name = _google_email(body.credential)
    name = _staff_name(email)
    if name is None:
        log.warning("Sign-in refused for %s: not an active MCBMaster user", email)
        raise HTTPException(403, "Email not authorized. Contact admin.")
    s = get_settings()
    response.set_cookie(COOKIE_NAME, create_session(email, name or google_name), max_age=s.session_hours * 3600,
                        httponly=True, samesite="lax", secure=s.cookie_secure, path="/")
    log.info("Signed in: %s", email)
    return {"email": email, "name": name or google_name}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}
