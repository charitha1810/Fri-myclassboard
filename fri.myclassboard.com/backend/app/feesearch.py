"""Students with fees due, from two Azure AI Search indexes per school database (azure-search-documents SDK):
fee instalments from settings.fee_search_index, father / mother details from settings.student_search_index
("index-{db}-feedetails" / "index-{db}-rptstudentsfulldata", {db} = the school's DBName in lower case)."""
from __future__ import annotations

import logging
import threading
import time
from array import array
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

from azure.core.credentials import AzureKeyCredential
from azure.core.exceptions import AzureError, HttpResponseError, ResourceNotFoundError
from azure.search.documents import SearchClient

from .config import get_settings

log = logging.getLogger("mcb.feesearch")

CACHE_TTL = 600        # seconds a school's due list is reused
CACHE_MAX = 40         # full due lists kept at once (the oldest is dropped); counts use the compact summaries below
PAGE = 1000            # fee rows per request, read in FeeInstallmentToStudentID order (no 100,000-row skip limit)
ID_BATCH = 100         # students per parent-details lookup
IST = timezone(timedelta(hours=5, minutes=30))   # due dates are held both as IST midnight in UTC (18:30Z) and as 00:00Z
_cache: dict[str, tuple[float, dict]] = {}

FEE_FIELDS = ["FeeInstallmentToStudentID", "StudentEnrollmentID", "StudentName", "StudentEnrollmentCode", "BranchName", "ClassName", "SectionName",
              "InstallmentAmount", "Concession", "Paid", "DueDate"]
PARENT_FIELDS = ["StudentEnrollmentID", "AcademicYearID", "FatherName", "FatherPhone", "MotherName", "MotherPhone"]


class SearchUnavailable(Exception):
    """A search index is not configured, or it refused or failed the request."""


def _client(endpoint: str, index: str, key: str, what: str) -> SearchClient:
    if not endpoint or not index or not key:
        raise SearchUnavailable(f"{what} search is not configured")
    c = SearchClient(endpoint, index, AzureKeyCredential(key))
    c.mcb_index = index   # for error messages
    return c


def _fee_client(db: str) -> SearchClient:
    s = get_settings()
    return _client(s.fee_search_endpoint, s.fee_search_index.format(db=db.lower()), s.fee_search_key.get_secret_value(), "Fee")


def _student_client(db: str) -> SearchClient:
    s = get_settings()
    return _client(s.student_search_endpoint, s.student_search_index.format(db=db.lower()),
                   s.student_search_key.get_secret_value(), "Student")


def _run(client: SearchClient, **kw) -> list[dict]:
    index = getattr(client, "mcb_index", "index")
    try:
        return list(client.search(search_text="*", **kw))
    except ResourceNotFoundError:
        raise SearchUnavailable(f"No search index {index} for this school") from None
    except HttpResponseError as e:
        log.warning("Search %s failed: %s %s", index, e.status_code, (e.message or "")[:300])
        raise SearchUnavailable(f"Search {index} failed ({e.status_code})") from None
    except AzureError as e:
        log.warning("Search %s unreachable: %s", index, e)
        raise SearchUnavailable(f"Search {index} is unreachable") from None


def _fees(db: str, flt: str) -> list[dict]:
    """Every fee row matching `flt`, a page at a time in FeeInstallmentToStudentID order."""
    client = _fee_client(db)
    out: list[dict] = []
    last = -1
    while True:
        page = _run(client, filter=f"({flt}) and FeeInstallmentToStudentID gt {last}", select=FEE_FIELDS,
                    order_by=["FeeInstallmentToStudentID asc"], top=PAGE)
        out += page
        if len(page) < PAGE:
            return out
        last = page[-1]["FeeInstallmentToStudentID"]


def _day(v) -> date | None:
    try:
        dt = v if isinstance(v, datetime) else datetime.fromisoformat(str(v).replace("Z", "+00:00")) if v else None
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(IST).date() if dt else None
    except ValueError:
        return None


def _txt(v) -> str:
    return " ".join(v.split()) if isinstance(v, str) else ""


def _parents(db: str, org: int, ids: list[int]) -> dict[int, dict]:
    """Father / mother name and phone per StudentEnrollmentID (their most recent academic-year record)."""
    if not ids or not get_settings().student_search_key.get_secret_value():
        return {}
    client = _student_client(db)
    best: dict[int, dict] = {}
    for i in range(0, len(ids), ID_BATCH):
        part = ids[i:i + ID_BATCH]
        flt = f"OrganisationID eq {org} and (" + " or ".join(f"StudentEnrollmentID eq {int(x)}" for x in part) + ")"
        for d in _run(client, filter=flt, select=PARENT_FIELDS):
            sid = d.get("StudentEnrollmentID")
            if sid not in best or (d.get("AcademicYearID") or 0) > (best[sid].get("AcademicYearID") or 0):
                best[sid] = d
    return {sid: {"father": _txt(d.get("FatherName")), "father_phone": _txt(d.get("FatherPhone")),
                  "mother": _txt(d.get("MotherName")), "mother_phone": _txt(d.get("MotherPhone"))}
            for sid, d in best.items()}


