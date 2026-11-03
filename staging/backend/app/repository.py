"""Wiring: one read-only analytics source (SQL Server) and one local store for portal-only data."""
from __future__ import annotations

import logging
import threading
import time
from functools import lru_cache

from .analytics import Analytics
from .app_store import AppStore
from .config import get_settings
from .schemas import Owner

# Branch-count buckets for the Institutes filter: (value, label, min, max-or-None)
BRANCH_BUCKETS = [("0", "Branches not mapped", 0, 0), ("1", "Single branch", 1, 1),
                  ("2-5", "2–5 branches", 2, 5), ("6+", "6 or more branches", 6, None)]


def branch_bucket(n: int) -> str:
    for value, _, lo, hi in BRANCH_BUCKETS:
        if n >= lo and (hi is None or n <= hi):
            return value
    return BRANCH_BUCKETS[0][0]


class NotFound(Exception):
    pass


class Conflict(Exception):
    pass


@lru_cache
def get_analytics() -> Analytics:
    return Analytics(get_settings())


_store_obj: AppStore | None = None
_store_error = "not connected yet"
_connector_started = False
_connector_lock = threading.Lock()
STORE_RETRY_SECONDS = 30
log = logging.getLogger("mcb.store")


def _connect_loop() -> None:
    """Background thread: connect to PostgreSQL, retrying every STORE_RETRY_SECONDS until it works.
    Requests never wait on this — a stopped PostgreSQL can't slow the portal down."""
    global _store_obj, _store_error
    while _store_obj is None:
        url = get_settings().app_db_url.get_secret_value()
        if not url:
            _store_error = "MCB_APP_DB_URL is not set"
            return
        try:
            _store_obj = AppStore(url)
            _store_error = ""
            log.info("Portal database (PostgreSQL) connected")
            try:                                     # activity log: one-time import of older records, names mandatory
                names = get_analytics().institute_names()
                _store_obj.backfill_activity(names)
                _store_obj.require_activity_names(names)
            except Exception:
                log.exception("Activity back-fill / institute names could not be completed")
            return
        except Exception as exc:
            _store_error = f"{type(exc).__name__}: {str(exc).splitlines()[0][:160]}"
            log.warning("Portal database not reachable (%s); retrying in %ss", _store_error, STORE_RETRY_SECONDS)
            time.sleep(STORE_RETRY_SECONDS)


def start_store_connector() -> None:
    global _connector_started
    with _connector_lock:
        if not _connector_started:
            _connector_started = True
            threading.Thread(target=_connect_loop, name="portal-db-connector", daemon=True).start()


def _store() -> AppStore:
    start_store_connector()
    if _store_obj is None:
        raise RuntimeError(f"portal database unavailable ({_store_error})")
    return _store_obj


class StoreUnavailable(Exception):
    pass


def get_store() -> AppStore:
    """For endpoints that write portal data: fail clearly when PostgreSQL is not reachable."""
    try:
        return _store()
    except Exception as exc:
        raise StoreUnavailable(f"Portal database (PostgreSQL) is not available: {type(exc).__name__}. "
                               "Check MCB_APP_DB_URL in backend/.env.") from exc


def optional_store() -> AppStore | None:
    """For read endpoints: analytics keep working without owners / consent overlays."""
    try:
        return _store()
    except Exception:
        return None


@lru_cache
def get_advisor():
    from .ai import Advisor
    return Advisor(get_settings())


def configured_owners() -> list[Owner]:
    out = []
    for part in get_settings().owners.split(","):
        if part.strip():
            oid, _, name = part.partition(":")
            out.append(Owner(id=oid.strip(), name=(name or oid).strip()))
    return out
