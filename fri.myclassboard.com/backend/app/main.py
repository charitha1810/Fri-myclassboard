"""MCB Revenue Intelligence API + static frontend.

Run from the backend folder:  uvicorn app.main:app --reload
"""
from __future__ import annotations

import hashlib
import json
import hmac
import logging
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from sqlalchemy.exc import DBAPIError, SQLAlchemyError

from . import auth, insights
from .ai import AIUnavailable
from .ai_context import institute_context, portfolio_context
from .analytics import DUE_DAYS, PG_FILTER_OF, Analytics, Scope
from .app_store import CHANNEL_NAME, CONSENT_NAME, STAGE_IDS, STAGE_NAME, STAGES, AppStore
from .commission import commission_view
from .config import FRONTEND_DIR, get_settings
from .feesearch import SearchUnavailable, due_count, due_list, parents_for, pick_dues, preload_status, start_preload, total_students
from . import mobile_app, whatsapp
from .repository import (
    BRANCH_BUCKETS, Conflict, NotFound, StoreUnavailable, branch_bucket, configured_owners, get_advisor, get_analytics,
    get_store, optional_store, start_store_connector,
)
from .schemas import (
    Activity, ActivityIn, ActivityView, Alert, AssignOwner, CampaignIn, CampaignOut, CommissionView, DueList, DueStudents, ConsentUpdate, Deal, DealIn, DealMove, FilterOption,
    FilterOptions, Freshness, Gateways, InstituteDetail, Institutes, Loans, MasterGateway, Meta, MonthDetail, MonthlySummary, Note, NoteIn, TotalReconciliation,
    Owner, PaymentModes, Pipeline, RevenueSettings, SuggestionsIn, SuggestionsOut, User, WhatsAppSendIn, WhatsAppTestIn, PushSendIn,
)