def _count(client: SearchClient, flt: str) -> int:
    index = getattr(client, "mcb_index", "index")
    try:
        r = client.search(search_text="*", filter=flt, top=0, include_total_count=True)
        list(r)
        return int(r.get_count() or 0)
    except ResourceNotFoundError:
        raise SearchUnavailable(f"No search index {index} for this school") from None
    except AzureError as e:
        log.warning("Search %s count failed: %s", index, e)
        raise SearchUnavailable(f"Search {index} failed") from None


def total_students(db: str, org: int) -> int:
    """Active students of one organisation in its current academic year (student index): the latest year that has
    active students, or the year before it when that one has more (next year's admissions open early)."""
    key = f"total:{db.lower()}:{org}"
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL * 6:
        return hit[1]
    c = _student_client(db)
    base = f"OrganisationID eq {org} and Active eq true"
    n = 0
    if _count(c, base):
        lo, hi = 0, 1024            # AcademicYearID is filterable but not sortable: find the latest by halving
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if _count(c, f"{base} and AcademicYearID ge {mid}"):
                lo = mid
            else:
                hi = mid - 1
        n = max(_count(c, f"{base} and AcademicYearID eq {lo}"), _count(c, f"{base} and AcademicYearID eq {lo - 1}"))
    _cache[key] = (time.time(), n)
    return n


AUDIENCE_FILTERS = ("due_7d", "partially_paid")   # "Which parents" choices the fee index can answer


def pick_dues(st: dict, today: date, month: str = "", filters=()) -> list:
    """The student's unpaid instalments a campaign is about: those of `month` (yyyy-mm, several comma-separated;
    "" = the whole year), then,
    when filters are chosen, only those matching any of them: due_7d = due from today to 7 days ahead,
    partially_paid = part of the instalment is already paid. [] = the student is not in the audience."""
    months = {m.strip() for m in (month or "").split(",") if m.strip()}
    dues = [d for d in st["dues"] if not months or (d[0] and d[0].strftime("%Y-%m") in months)]
    f = [x for x in filters if x in AUDIENCE_FILTERS]
    if not f:
        return dues
    return [d for d in dues if ("due_7d" in f and d[0] and 0 <= (d[0] - today).days <= 7)
            or ("partially_paid" in f and len(d) > 2 and d[2])]


def _fy(today: date) -> int:
    return today.year if today.month >= 4 else today.year - 1


def _fy_filter(org: int, fy: int) -> str:
    # IST midnight of 1 Apr is 18:30 UTC on 31 Mar; the index holds both 00:00Z and 18:30Z values, so this keeps
    # exactly the India dates 1 Apr fy .. 31 Mar fy+1 (instalments without a due date are left out).
    return (f"OrganisationID eq {org} and Active eq true"
            f" and DueDate ge {fy}-03-31T18:30:00Z and DueDate lt {fy + 1}-03-31T18:30:00Z")


# ---------------- compact summaries for counts (preloaded for every institution) ----------------
_summary: dict[str, tuple[float, dict]] = {}   # "db:org:fy" -> (read at, {sid, day, ym, part: arrays, one entry per unpaid instalment})
_preload = {"started": 0.0, "done": 0, "total": 0, "sweep_ended": 0.0, "running": False, "errors": 0}


def _summarise(docs: list[dict]) -> dict:
    sid, day, ym, part = array("q"), array("l"), array("l"), array("b")
    for d in docs:
        bal = float(d.get("InstallmentAmount") or 0) - float(d.get("Concession") or 0) - float(d.get("Paid") or 0)
        due = _day(d.get("DueDate")) if bal > 0 else None
        if due is None:
            continue
        sid.append(int(d.get("StudentEnrollmentID") or 0)); day.append(due.toordinal())
        ym.append(due.year * 100 + due.month); part.append(1 if float(d.get("Paid") or 0) > 0 else 0)
    return {"sid": sid, "day": day, "ym": ym, "part": part}


def due_count(db: str, org: int, month: str = "", filters=(), max_age: float | None = None) -> int:
    """Students of the organisation with unpaid instalments this financial year, narrowed like pick_dues (months,
    due_7d, partially_paid). Uses the preloaded summary when it is fresh enough, else reads the school once."""
    today = datetime.now(IST).date()
    key = f"{db.lower()}:{org}:{_fy(today)}"
    hit = _summary.get(key)
    limit = max_age if max_age is not None else get_settings().fee_preload_hours * 3600 * 1.5
    if not hit or time.time() - hit[0] > limit:
        due_list(db, org)                       # reads the school and refreshes its summary
        hit = _summary[key]
    s = hit[1]
    months = {int(m.replace("-", "")) for m in (month or "").split(",") if m.strip()}
    f = [x for x in filters if x in AUDIENCE_FILTERS]
    t0 = today.toordinal()
    out = set()
    for i in range(len(s["sid"])):
        if months and s["ym"][i] not in months:
            continue
        if f and not (("due_7d" in f and 0 <= s["day"][i] - t0 <= 7) or ("partially_paid" in f and s["part"][i])):
            continue
        out.add(s["sid"][i])
    return len(out)


