"""LOCAL TESTING ONLY. This file exists only in staging and is never copied to live.

run-staging.ps1 starts the app as `app.localtest:app`, which is the normal app (app.main) plus:
  * sign-in without Google for requests addressed to localhost from this machine, as MCB_DEV_LOGIN_EMAIL
    (read from staging's backend\\.env), or as the user picked in "Test as";
  * a "Test as" switch in the top bar to act as yourself or any pipeline owner.
A request addressed to any other host name is untouched, so it always needs Google sign-in.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from . import auth
from .main import app
from .repository import get_analytics

LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1", "[::1]")
TEST_AS_COOKIE = "mcb_test_as"
_EMAIL = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def _dev_email() -> str:
    env = Path(__file__).resolve().parents[1] / ".env"
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("MCB_DEV_LOGIN_EMAIL="):
            return line.split("=", 1)[1].strip().strip("'\"").lower()
    return ""


DEV_EMAIL = _dev_email()


def local_test_mode(request: Request) -> bool:
    if not DEV_EMAIL:
        return False
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].lower()
    client = request.client.host if request.client else ""
    return host in LOCAL_HOSTS and client in ("127.0.0.1", "::1")


def _local_user(request: Request) -> Optional[dict]:
    if not local_test_mode(request):
        return None
    picked = (request.cookies.get(TEST_AS_COOKIE) or "").strip().lower()
    return {"email": picked if _EMAIL.match(picked) else DEV_EMAIL, "name": "Local test (staging)"}


_real_request_user = auth.request_user
auth.request_user = lambda request: _real_request_user(request) or _local_user(request)   # main calls auth.request_user


class TestAs(BaseModel):
    email: str = ""


router = APIRouter()


@router.get("/api/auth/test-mode")
def test_mode(request: Request):
    if not local_test_mode(request):
        return {"enabled": False}
    try:
        owners = [{"email": o["email"], "name": o["name"]} for o in get_analytics().pipeline_owners() if o["email"]]
    except Exception:
        owners = []
    current = (_local_user(request) or {}).get("email", DEV_EMAIL)
    return {"enabled": True, "current": current, "options": [{"email": DEV_EMAIL, "name": f"Me ({DEV_EMAIL})"}] + owners}


@router.post("/api/auth/test-as")
def test_as(body: TestAs, request: Request, response: Response):
    if not local_test_mode(request):
        raise HTTPException(404, "Not found")
    email = body.email.strip().lower()
    if email and not _EMAIL.match(email):
        raise HTTPException(422, "Not an email address")
    if email and email != DEV_EMAIL:
        response.set_cookie(TEST_AS_COOKIE, email, httponly=True, samesite="lax", path="/")
    else:
        response.delete_cookie(TEST_AS_COOKIE, path="/")
    return {"email": email or DEV_EMAIL}


TEST_AS_JS = """
fetch('/api/auth/test-mode', { credentials: 'same-origin' }).then((r) => r.json()).then((t) => {
  if (!t || !t.enabled) return;
  const bar = document.querySelector('.topbar .ms-auto');
  if (!bar) return;
  const box = document.createElement('div');
  box.className = 'd-flex align-items-center gap-1 px-2 py-1 rounded-3';
  box.style.cssText = 'background:var(--mcb-amber-soft);color:var(--mcb-amber-ink)';
  box.title = 'Local testing only (staging on localhost): act as another user';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  box.innerHTML = '<label for="testAs" class="fs-8 fw-semibold text-nowrap">Test as</label>'
    + '<select id="testAs" class="form-select form-select-sm" style="width:auto;max-width:240px">'
    + t.options.map((o) => `<option value="${esc(o.email)}" ${o.email === t.current ? 'selected' : ''}>${esc(o.name)}</option>`).join('')
    + '</select>';
  bar.prepend(box);
  box.querySelector('select').addEventListener('change', (e) => {
    fetch('/api/auth/test-as', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: e.target.value }) }).then(() => location.reload());
  });
}).catch(() => {});
"""


@router.get("/js/localtest.js")
def test_as_js():
    return Response(TEST_AS_JS, media_type="application/javascript", headers={"Cache-Control": "no-store"})


app.include_router(router)
_new = app.router.routes[-len(router.routes):]
del app.router.routes[-len(router.routes):]
app.router.routes[0:0] = _new                       # ahead of the app's own catch-all routes


@app.middleware("http")
async def add_test_as_switch(request: Request, call_next):
    """Local test mode: load the "Test as" script into the portal's HTML pages."""
    if not local_test_mode(request) or request.url.path.startswith(("/api/", "/js/", "/css/", "/vendor/", "/a/")):
        return await call_next(request)
    request.scope["headers"] = [(k, v) for k, v in request.scope["headers"] if k != b"accept-encoding"]   # keep HTML uncompressed
    response = await call_next(request)
    if not response.headers.get("content-type", "").startswith("text/html"):
        return response
    body = b"".join([chunk async for chunk in response.body_iterator])
    body = body.replace(b"</body>", b'<script type="module" src="/js/localtest.js"></script></body>', 1)
    headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
    return Response(body, status_code=response.status_code, headers=headers)