_settings = get_settings()
logging.basicConfig(level=getattr(logging, _settings.log_level.upper(), logging.INFO),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("mcb.api")
app = FastAPI(title="MCB Revenue Intelligence API", version="1.0.0")

_cors = [o.strip() for o in _settings.cors_origins.split(",") if o.strip()]
if _cors:
    app.add_middleware(CORSMiddleware, allow_origins=_cors, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Content-Type"])
# JSON payloads (e.g. 1,300+ institutes) shrink ~8× on the wire.
app.add_middleware(GZipMiddleware, minimum_size=_settings.gzip_min_bytes)

CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
# The sign-in page also loads Google Sign-In (its script, button iframe and stylesheet).
LOGIN_CSP = ("default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; "
             "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data:; "
             "connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; "
             "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")


@app.middleware("http")
async def harden_and_log(request: Request, call_next):
    """Sign-in check, request id + timing log, security headers, and no stale page / JS / CSS after a deploy."""
    rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    t0 = time.perf_counter()
    p = request.url.path
    request.state.user = auth.request_user(request)
    try:
        if request.state.user is None and not auth.is_public(p):
            # Nothing but the sign-in page is served without a session.
            response = (JSONResponse({"detail": "Please sign in.", "code": "signed_out"}, status_code=401)
                        if p.startswith("/api/") else RedirectResponse("/login", status_code=302))
        else:
            response = await call_next(request)
    except Exception:
        log.exception("Unhandled error rid=%s %s %s", rid, request.method, request.url.path)
        response = JSONResponse({"detail": "Something went wrong on the server. Please try again.", "request_id": rid}, status_code=500)
    ms = (time.perf_counter() - t0) * 1000
    if p.startswith("/api/"):
        log.info("rid=%s %s %s?%s -> %s in %.0f ms", rid, request.method, p, request.url.query, response.status_code, ms)
    response.headers["X-Request-ID"] = rid
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = CSP
    if p == "/login":
        response.headers["Content-Security-Policy"] = LOGIN_CSP
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"   # Google's sign-in popup
    if p in ("/", "/login") or p.startswith(("/js/", "/css/")):
        response.headers["Cache-Control"] = "no-cache"
    elif p.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"   # figures always come fresh from the server
    return response


@app.exception_handler(DBAPIError)
async def _db_down(request: Request, exc: DBAPIError):
    log.error("Database error on %s: %s", request.url.path, str(exc.orig)[:300] if exc.orig else exc)
    return JSONResponse({"detail": "The MCB database could not be reached, so no figures are shown. Please retry in a moment.",
                         "code": "database_unavailable"}, status_code=503)


@app.exception_handler(SQLAlchemyError)
async def _db_error(request: Request, exc: SQLAlchemyError):
    log.error("Database error on %s: %s", request.url.path, exc)
    return JSONResponse({"detail": "A database error occurred. Please retry.", "code": "database_error"}, status_code=503)


@app.exception_handler(AIUnavailable)
async def _ai_down(_: Request, exc: AIUnavailable):
    return JSONResponse({"detail": str(exc), "code": "ai_unavailable"}, status_code=503)


@app.on_event("startup")
def _startup() -> None:
    s = _settings
    log.info("Starting MCB Revenue Intelligence: db=%s@%s:%s/%s, ai_model=%s, ai=%s, portal_db=%s",
             s.db_user, s.db_server, s.db_port, s.db_name, s.ai_model,
             "key in .env" if s.anthropic_api_key.get_secret_value() else "SDK default credentials",
             "configured" if s.app_db_url.get_secret_value() else "NOT configured")
    if not s.db_server or not s.db_user:
        log.error("MCB_DB_SERVER / MCB_DB_USER missing in backend/.env — analytics will fail.")
    start_store_connector()   # PostgreSQL connects in the background; pages never wait for it
    try:
        get_analytics().account_teams()   # starts the slow account-team read in the background
    except Exception:
        log.exception("Could not start the account-team read")
    try:
        start_preload(lambda: list(get_analytics().institute_names()))   # fee-due summaries for every institution
    except Exception:
        log.exception("Could not start the fee preload")


@app.exception_handler(NotFound)
async def _not_found(_: Request, exc: NotFound):
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.exception_handler(Conflict)
async def _conflict(_: Request, exc: Conflict):
    return JSONResponse({"detail": str(exc)}, status_code=409)


@app.exception_handler(SearchUnavailable)
async def _search_down(_: Request, exc: SearchUnavailable):
    return JSONResponse({"detail": str(exc)}, status_code=503)


@app.exception_handler(whatsapp.WhatsAppUnavailable)
async def _whatsapp_down(_: Request, exc: whatsapp.WhatsAppUnavailable):
    return JSONResponse({"detail": str(exc)}, status_code=502)


@app.exception_handler(mobile_app.PushUnavailable)
async def _push_down(_: Request, exc: mobile_app.PushUnavailable):
    return JSONResponse({"detail": str(exc)}, status_code=502)


@app.exception_handler(StoreUnavailable)
async def _store_down(_: Request, exc: StoreUnavailable):
    return JSONResponse({"detail": str(exc)}, status_code=503)


def fy_param(fy: Optional[str] = None, an: Analytics = Depends(get_analytics)) -> str:
    """Resolve ?fy=2026-2027, defaulting to the latest financial year with data."""
    opts = an.fy_options()
    if not opts:
        raise HTTPException(503, "No financial years found in MCBOrganisationPaymentsAnalysis")
    if fy is None:
        return opts[0]
    if fy not in opts:
        raise HTTPException(404, f"No data for FY {fy}")
    return fy


def scope_param(db: Optional[str] = None, partner: Optional[str] = None, coverage: Optional[str] = None,
                gateway: Optional[str] = None, inst: Optional[str] = None,
                m_from: Optional[str] = Query(None, alias="from"), m_to: Optional[str] = Query(None, alias="to"),
                modes: Optional[str] = None, gw_kind: Optional[str] = None) -> Scope:
    """Global filters shared by every analytics endpoint:
    ?db=A,B&partner=&coverage=&gateway=&gw_kind=&inst=&from=Apr&to=Sep&modes=cash,card"""
    split = lambda v: tuple(x for x in (v or "").split(",") if x)  # noqa: E731
    return Scope(dbs=split(db), partner=partner or "", coverage=coverage or "", gateway=gateway or "", inst=inst or "",
                 m_from=m_from or "", m_to=m_to or "", modes=split(modes), gw_kind=gw_kind or "")


def _institutes(fy: str, an: Analytics, store: AppStore | None, sc: Scope | None = None) -> Institutes:
    if store is None:
        return an.institutes(fy, {}, {}, sc)
    return an.institutes(fy, store.owners_by_institute(), store.consent_by_institute(), sc)


def _check_inst(iid: str, an: Analytics) -> None:
    if not any(iid in an.fy_data(fy).orgs for fy in an.fy_options()[:2]):
        raise NotFound(f"Institute {iid} not found")


# ---------------- meta & settings ----------------
@app.get("/api/meta", response_model=Meta)
def meta(request: Request, fy: str = Depends(fy_param), an: Analytics = Depends(get_analytics),
         store: AppStore | None = Depends(optional_store)):
    gen = an.generated_at()
    gmap = an.gateway_map()
    notices = []
    if store is None:
        notices.append("Portal database (PostgreSQL) is not connected: owners, notes, pipeline, consent and settings "
                       "cannot be saved. Set MCB_APP_DB_URL in backend/.env.")
    if gmap.denied:
        notices.append(f"Gateway mapping could not be read for {len(gmap.denied)} tenant database(s): "
                       + ", ".join(gmap.denied[:8]) + (" …" if len(gmap.denied) > 8 else "")
                       + ". Ask the DBA to grant SELECT on dbo.View_OrganisationPaymentGatewayName there.")
    email = request.state.user["email"]
    initials = "".join(p[0] for p in email.split("@")[0].replace(".", " ").split()[:2]).upper() if email else "ME"
    return Meta(fy=fy, fy_options=an.fy_options(),
                freshness=Freshness(org_wise=gen.strftime("%d %b, %H:%M"), modes=gen.strftime("%d %b, %H:%M"),
                                    gateway=gmap.loaded_at.strftime("%d %b, %H:%M")),
                owners=configured_owners(), user=User(initials=initials or "ME", email=email), notices=notices,
                snapshot=gen.isoformat())


@app.get("/api/version")
def version(an: Analytics = Depends(get_analytics)):
    """Cheap poll target: the page compares this with the snapshot it loaded and offers a reload when it changes."""
    return {"snapshot": an.snapshot().isoformat()}


@app.get("/api/settings", response_model=RevenueSettings)
def get_revenue_settings(store: AppStore | None = Depends(optional_store)):
    return store.get_settings() if store else RevenueSettings()


@app.put("/api/settings", response_model=RevenueSettings)
def put_revenue_settings(body: RevenueSettings, store: AppStore = Depends(get_store)):
    return store.save_settings(body)


@app.post("/api/refresh", status_code=202)
def refresh(an: Analytics = Depends(get_analytics)):
    """Drop cached query results so the next request re-reads the database."""
    an.clear_cache()
    return {"status": "cleared"}


# ---------------- analytics ----------------
@app.get("/api/payment-modes", response_model=PaymentModes)
def payment_modes(fy: str = Depends(fy_param), sc: Scope = Depends(scope_param), an: Analytics = Depends(get_analytics)):
    return an.payment_modes(fy, sc)


@app.get("/api/total-reconciliation", response_model=TotalReconciliation)
def total_reconciliation(fy: str = Depends(fy_param), an: Analytics = Depends(get_analytics)):
    """From every row of the FY to the total the portal shows: what each rule leaves out."""
    return an.total_reconciliation(fy)


@app.get("/api/monthly-summary", response_model=MonthlySummary)
def monthly_summary(fy: str = Depends(fy_param), sc: Scope = Depends(scope_param), an: Analytics = Depends(get_analytics)):
    """Fees for every complete month within the filters, split into the headline parts (rupees)."""
    return an.monthly_summary(fy, sc)


@app.get("/api/month-detail", response_model=MonthDetail)
def month_detail(month: str, kind: str = "all", fy: str = Depends(fy_param), sc: Scope = Depends(scope_param),
                 an: Analytics = Depends(get_analytics)):
    """What one chart column is made of: every payment mode and every school for that month, within the filters."""
    try:
        return an.month_detail(fy, month, kind, sc)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@app.get("/api/gateways", response_model=Gateways)
def gateways(fy: str = Depends(fy_param), sc: Scope = Depends(scope_param), an: Analytics = Depends(get_analytics)):
    summary, gws = an.gateways(fy, sc)
    return Gateways(summary=summary, gateways=insights.annotate_gateways(gws, summary, check_duplicates=not summary.attributed),
                    signals=insights.gateway_signals(gws, summary, check_duplicates=not summary.attributed))


@app.get("/api/gateway-master", response_model=list[MasterGateway])
def gateway_master(fy: str = Depends(fy_param), sc: Scope = Depends(scope_param), an: Analytics = Depends(get_analytics)):
    """All gateways in MasterPaymentGateways — active and inactive — with usage within the filters."""
    return an.gateway_master_list(fy, sc)


@app.get("/api/loans", response_model=Loans)
def loans(fy: str = Depends(fy_param), sc: Scope = Depends(scope_param), an: Analytics = Depends(get_analytics)):
    partners = an.loan_partners(fy, sc)
    return Loans(summary=an.loans(fy, sc), partners=partners,
                 partners_total_rs=round(sum(p.disbursed_rs for p in partners), 2), partners_loans=sum(p.loans or 0 for p in partners),
                 **an.loan_reconciliation(fy, sc))


@app.get("/api/institutes", response_model=Institutes)
def institutes(fy: str = Depends(fy_param), sc: Scope = Depends(scope_param), an: Analytics = Depends(get_analytics),
               store: AppStore | None = Depends(optional_store)):
    return _institutes(fy, an, store, sc)


@app.get("/api/institutes/{institute_id}", response_model=InstituteDetail)
def institute_detail(institute_id: str, fy: str = Depends(fy_param), sc: Scope = Depends(scope_param),
                     an: Analytics = Depends(get_analytics), store: AppStore | None = Depends(optional_store)):
    # A school page always shows that school: only the month range applies.
    months_only = Scope(m_from=sc.m_from, m_to=sc.m_to, inst=institute_id)
    inst = next(iter(_institutes(fy, an, store, months_only).institutes), None)
    if inst is None:
        raise NotFound(f"Institute {institute_id} has no collections in the selected months of FY {fy}")
    months, modes, students = an.institute_modes(fy, institute_id, sc)
    return InstituteDetail(institute=inst, branch_list=an.branches(institute_id), months=months, modes=modes,
                           students=students, gateway_partner={g: an.is_partner(g) for g in inst.gateways})


@app.get("/api/filter-options", response_model=FilterOptions)
def filter_options(fy: str = Depends(fy_param), an: Analytics = Depends(get_analytics), store: AppStore | None = Depends(optional_store)):
    """Options for every filter, from the whole FY (unfiltered) so choices never disappear."""
    inst = _institutes(fy, an, store)
    base = an.filter_options(fy, inst)
    buckets: dict[str, int] = {}
    owners: dict[str, int] = {}
    for i in inst.institutes:
        b = branch_bucket(i.branches)
        buckets[b] = buckets.get(b, 0) + 1
        if i.owner:
            owners[i.owner] = owners.get(i.owner, 0) + 1
    return FilterOptions(
        dbs=base["dbs"], gateways=base["gateways"], partners=base["partners"], coverage=base["coverage"],
        branches=[FilterOption(value=v, label=l, count=buckets.get(v, 0)) for v, l, _, _ in BRANCH_BUCKETS if buckets.get(v)],
        owners=[FilterOption(value=o.id, label=o.name, count=owners.get(o.id, 0)) for o in configured_owners()],
        months=an.fy_month_labels(fy),
        modes=an.mode_options(fy),
        gw_kinds=_gw_kind_options(an, inst),
        institutes=[FilterOption(value=i.id, label=f"{i.name} — {i.db}", count=0, pg=PG_FILTER_OF.get(i.partner_status, ""))
                    for i in sorted(inst.institutes, key=lambda i: i.name.lower())])


GW_KIND_LABELS = {"partner": "Our partner gateway", "non_partner": "Not our partner",
                  "unknown": "Not in our gateway list"}   # inactive gateways (IsActive 0) are not offered


def _gw_kind_options(an: Analytics, inst: Institutes) -> list[FilterOption]:
    counts: dict[str, int] = {}
    for i in inst.institutes:
        for k in {an.gateway_kind(g) for g in i.gateways}:
            counts[k] = counts.get(k, 0) + 1
    return [FilterOption(value=k, label=l, count=counts.get(k, 0)) for k, l in GW_KIND_LABELS.items()]


@app.get("/api/alerts", response_model=list[Alert])
def alerts(fy: str = Depends(fy_param), sc: Scope = Depends(scope_param), an: Analytics = Depends(get_analytics),
           store: AppStore | None = Depends(optional_store)):
    summary, gws = an.gateways(fy, sc)
    inst = _institutes(fy, an, store, sc)
    gen = an.generated_at().strftime("%d %b, %H:%M")
    out = insights.alerts(gws, inst.institutes, inst.months, Freshness(org_wise=gen, modes=gen, gateway=gen),
                          check_duplicates=not summary.attributed)
    denied = an.gateway_map().denied
    if denied:
        out.append(Alert(severity="danger", title="Gateway mapping incomplete.",
                         text=f"{len(denied)} tenant database(s) deny SELECT on their gateway view, so those institutes show “Mapping not readable”."))
    return out


# ---------------- commission & AI suggestions ----------------
def rate_param(rate: Optional[float] = Query(None, gt=0, le=500, description="Commission rate in basis points chosen in the filter bar")) -> Optional[float]:
    return rate


def _settings_or_default(store: AppStore | None, rate_bps: Optional[float] = None) -> RevenueSettings:
    st = store.get_settings() if store else RevenueSettings()
    return st.model_copy(update={"take_bps": rate_bps}) if rate_bps else st


def _commission(fy: str, sc: Scope, an: Analytics, store: AppStore | None,
                rate_bps: Optional[float] = None) -> tuple[CommissionView, Institutes, list[str]]:
    inst = _institutes(fy, an, store, sc)
    _, months, _ = an.scoped(fy, sc)
    labels = [an.label(m) for m in months]
    return commission_view(an, fy, sc, inst.institutes, len(months), _settings_or_default(store, rate_bps)), inst, labels


@app.get("/api/commission", response_model=CommissionView)
def commission(fy: str = Depends(fy_param), sc: Scope = Depends(scope_param), rate: Optional[float] = Depends(rate_param),
               an: Analytics = Depends(get_analytics), store: AppStore | None = Depends(optional_store)):
    """What MCB earns now (active partner-gateway volume × commission rate) and the four levers to grow it.
    ?rate= (bps) overrides the saved rate — the user picks it in the filter bar."""
    return _commission(fy, sc, an, store, rate)[0]


@app.get("/api/ai/status")
def ai_status():
    adv = get_advisor()
    return {"enabled": adv.enabled, "model": _settings.ai_model, "effort": _settings.ai_effort}


@app.post("/api/suggestions", response_model=SuggestionsOut)
def suggestions(body: SuggestionsIn, fy: str = Depends(fy_param), sc: Scope = Depends(scope_param),
                rate: Optional[float] = Depends(rate_param),
                an: Analytics = Depends(get_analytics), store: AppStore | None = Depends(optional_store)):
    """Claude reads the live figures for the current filters (or one school) and returns prioritised actions."""
    st = _settings_or_default(store, rate)
    snapshot = an.snapshot().isoformat()
    if body.institute_id:
        months_only = Scope(m_from=sc.m_from, m_to=sc.m_to, modes=sc.modes, inst=body.institute_id)
        inst = next(iter(_institutes(fy, an, store, months_only).institutes), None)
        if inst is None:
            raise NotFound(f"Institute {body.institute_id} has no collections in the selected months")
        months, modes, _ = an.institute_modes(fy, body.institute_id, sc)
        peers = _institutes(fy, an, store, Scope(m_from=sc.m_from, m_to=sc.m_to)).institutes
        ctx = institute_context(an, fy, inst, months, modes, an.branches(body.institute_id), peers, st)
        scope_label = f"one school: {inst.name} ({inst.db})"
    else:
        cv, inst_all, months = _commission(fy, sc, an, store, rate)
        if not inst_all.institutes:
            raise NotFound("No institutes match the current filters")
        ctx = portfolio_context(an, fy, sc, inst_all.institutes, months, cv, st)
        scope_label = "portfolio under the current filters"
    return get_advisor().suggest(scope_label, ctx, snapshot, refresh=body.refresh)


# ---------------- account work (local store) ----------------
def _actor(request: Request) -> str:
    u = getattr(request.state, "user", None) or {}
    return u.get("email") or u.get("name") or ""


@app.patch("/api/institutes/owner")
def assign_owner(body: AssignOwner, request: Request, an: Analytics = Depends(get_analytics), store: AppStore = Depends(get_store)):
    names = {o.id: o.name for o in configured_owners()}
    if body.owner and body.owner not in names:
        raise HTTPException(422, f"Unknown owner {body.owner}; configure MCB_OWNERS in backend/.env")
    n = store.assign_owner(body.ids, body.owner)
    store.log_activity_named(an, body.ids, _actor(request), "owner",
                       f"Account owner set to {names[body.owner]}" if body.owner else "Account owner removed")
    return {"updated": n}


def _owner_access(institute_id: str, request: Request, an: Analytics, store: AppStore) -> tuple[list[str], bool]:
    """(assigned owner names, whether the signed-in user is one of them). An owner is matched to their
    MyClassBoard login by name among the pipeline-owner users in dbo.Users (their EmailID)."""
    owners = list(dict.fromkeys(store.deal_owners(institute_id)))
    email = (getattr(request.state, "user", None) or {}).get("email", "").lower()
    mails = {o["name"].lower(): o["email"] for o in an.pipeline_owners()}
    return owners, bool(email) and any(mails.get(o.lower()) == email for o in owners)


@app.get("/api/institutes/{institute_id}/activity", response_model=ActivityView)
def institute_activity(institute_id: str, request: Request, an: Analytics = Depends(get_analytics),
                       store: AppStore | None = Depends(optional_store)):
    """Everything done against this institute in the portal, newest first. Only for institutes added to the
    pipeline; actions are recorded for every institute, so the history is complete once one is added."""
    if not store or not store.in_pipeline(institute_id):
        return ActivityView()
    owners, can_add = _owner_access(institute_id, request, an, store)
    return ActivityView(owners=owners, can_add=can_add, items=store.activity(institute_id))


@app.post("/api/institutes/{institute_id}/activity", response_model=ActivityView, status_code=201)
def add_institute_activity(institute_id: str, body: ActivityIn, request: Request, an: Analytics = Depends(get_analytics),
                           store: AppStore = Depends(get_store)):
    """Only the institute's assigned pipeline owner can write an activity entry."""
    if not store.in_pipeline(institute_id):
        raise HTTPException(409, "Add this institution to the pipeline first.")
    owners, can_add = _owner_access(institute_id, request, an, store)
    if not can_add:
        who = ", ".join(owners) or "the assigned owner"
        raise HTTPException(403, f"Only {who} can add activity for this institution.")
    me = (request.state.user or {}).get("email", "").lower()
    name = next((o["name"] for o in an.pipeline_owners() if o["email"] == me), _actor(request))
    store.log_activity_named(an, institute_id, name, "activity", body.text.strip())
    return ActivityView(owners=owners, can_add=True, items=store.activity(institute_id))


@app.get("/api/institutes/{institute_id}/notes", response_model=list[Note])
def list_notes(institute_id: str, store: AppStore | None = Depends(optional_store)):
    return store.notes(institute_id) if store else []


@app.post("/api/institutes/{institute_id}/notes", response_model=Note, status_code=201)
def add_note(institute_id: str, body: NoteIn, request: Request, an: Analytics = Depends(get_analytics), store: AppStore = Depends(get_store)):
    _check_inst(institute_id, an)
    note = store.add_note(institute_id, body)
    store.log_activity_named(an, institute_id, _actor(request), "note",
                       f"Note / call logged: {body.text}" + (f" (follow up {body.follow_up})" if body.follow_up else ""))
    return note


@app.post("/api/institutes/{institute_id}/consent-request", status_code=202)
def consent_request(institute_id: str, request: Request, an: Analytics = Depends(get_analytics), store: AppStore = Depends(get_store)):
    _check_inst(institute_id, an)
    store.request_consent(institute_id)
    store.log_activity_named(an, institute_id, _actor(request), "consent", "Reminder consent requested (channels not yet asked are now pending)")
    return {"status": "pending"}


@app.put("/api/institutes/{institute_id}/consent", status_code=204)
def set_consent(institute_id: str, body: ConsentUpdate, request: Request, an: Analytics = Depends(get_analytics), store: AppStore = Depends(get_store)):
    _check_inst(institute_id, an)
    store.set_consent(institute_id, body.channel, body.state)
    store.log_activity_named(an, institute_id, _actor(request), "consent",
                       f"{CHANNEL_NAME.get(body.channel, body.channel)} reminder consent set to {CONSENT_NAME.get(body.state, body.state)}")


@app.get("/api/pipeline/owners", response_model=list[Owner])
def pipeline_owners(an: Analytics = Depends(get_analytics)):
    """Who a new pipeline deal can be assigned to: the active Fintech users in dbo.Users."""
    return [Owner(id=o["id"], name=o["name"]) for o in an.pipeline_owners()]


@app.get("/api/pipeline", response_model=Pipeline)
def pipeline(store: AppStore | None = Depends(optional_store)):
    return Pipeline(stages=STAGES, deals=store.deals() if store else [])


@app.post("/api/pipeline", response_model=Deal, status_code=201)
def add_deal(body: DealIn, request: Request, an: Analytics = Depends(get_analytics), store: AppStore = Depends(get_store)):
    _check_inst(body.institute_id, an)
    if store.find_open_deal(body.institute_id, body.play):
        raise Conflict("This institute is already in the pipeline for this play")
    owner = body.owner if body.owner is not None else store.owners_by_institute().get(body.institute_id, "")
    deal = store.add_deal(body, owner)
    store.log_activity_named(an, body.institute_id, _actor(request), "pipeline",
                       f"Added to pipeline: {body.play}" + (f" · owner {owner}" if owner else ""))
    return deal


@app.patch("/api/pipeline/{deal_id}", response_model=Deal)
def move_deal(deal_id: str, body: DealMove, request: Request, an: Analytics = Depends(get_analytics), store: AppStore = Depends(get_store)):
    if body.stage not in STAGE_IDS:
        raise NotFound(f"Stage {body.stage} not found")
    before = store.deal(deal_id)
    d = store.move_deal(deal_id, body.stage)
    if d is None:
        raise NotFound(f"Deal {deal_id} not found")
    if before and before["stage"] != body.stage:
        store.log_activity_named(an, d.institute_id, _actor(request), "pipeline",
                           f"Pipeline stage {STAGE_NAME.get(before['stage'], before['stage'])} → {STAGE_NAME.get(body.stage, body.stage)}: {d.play}")
    return d


@app.delete("/api/pipeline/{deal_id}", status_code=204)
def remove_deal(deal_id: str, request: Request, an: Analytics = Depends(get_analytics), store: AppStore = Depends(get_store)):
    """Take a deal off the pipeline. The institute's activity keeps a record of it."""
    d = store.delete_deal(deal_id)
    if d is None:
        raise NotFound(f"Deal {deal_id} not found")
    store.log_activity_named(an, d["institute_id"], _actor(request), "pipeline",
                             f"Removed from pipeline: {d['play']} (was {STAGE_NAME.get(d['stage'], d['stage'])}"
                             + (f", owner {d['owner']})" if d["owner"] else ")"))


@app.post("/api/campaigns", response_model=CampaignOut, status_code=201)
def save_campaign(body: CampaignIn, request: Request, an: Analytics = Depends(get_analytics), store: AppStore = Depends(get_store)):
    cid = store.save_campaign(body)
    ids = body.institute_ids if body.scope == "selected" else [
        i for i, c in store.consent_by_institute().items() if "y" in (c.sms, c.wa, c.app)]
    store.log_activity_named(an, ids, _actor(request), "campaign", f"Included in campaign \"{body.name}\" ({body.status})")
    return CampaignOut(id=cid, status=body.status, institutes=len(ids))


@app.get("/api/campaigns/due-students", response_model=DueStudents)
def campaign_due_students(ids: str = "", month: str = "", filters: str = ""):
    """?ids=DB:Org,DB:Org[&month=yyyy-mm,yyyy-mm][&filters=due_7d,partially_paid] — per selected school, students with unpaid
    fee instalments due this financial year (in `month`, matching any of `filters`), from its fee search index: the
    same list the pop-up shows (None = no index for that school)."""
    wanted = list(dict.fromkeys(i.strip() for i in ids.split(",") if i.strip()))[:200]
    month = ",".join(m for m in (month or "").split(",") if re.fullmatch(r"\d{4}-\d{2}", m.strip()))
    flt = [x.strip() for x in filters.split(",") if x.strip()]

    def one(iid: str):
        db, _, org = iid.rpartition(":")
        if not re.fullmatch(r"[A-Za-z0-9_]+", db) or not org.isdigit():
            return iid, None
        try:
            return iid, due_count(db, int(org), month, flt)
        except SearchUnavailable:
            return iid, None
    with ThreadPoolExecutor(max_workers=6) as pool:
        return DueStudents(schools=dict(pool.map(one, wanted)))


@app.get("/api/campaigns/due-months")
def campaign_due_months(month: int = Query(..., ge=1, le=12), year: int = Query(..., ge=2015, le=2100),
                        an: Analytics = Depends(get_analytics)):
    """Due month-wise organisations: the schools with fees due in that month, from MCBMaster's
    dbo.USP_GET_OrganisationDueMonths (demo organisations left out). Cached 10 minutes per month."""
    rows = an._cached(f"duemonths:{year}:{month}", lambda: an._all(
        "EXEC dbo.USP_GET_OrganisationDueMonths @MonthNo = :m, @YearNo = :y", m=month, y=year), ttl=600)
    known = {k.lower(): k for k in an.institute_names()}
    seen, out = set(), []
    for r in rows:
        iid = f"{r['DBName']}:{r['OrganisationID']}"
        if iid.lower() in seen:
            continue
        seen.add(iid.lower())
        out.append({"id": known.get(iid.lower(), iid), "db": r["DBName"], "org_id": int(r["OrganisationID"]),
                    "name": " ".join((r["Organisation"] or "").split()) or iid, "in_portal": iid.lower() in known})
    out.sort(key=lambda x: x["name"].lower())
    return {"month": month, "year": year, "label": rows[0]["MonthDisp"] if rows else f"{month:02d}/{year}", "schools": out}


@app.get("/api/campaigns/preload-status")
def campaign_preload_status():
    """How far the background fee-due preload has got (institutions read, instalments held)."""
    return preload_status()


@app.get("/api/campaigns/student-totals")
def campaign_student_totals(ids: str = ""):
    """?ids=DB:Org,DB:Org — active students in each school's current academic year, from its student search index
    (None = no index for that school)."""
    wanted = list(dict.fromkeys(i.strip() for i in ids.split(",") if i.strip()))[:200]

    def one(iid: str):
        db, _, org = iid.rpartition(":")
        if not re.fullmatch(r"[A-Za-z0-9_]+", db) or not org.isdigit():
            return iid, None
        try:
            return iid, total_students(db, int(org))
        except SearchUnavailable:
            return iid, None
    with ThreadPoolExecutor(max_workers=6) as pool:
        return {"schools": dict(pool.map(one, wanted))}


@app.get("/api/campaigns/due-students/{institute_id}", response_model=DueList)
def campaign_due_list(institute_id: str, an: Analytics = Depends(get_analytics)):
    """One school's students with unpaid fee instalments due this financial year (fee search index)."""
    db, _, org = institute_id.rpartition(":")
    if not re.fullmatch(r"[A-Za-z0-9_]+", db) or not org.isdigit():
        raise NotFound(f"Institute {institute_id} not found")
    r = due_list(db, int(org))
    pg = {b["name"].strip().lower(): list(b["gateways"])
          for b in an.org_gateways().get(institute_id, {}).get("branches", {}).values() if b.get("name")}
    return DueList(institute_id=institute_id, institute=an.institute_names().get(institute_id, institute_id), branch_pg=pg, **r)


@app.post("/api/campaigns/test", status_code=202)
def campaign_test(body: CampaignIn, request: Request, an: Analytics = Depends(get_analytics)):
    """WhatsApp on: send the fee-reminder template, filled with sample values, to MCB_WHATSAPP_TEST_NUMBER only.
    Other channels are not connected yet, so they are only validated."""
    if "wa" not in body.channels:
        return {"status": "queued", "to": request.state.user["email"]}
    to = _settings.whatsapp_test_number
    if not to:
        raise HTTPException(400, "Set MCB_WHATSAPP_TEST_NUMBER to receive the WhatsApp test")
    first = body.institute_ids[0] if body.institute_ids else ""
    inst = an.institute_names().get(first, "Your school") if first else "Your school"
    today = date.today()
    sample = {**_test_sample(), "parent_name": "Parent", "institute": inst}
    tpl = whatsapp.fee_template(7)
    r = whatsapp.send_template(to, sample, tpl, _settings.whatsapp_test_pay_code)
    log.info("WhatsApp test sent by %s (template %s): %s", _actor(request), tpl, r)
    return {"status": "sent", "channel": "WhatsApp", "to": "…" + whatsapp.phone(to)[-4:], "provider": r}


def _test_sample() -> dict:
    """The fixed values of every test message: the test student (settings.whatsapp_test_*), due in 7 days."""
    return {"amount_due": _settings.whatsapp_test_amount, "student_name": _settings.whatsapp_test_student,
            "due_date": (datetime.now() + timedelta(days=7)).strftime("%d %b %Y")}


_test_sends: dict[str, list[float]] = {}   # signed-in user -> times of their test sends (last hour)
TEST_SENDS_PER_HOUR = 20


@app.post("/api/whatsapp/test-send")
def whatsapp_test_send(body: WhatsAppTestIn, request: Request, store: AppStore | None = Depends(optional_store)):
    """Campaigns > "Send test to me": one template, filled with sample values, to the mobile number typed in the pop-up."""
    choices = [t.strip() for t in _settings.aisensy_template_choices.split(",") if t.strip()]
    if body.template not in choices:
        raise HTTPException(400, f"Unknown WhatsApp template {body.template}")
    num = whatsapp.phone(body.to)
    if not num:
        raise HTTPException(400, "Enter a valid 10-digit mobile number")
    who = _actor(request)
    now = time.time()
    recent = [t for t in _test_sends.get(who, []) if now - t < 3600]
    if len(recent) >= TEST_SENDS_PER_HOUR:
        raise HTTPException(429, f"At most {TEST_SENDS_PER_HOUR} test messages an hour; try again later")
    _test_sends[who] = recent + [now]
    sample = _test_sample()
    r = whatsapp.send_template(num, sample, body.template, _settings.whatsapp_test_pay_code)
    msg = (r.get("messages") or [{}])[0] if isinstance(r, dict) else {}
    log.info("WhatsApp test %s by %s to …%s: %s %s", body.template, who, num[-4:], msg.get("id"), msg.get("message_status"))
    if store:   # a test has no school: Download App answers with the common MCB parent app
        store.record_wa_sent([{"message_id": msg.get("id"), "phone": num, "institute_id": "", "institute_name": "",
                               "template": body.template, "student_name": sample["student_name"],
                               "pay_code": _settings.whatsapp_test_pay_code,
                               "test": True}])
    return {"to": "…" + num[-4:], "template": body.template, "message_id": msg.get("id"), "status": msg.get("message_status")}


@app.post("/api/campaigns/whatsapp-send")
def campaign_whatsapp_send(body: WhatsAppSendIn, request: Request, an: Analytics = Depends(get_analytics),
                           store: AppStore | None = Depends(optional_store)):
    """Fee reminder on WhatsApp to the parents of the students ticked in the fee-due pop-up: father's number,
    else mother's. Until MCB_WHATSAPP_SEND_TO_PARENTS is true, every message goes to MCB_WHATSAPP_TEST_NUMBER
    instead (at most MCB_WHATSAPP_TEST_LIMIT per send), filled with the real student's details."""
    db, _, org = body.institute_id.rpartition(":")
    if not re.fullmatch(r"[A-Za-z0-9_]+", db) or not org.isdigit():
        raise NotFound(f"Institute {body.institute_id} not found")
    live = _settings.whatsapp_send_to_parents
    test_to = _settings.whatsapp_test_number
    if not live and not whatsapp.phone(test_to):
        raise HTTPException(400, "Test mode: set MCB_WHATSAPP_TEST_NUMBER to receive the reminders")
    inst = an.institute_names().get(body.institute_id, body.institute_id)
    choices = [t.strip() for t in _settings.aisensy_template_choices.split(",") if t.strip()]
    if body.template and body.template not in choices:
        raise HTTPException(400, f"Unknown WhatsApp template {body.template}")
    lst = due_list(db, int(org))
    by_id, today = {s["id"]: s for s in lst["students"]}, lst["today"]   # India date
    parents = parents_for(db, int(org), [i for i in dict.fromkeys(body.student_ids) if i in by_id])
    by_id = {i: {**s, **parents.get(i, {})} for i, s in by_id.items() if i in parents or i in body.student_ids}
    jobs, skipped = [], []
    for sid in dict.fromkeys(body.student_ids):
        s = by_id.get(sid)
        if not s:
            skipped.append({"id": sid, "reason": "no unpaid fees"}); continue
        dues = pick_dues(s, today, body.month, body.filters)
        if not dues:
            skipped.append({"id": sid, "name": s["name"], "reason": "outside the chosen month / parents"}); continue
        parent, num = next(((s.get(n) or "Parent", s.get(n + "_phone")) for n in ("father", "mother")
                            if whatsapp.phone(s.get(n + "_phone"))), (None, None))
        if not num:
            skipped.append({"id": sid, "name": s["name"], "reason": "no parent mobile number"}); continue
        first = min((d[0] for d in dues if d[0]), default=None)
        values = {"parent_name": parent, "student_name": s["name"], "institute": inst,
                  "amount_due": f"{sum(d[1] for d in dues):,.0f}", "due_date": first.strftime("%d %b %Y") if first else ""}
        tpl = body.template or whatsapp.fee_template((first - today).days if first else None)
        jobs.append((s, num if live else test_to, values, tpl))
    codes = _pay_codes(an, db, [j[0]["id"] for j in jobs])
    for j in [j for j in jobs if j[0]["id"] not in codes]:
        skipped.append({"id": j[0]["id"], "name": j[0]["name"], "reason": "no payment link code"})
    jobs = [(*j, codes[j[0]["id"]]) for j in jobs if j[0]["id"] in codes]
    if not live:
        jobs = jobs[:max(_settings.whatsapp_test_limit, 0)]

    def one(job):
        s, to, values, tpl, code = job
        try:
            r = whatsapp.send_template(to, values, tpl, code)
            msg = (r.get("messages") or [{}])[0] if isinstance(r, dict) else {}
            log.info("WhatsApp %s to …%s for %s: %s %s", tpl, whatsapp.phone(to)[-4:], s["id"], msg.get("id"), msg.get("message_status"))
            return {"id": s["id"], "name": s["name"], "ok": True, "template": tpl, "message_id": msg.get("id"),
                    "status": msg.get("message_status"), "to": whatsapp.phone(to), "code": code}
        except whatsapp.WhatsAppUnavailable as e:
            return {"id": s["id"], "name": s["name"], "ok": False, "error": str(e)}
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(one, jobs))
    if store:
        store.record_wa_sent([{"message_id": r["message_id"], "phone": r["to"], "institute_id": body.institute_id,
                               "institute_name": inst, "template": r["template"], "student_name": r["name"],
                               "pay_code": r["code"], "test": not live} for r in results if r["ok"]])
    for r in results:
        r.pop("to", None)
        r.pop("code", None)
    sent = sum(r["ok"] for r in results)
    log.info("WhatsApp fee reminders by %s for %s: %d sent, %d failed, %d skipped (%s)", _actor(request), body.institute_id,
             sent, len(results) - sent, len(skipped), "parents" if live else "test number")
    return {"test_mode": not live, "to": None if live else "…" + whatsapp.phone(test_to)[-4:], "sent": sent,
            "failed": [r for r in results if not r["ok"]], "skipped": skipped,
            "not_sent_test_limit": 0 if live else max(len(dict.fromkeys(body.student_ids)) - len(skipped) - len(jobs), 0)}


@app.post("/api/campaigns/push-send")
def campaign_push_send(body: PushSendIn, request: Request, an: Analytics = Depends(get_analytics)):
    """Fee reminder as a mobile-app notification ("Fee due <date>" + amount, student and a pay prompt) to the parents of the students ticked in the fee-due pop-up. A student
    is reached only if its parent login (dbo.Users, PersonalID = StudentEnrollmentID) is active and has a logged-in app
    device. Until MCB_PUSH_SEND_TO_PARENTS is true, everything goes to MCB_PUSH_TEST_TOKEN instead (at most
    MCB_PUSH_TEST_LIMIT per send), filled with the real student's details."""
    db, _, org = body.institute_id.rpartition(":")
    if not re.fullmatch(r"[A-Za-z0-9_]+", db) or not org.isdigit():
        raise NotFound(f"Institute {body.institute_id} not found")
    live, test_tok = _settings.push_send_to_parents, _settings.push_test_token.strip()
    if not live and not test_tok:
        raise HTTPException(400, "Test mode: set MCB_PUSH_TEST_TOKEN to receive the notifications")
    key = mobile_app.fcm_key(an, db, int(org))
    if not key:
        raise HTTPException(400, "This school has no push setup (MobileAppGCMSenderDetails.FCMPrivateKey_Json)")
    inst = an.institute_names().get(body.institute_id, body.institute_id)
    lst = due_list(db, int(org))
    by_id, today = {s["id"]: s for s in lst["students"]}, lst["today"]
    ids = list(dict.fromkeys(body.student_ids))
    devices = mobile_app.device_tokens(an, db, int(org), ids)
    jobs, skipped = [], []
    for sid in ids:
        s = by_id.get(sid)
        if not s:
            skipped.append({"id": sid, "reason": "no unpaid fees"}); continue
        dues = pick_dues(s, today, body.month, body.filters)
        if not dues:
            skipped.append({"id": sid, "name": s["name"], "reason": "outside the chosen month / parents"}); continue
        if sid not in devices:
            skipped.append({"id": sid, "name": s["name"], "reason": "parent not logged in to the app"}); continue
        first = min((d[0] for d in dues if d[0]), default=None)
        vals = {"student_name": s["name"], "institute": inst, "amount_due": f"{sum(d[1] for d in dues):,.0f}",
                "due_date": first.strftime("%d %b %Y") if first else ""}
        title = (body.title or "Fee due {due_date}").format(**vals).strip()
        text = (body.message or "₹{amount_due} for {student_name}. Tap to pay securely — UPI, card or EMI.").format(**vals)
        jobs.append((s, devices[sid] if live else [test_tok], title, text))
    if not live:
        jobs = jobs[:max(_settings.push_test_limit, 0)]

    def one(job):
        s, tok, title, text = job
        try:
            r = mobile_app.send(tok, key, title, text)
            log.info("Push to %d device(s) for %s: %s", len(tok), s["id"], str(r)[:120])
            return {"id": s["id"], "name": s["name"], "ok": True, "response": r}
        except mobile_app.PushUnavailable as e:
            return {"id": s["id"], "name": s["name"], "ok": False, "error": str(e)}
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(one, jobs))
    sent = sum(r["ok"] for r in results)
    log.info("Push fee reminders by %s for %s: %d sent, %d failed, %d skipped (%s)", _actor(request), body.institute_id,
             sent, len(results) - sent, len(skipped), "parents" if live else "test device")
    return {"test_mode": not live, "sent": sent, "failed": [r for r in results if not r["ok"]], "skipped": skipped,
            "reachable_students": sum(1 for s in ids if s in devices)}