def _preload_one(db: str, org: int, fy: int) -> None:
    try:
        docs = _fees(db, _fy_filter(org, fy))
        _summary[f"{db.lower()}:{org}:{fy}"] = (time.time(), _summarise(docs))
    except SearchUnavailable:
        pass                                    # no index for this school: counts show n/a
    except Exception:
        _preload["errors"] += 1
        log.exception("Fee preload failed for %s:%s", db, org)
    finally:
        _preload["done"] += 1


def start_preload(institute_ids) -> None:
    """Read every institution's fee-due summary in the background now and every fee_preload_hours (one thread)."""
    s = get_settings()
    if not s.fee_preload or _preload["running"] or not s.fee_search_key.get_secret_value():
        return
    _preload["running"] = True

    def loop():
        while True:
            try:
                ids = [i for i in institute_ids() if i.rpartition(":")[2].isdigit()]
                fy = _fy(datetime.now(IST).date())
                _preload.update(started=time.time(), done=0, total=len(ids), errors=0)
                log.info("Fee preload: reading %d institutions", len(ids))
                with ThreadPoolExecutor(max_workers=max(s.fee_preload_workers, 1)) as pool:
                    list(pool.map(lambda i: _preload_one(i.rpartition(":")[0], int(i.rpartition(":")[2]), fy), ids))
                _preload["sweep_ended"] = time.time()
                rows = sum(len(v[1]["sid"]) for v in _summary.values())
                log.info("Fee preload: %d institutions in %.0f s, %d unpaid instalments held, %d errors",
                         len(ids), time.time() - _preload["started"], rows, _preload["errors"])
            except Exception:
                log.exception("Fee preload sweep failed")
            time.sleep(max(s.fee_preload_hours, 0.25) * 3600)
    threading.Thread(target=loop, name="fee-preload", daemon=True).start()


def preload_status() -> dict:
    p = dict(_preload)
    p["schools_held"] = len(_summary)
    p["instalments_held"] = sum(len(v[1]["sid"]) for v in _summary.values())
    return p


def due_list(db: str, org: int) -> dict:
    """Students of one organisation with unpaid fee instalments due in the current financial year (1 Apr - 31 Mar, India):
    {"fy": "2026-27", "students": [{id, name, code, cls, branch, amount, due_date, items, dues}]}: amount = their
    unpaid instalments of the year, due_date = the earliest of them; earliest due date first. Parents' names and phones
    are not included (see parents_for)."""
    today = datetime.now(IST).date()
    fy = _fy(today)
    key = f"{db.lower()}:{org}:{fy}"
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    docs = _fees(db, _fy_filter(org, fy))
    _summary[key] = (time.time(), _summarise(docs))

    by_student: dict[int, dict] = {}
    for d in docs:
        bal = float(d.get("InstallmentAmount") or 0) - float(d.get("Concession") or 0) - float(d.get("Paid") or 0)
        if bal <= 0:
            continue
        sid = d.get("StudentEnrollmentID")
        due = _day(d.get("DueDate"))
        st = by_student.setdefault(sid, {
            "id": sid, "name": _txt(d.get("StudentName")), "code": _txt(d.get("StudentEnrollmentCode")),
            "cls": " ".join(x for x in [_txt(d.get("ClassName")), _txt(d.get("SectionName"))] if x),
            "branch": _txt(d.get("BranchName")), "amount": 0.0, "due_date": due, "items": 0, "dues": []})
        st["amount"] += bal
        st["items"] += 1
        # each unpaid instalment, so the pop-up can filter by month: (due date, balance, partly paid already)
        st["dues"].append((due, round(bal, 2), float(d.get("Paid") or 0) > 0))
        if due and (st["due_date"] is None or due < st["due_date"]):
            st["due_date"] = due

    students = sorted(by_student.values(), key=lambda x: (x["due_date"] is None, x["due_date"] or date.max, -x["amount"], x["name"]))
    out = {"today": today, "fy": f"{fy}-{(fy + 1) % 100:02d}", "students": students}
    now = time.time()
    for k in [k for k, v in _cache.items() if now - v[0] >= CACHE_TTL]:
        _cache.pop(k, None)
    while len(_cache) >= CACHE_MAX:
        _cache.pop(min(_cache, key=lambda k: _cache[k][0]), None)
    _cache[key] = (now, out)
    return out


def parents_for(db: str, org: int, ids: list[int]) -> dict[int, dict]:
    """Father / mother name and phone of these students only (read when messages are sent, not with the list)."""
    try:
        return _parents(db, org, [int(i) for i in ids if i is not None])
    except SearchUnavailable:
        return {}