def _pay_codes(an: Analytics, db: str, ids: list[int]) -> dict[int, str]:
    """Student id -> StdAlphaNumericCode (MCBStudentEnrollment): the part of the pay link after https://fee.s.gy/."""
    out: dict[int, str] = {}
    ids = [int(i) for i in ids]
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        rows = an._all(f"""SELECT StudentEnrollmentID id, StdAlphaNumericCode code FROM MCBStudentEnrollment
                           WHERE DBName = :db AND StudentEnrollmentID IN ({",".join(str(x) for x in part)})""", db=db)
        out.update({int(r["id"]): r["code"].strip() for r in rows if (r["code"] or "").strip()})
    return out


def _app_links(an: Analytics, db: str, org: int) -> dict[str, str]:
    """The school's parent-app store links ([MCB-Web].dbo.MobileAppSchools) for the Download App reply; a null, blank or
    0 link falls back to the common MCB parent app."""
    rows = an._all("""SELECT TOP 1 AppPlayStoreUrl android, IOSAppStoreUrl ios FROM [MCB-Web].dbo.MobileAppSchools WITH (NOLOCK)
                      WHERE DBName = :db AND OrganisationID = :org""", db=db, org=int(org))
    r = rows[0] if rows else {}
    ok = lambda v: (v or "").strip() if (v or "").strip() not in ("", "0") else ""
    return {"android": ok(r.get("android")) or _settings.app_default_android,
            "ios": ok(r.get("ios")) or _settings.app_default_ios}


def app_reply_text(an: Analytics, sent: dict | None) -> str:
    """The Download App reply for the school a reminder was sent for (common MCB parent app when unknown)."""
    iid = (sent or {}).get("institute_id") or ""
    db, _, org = iid.rpartition(":")
    links = (_app_links(an, db, int(org)) if re.fullmatch(r"[A-Za-z0-9_]+", db or "-") and org.isdigit()
             else {"android": _settings.app_default_android, "ios": _settings.app_default_ios})
    name = " ".join(((sent or {}).get("institute_name") or "").split()) or "MCB Parent"
    return _settings.whatsapp_app_reply.format(institute=name, ios=links["ios"], android=links["android"])


def has_emi_gateway(an: Analytics, institute_id: str) -> bool:
    """True when any branch of the institute uses the EMI / fee-loan gateway (settings.whatsapp_emi_gateway)."""
    want = _settings.whatsapp_emi_gateway.strip().lower()
    iid = (institute_id or "").lower()
    if not want or not iid:
        return False
    for k, o in an.org_gateways().items():
        if k.lower() == iid:
            return any(want in (g or "").lower() for g in o["gateways"])
    return False


def emi_reply_text(an: Analytics, sent: dict) -> str | None:
    """The Check EMI & Loan reply for the reminder's student and school; None without a pay link code."""
    code = (sent.get("pay_code") or "").strip()
    if not code:
        return None
    tpl = _settings.whatsapp_emi_reply_yes if has_emi_gateway(an, sent.get("institute_id") or "") else _settings.whatsapp_emi_reply_no
    return tpl.format(student=" ".join((sent.get("student_name") or "").split()) or "your ward",
                      institute=" ".join((sent.get("institute_name") or "").split()) or "the school",
                      payment_link=f"https://fee.s.gy/{code}")


def _hook_secret_ok(secret: str) -> None:
    want = _settings.whatsapp_webhook_secret.get_secret_value()
    if not want or not hmac.compare_digest(secret.encode(), want.encode()):
        raise HTTPException(404, "Not found")


@app.get("/api/wa-hook/{secret}", include_in_schema=False)
def whatsapp_webhook_view(secret: str, date: str = Query("", pattern=r"^(\d{4}-\d{2}-\d{2})?$"),
                          message_id: str = Query("", max_length=200), limit: int = Query(100, ge=1, le=1000)):
    """The webhook URL opened in a browser: what AiSensy has sent to it, newest first, as JSON with dates.
    ?date=yyyy-mm-dd (India date received), ?message_id=wamid..., ?limit= (default 100, at most 1000)."""
    _hook_secret_ok(secret)
    store = get_store()
    events = store.wa_feed(date, message_id, limit)
    return JSONResponse({"webhook": "AiSensy -> fri.myclassboard.com", "now": datetime.now().astimezone().isoformat(timespec="seconds"),
                         "filters": {"date": date or None, "message_id": message_id or None, "limit": limit},
                         "count": len(events), "events": events},
                        headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"})


@app.post("/api/wa-hook/{secret}", include_in_schema=False)
async def whatsapp_webhook(secret: str, request: Request):
    """AiSensy's webhook: delivery statuses of our messages and parents' replies and button taps, all recorded in
    portal.wa_events. A "Download App" tap on a fee reminder is answered with the school's app store links. Always
    answers 200 for a valid secret, so AiSensy does not retry."""
    _hook_secret_ok(secret)
    raw = await request.body()
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        payload = {"body": raw.decode("utf-8", "replace")[:20000]}
    await run_in_threadpool(_handle_webhook, payload)
    return {"ok": True}


def _handle_webhook(payload) -> None:
    store = optional_store()
    events = whatsapp.webhook_events(payload)
    if store:
        store.record_wa_events(events)
    log.info("WhatsApp webhook: %s", ", ".join(f"{e['kind']} {e['status'] or ''} …{(e['phone'] or '')[-4:]}".strip() for e in events)[:500])
    taps = whatsapp.button_taps(payload)
    if not taps:
        return
    an = get_analytics()
    buttons = {_settings.whatsapp_app_button.strip().lower(): ("Download App", lambda sent: app_reply_text(an, sent)),
               _settings.whatsapp_emi_button.strip().lower(): ("Check EMI & Loan", lambda sent: emi_reply_text(an, sent))}
    for t in taps:
        num = whatsapp.phone(t["from"]) or ""
        button = buttons.get(t["text"].strip().lower())
        if not button or not num:
            log.info("WhatsApp tap %r from …%s ignored", t["text"][:40], num[-4:])
            continue
        label, reply = button
        if store and t["id"] and not store.wa_first_time(t["id"]):
            continue
        sent = store.wa_sent_for(t["context_id"], num) if store else None
        if not sent:
            log.info("WhatsApp %s tap from …%s: no reminder of ours found, not answered", label, num[-4:])
            continue
        try:
            body = reply(sent)
            if not body:
                log.info("WhatsApp %s tap from …%s: no pay link code for that reminder, not answered", label, num[-4:])
                continue
            r = whatsapp.send_text(num, body)
            msg = (r.get("messages") or [{}])[0] if isinstance(r, dict) else {}
            log.info("WhatsApp %s reply to …%s for %s: %s %s", label, num[-4:], sent["institute_id"] or "test",
                     msg.get("id"), msg.get("message_status"))
        except Exception:
            log.exception("WhatsApp %s reply to …%s failed", label, num[-4:])


@app.get("/api/whatsapp/report")
def whatsapp_report(days: int = Query(30, ge=1, le=3650), store: AppStore = Depends(get_store)):
    """WhatsApp messages sent from the portal (campaigns and "Send test to me"), per institution, with delivery, read,
    failed and button-tap counts (from AiSensy's webhook) and how many were tests. Messages of other systems on the
    same AiSensy account are not counted."""
    rows = store.wa_report(days, _settings.whatsapp_app_button, _settings.whatsapp_emi_button)
    keys = ("sent", "tests", "delivered", "read", "failed", "download_app", "check_emi")
    return {"days": days, "test_mode": not _settings.whatsapp_send_to_parents, "institutes": rows,
            "totals": {**{k: sum(r[k] for r in rows) for k in keys}, "institutes": len(rows)}}


@app.get("/api/whatsapp/report/messages")
def whatsapp_report_messages(institute_id: str = Query("", max_length=120), days: int = Query(30, ge=1, le=3650),
                             store: AppStore = Depends(get_store)):
    """The messages behind one row of the WhatsApp report (institute_id '' = "Send test to me" messages)."""
    return {"messages": store.wa_report_messages(institute_id, days, _settings.whatsapp_app_button, _settings.whatsapp_emi_button)}


@app.get("/api/whatsapp/events")
def whatsapp_events(message_id: str = Query("", max_length=200), limit: int = Query(100, ge=1, le=500),
                    store: AppStore = Depends(get_store)):
    """What AiSensy's webhook reported, newest first: delivery statuses and parents' replies (optionally for one message)."""
    return {"events": store.wa_events(message_id, limit)}


@app.get("/api/whatsapp/templates")
def whatsapp_templates():
    """Fee-reminder templates the send step offers, with AiSensy's approval status and text, the due-date rules that
    recommend one per student, and where test-mode messages go."""
    names = [t.strip() for t in _settings.aisensy_template_choices.split(",") if t.strip()]
    try:
        info = whatsapp.template_details()
    except whatsapp.WhatsAppUnavailable as e:
        log.warning("WhatsApp templates: %s", e)
        info = {}
    live = _settings.whatsapp_send_to_parents
    test = whatsapp.phone(_settings.whatsapp_test_number)
    return {"templates": [{"name": n, **info.get(n, {"status": "UNKNOWN", "body": "", "header": "", "footer": "", "buttons": []})} for n in names],
            "rules": whatsapp.template_rules(), "test_mode": not live,
            "test_to": ("…" + test[-4:]) if test and not live else None, "test_limit": _settings.whatsapp_test_limit,
            "test_sample": {**_test_sample(), "student_code": _settings.whatsapp_test_student_code,
                            "pay_link": f"https://fee.s.gy/{_settings.whatsapp_test_pay_code}"}}


@app.get("/api/whatsapp/status")
def whatsapp_status():
    """Checks the AiSensy credentials: Direct API -> a JWT is issued; Partner API -> the partner's projects."""
    return {"templates": _settings.aisensy_templates, **whatsapp.check()}


# ---------------- health ----------------
@app.get("/api/health")
def health():
    from .db import ping
    out: dict = {}
    try:
        r = ping()
        out["analytics"] = {"status": "ok", "database": r["db"], "login": r["login"]}
    except Exception as exc:  # report, don't crash the portal
        out["analytics"] = {"status": "error", "detail": type(exc).__name__}
    out["portal_db"] = {"status": "ok" if optional_store() else "not connected"}
    out["ai"] = {"status": "ok" if get_advisor().enabled else "not configured", "model": _settings.ai_model}
    ok = out["analytics"]["status"] == "ok"
    return JSONResponse({"status": "ok" if ok else "error", **out}, status_code=200 if ok else 503)


@app.get("/api/health/data")
def health_data(fy: str = Depends(fy_param), an: Analytics = Depends(get_analytics)):
    """Accuracy check: portal totals vs a direct SQL sum on MCBOrganisationPaymentsAnalysis, run now."""
    return an.verify_totals(fy)


# ---------------- sign-in ----------------
app.include_router(auth.router)


@app.get("/login", include_in_schema=False)
def login_page(request: Request):
    if request.state.user:
        return RedirectResponse("/", status_code=302)
    return _page("login.html")


# ---------------- frontend ----------------
# Cloudflare gives JS and CSS a one-month browser cache whatever this server sends, so the pages link to them
# under /a/<version>/…, where <version> changes whenever any frontend file changes. A deploy therefore changes
# every asset URL (including the modules app.js imports, which resolve relative to it) and nobody runs stale code.
ASSET_DIRS = ("css", "js", "vendor")
ASSET_REF = re.compile(r'((?:href|src)=")((?:css|js|vendor)/)')


def asset_version() -> str:
    """Fingerprint of every frontend asset's path, size and modified time. Read per page load, so copying new
    files into the frontend folder takes effect without a restart."""
    h = hashlib.sha1()
    for sub in ASSET_DIRS:
        for f in sorted((FRONTEND_DIR / sub).rglob("*")):
            if f.is_file():
                st = f.stat()
                h.update(f"{f.relative_to(FRONTEND_DIR).as_posix()}|{st.st_size}|{st.st_mtime_ns}\n".encode())
    return h.hexdigest()[:12]


def _page(name: str) -> HTMLResponse:
    """index.html / login.html with their css/, js/ and vendor/ links pointed at the versioned path."""
    html = (FRONTEND_DIR / name).read_text(encoding="utf-8")
    base = f"a/{asset_version()}/"
    return HTMLResponse(ASSET_REF.sub(lambda m: m.group(1) + base + m.group(2), html))


@app.get("/a/{version}/{path:path}", include_in_schema=False)
def versioned_asset(version: str, path: str):
    """The current file, whatever <version> says: the version only makes the URL new after a change."""
    target = (FRONTEND_DIR / path).resolve()
    sub = path.split("/", 1)[0]
    if sub not in ASSET_DIRS or (FRONTEND_DIR / sub).resolve() not in target.parents or not target.is_file():
        raise HTTPException(404, "Not found")
    return FileResponse(target, headers={"Cache-Control": "public, max-age=31536000, immutable"})


# Unversioned paths stay for pages that were open before a deploy.
for sub in ASSET_DIRS:
    app.mount(f"/{sub}", StaticFiles(directory=FRONTEND_DIR / sub), name=sub)


@app.get("/", include_in_schema=False)
def index():
    return _page("index.html")
