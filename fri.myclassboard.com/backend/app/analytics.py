"""Read-only analytics over MCBMaster (Azure SQL Managed Instance).

Sources
  dbo.MCBOrganisationPaymentsAnalysis   fee collections per tenant DB / organisation / payment mode / month
  dbo.MCBFeePaymentModes                payment-mode master (names by PaymentModeID)
  dbo.MasterPaymentGateways             gateway master (IsActive, IsMCBPartner)
  dbo.MCB_OrganisationPaymentGatewayName  organisation / branch -> gateway mapping (a view over every tenant DB;
                                        when it cannot be read as a whole, each tenant's
                                        [db].dbo.View_OrganisationPaymentGatewayName is read and denied DBs are skipped)
"""
from __future__ import annotations

import logging
import re
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from sqlalchemy import text
from sqlalchemy.exc import InterfaceError, OperationalError

from .config import Settings
from .db import get_engine
from .schemas import (
    AccountTeam, Branch, Consent, FilterOption, Gateway, GatewayBranches, GatewaySchool, GatewaySummary, Institute, InstituteMode, Institutes,
    LastMonthStats, LoanPartner, LoanSummary, PartnerSchool,
    MasterGateway,
    ModeGroup, MonthDetail, MonthInstitute, MonthlySummary, MonthMode, MonthRow,
    PaymentMode, PaymentModes, TotalReconciliation, TotalStep,
)

log = logging.getLogger("mcb.analytics")

CR = 1e7  # rupees per crore
CR_DP = 9  # decimals kept on a crore figure: 9 is exact to the paisa, so the pages can show full rupee amounts
MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# PaymentModeID -> (key, revenue role, conversion play). Names come from dbo.MCBFeePaymentModes.
MODE_MAP: dict[int, tuple[str, str, str]] = {
    5: ("pg", "Earns", "Keep it growing: saved cards, UPI AutoPay, instalments"),
    10: ("loan", "Earns", "Add loan partners for schools with high fees"),
    6: ("neft", "Outside MCB PG", "Offer bank transfer through the MCB gateway instead"),
    11: ("upi", "Outside MCB PG", "Replace direct UPI with the MCB gateway UPI / QR"),
    14: ("upi", "Outside MCB PG", "Replace direct UPI with the MCB gateway UPI / QR"),
    12: ("bbps", "Outside MCB PG", "Check how each school's BBPS payments are routed"),
    2: ("cash", "Convertible", "Send pay-link reminders before each due date"),
    7: ("card", "Convertible", "Replace the counter card machine with an MCB UPI QR"),
    3: ("cheque", "Convertible", "Send pay links with an EMI / loan option"),
    8: ("dd", "Convertible", "Send pay links with an EMI / loan option"),
    16: ("ecs", "Mandate", "Move auto-debit to UPI AutoPay through the MCB gateway"),
}
MODE_ORDER = ["pg", "neft", "upi", "cash", "card", "cheque", "ecs", "loan", "dd", "bbps"]
# Counter payments that could move to pay links. Bank transfers, auto-debit, loans, scholarships etc. are not "offline".
OFFLINE_KEYS = ("cash", "card", "cheque", "dd")
# The parts of total fees shown as headline tiles: (key, label, mode keys). Every payment mode falls in exactly
# one group ("other" takes whatever is not named), so the groups always add up to the total.
SUMMARY_GROUPS: list[tuple[str, str, tuple[str, ...] | None]] = [
    ("pg", "Paid online through MCB gateway", ("pg",)),
    ("neft", "Bank transfer / direct UPI (not via MCB)", ("neft", "upi", "bbps")),
    ("offline", "Paid offline (cash, card swipe, cheque, DD)", OFFLINE_KEYS),
    ("ecs", "Auto-debit (ECS)", ("ecs",)),
    ("loan", "Paid by education loan", ("loan",)),
    ("other", "Other payment methods", None),
]
_GROUP_OF = {k: g for g, _, keys in SUMMARY_GROUPS for k in (keys or ())}


def group_of(mode_key: str) -> str:
    return _GROUP_OF.get(mode_key, "other")


def fit_to_total(parts: list[float], total: float) -> list[float]:
    """Round each part to the paisa, then put the rounding remainder on the largest part so the parts add up to
    `total` exactly (a remainder is at most a few paise)."""
    out = [round(p, CR_DP) for p in parts]
    gap = round(total - sum(out), CR_DP)
    if gap and out:
        i = max(range(len(out)), key=lambda j: out[j])
        out[i] = round(out[i] + gap, CR_DP)
    return out
NAME_OVERRIDES = {"pg": "Online payment (MCB gateway)", "upi": "UPI (direct)", "card": "Card swipe (POS)"}
PG_IDS = [k for k, v in MODE_MAP.items() if v[0] == "pg"]
LOAN_IDS = [k for k, v in MODE_MAP.items() if v[0] == "loan"]
SAFE_DB = re.compile(r"^[A-Za-z0-9_]+$")
DUE_DAYS = 20          # campaign audience: fees due from today to this many days ahead
DUE_CACHE_TTL = 600    # seconds a school's due-students count is reused


def mode_info(mode_id: int) -> tuple[str, str, str]:
    return MODE_MAP.get(mode_id, (f"m{mode_id}", "Other", "—"))


def clean(v: Any) -> str:
    """A database text value with stray spaces removed ("" for NULL or non-text)."""
    return " ".join(v.split()) if isinstance(v, str) else ""


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


# "NA" in a tenant's gateway view means the organisation / branch does not use MCB's payment gateways.
NOT_MCB = {"na", "n/a"}
# Empty values carry no information either way.
NO_GATEWAY = {"", "none", "null", "nil", "0"} | {norm(v) for v in NOT_MCB}

NOT_MCB_LABEL = "No MCB gateway"
UNMAPPED_LABEL = "No gateway mapping"
UNREADABLE_LABEL = "Mapping not readable"

# Branch coverage, in display order (keys match Institute.branch_coverage).
COVERAGE_LABELS = {
    "all": "Every branch uses an MCB gateway",
    "partial": "Some branches don't use an MCB gateway",
    "none": "No branch uses an MCB gateway",
    "unmapped": "No branch information",
}

# Partner segments, in display order (keys match Institute.partner_status).
# An extra choice in the "Which gateway the school uses" filter that is not a gateway segment: schools whose
# biggest payment method is cash (more rupees in cash than in any other single payment mode, complete months of the FY).
CASH_FIRST = "cash"
CASH_FIRST_LABEL = "Mostly cash usage"

# The gateway choices of that filter: value -> (label, the partner segments it covers).
# "No PG" is every school that is on no active gateway: gateway not in use, marked NA, no mapping, mapping unreadable.
PG_FILTER = {
    "partner": ("Partner PG", ("partner",)),
    "non_partner": ("Non partner PG", ("non_partner",)),
    "no_pg": ("No PG", ("no_active", "na", "unmapped", "unknown")),
}
PG_FILTER_OF = {s: k for k, (_, segs) in PG_FILTER.items() for s in segs}   # partner segment -> filter value
PG_FILTER_LABELS = {**{k: lbl for k, (lbl, _) in PG_FILTER.items()}, CASH_FIRST: CASH_FIRST_LABEL}


def is_cash_first(by_mode: dict[str, float]) -> bool:
    """by_mode: rupees by payment-mode key."""
    cash = by_mode.get("cash", 0.0)
    return cash > 0 and all(cash >= v for v in by_mode.values())


SEGMENT_LABELS = {
    "partner": "Uses our partner gateway (we earn commission)",
    "non_partner": "Uses a gateway that is not our partner (no commission)",
    "no_active": "Gateway set up but not in use",
    "na": "Doesn't use any MCB gateway",
    "unmapped": "No gateway information",
    "unknown": "Gateway details not available",
}


@dataclass
class FyData:
    fy: str
    months: list[int]                                   # complete months as yyyymm, ascending
    mode_month: dict[tuple[str, int], float]            # (mode key, yyyymm) -> rupees
    mode_month_txns: dict[tuple[str, int], int]
    month_txns: dict[int, int]
    orgs: dict[str, dict] = field(default_factory=dict)  # institute id -> {name, db, org_id, pg{ym}, off{ym}, pg_txns{ym}, students{ym}}


@dataclass(frozen=True)
class Scope:
    """Global filters. Empty values mean 'no filter'. Months are labels within the FY ('Apr' … 'Mar')."""
    dbs: tuple[str, ...] = ()
    partner: str = ""
    coverage: str = ""
    gateway: str = ""
    inst: str = ""
    m_from: str = ""
    m_to: str = ""
    modes: tuple[str, ...] = ()   # payment-mode keys (MCBFeePaymentModes); empty = every mode
    gw_kind: str = ""             # partner / non_partner / inactive / unknown: institutes on a gateway of that kind


@dataclass
class GatewayMap:
    rows: list[dict]                                    # {db, org_id, branch_id, branch, gateway}
    readable: set[str]
    denied: list[str]
    loaded_at: datetime
    complete: bool = False                              # True when the combined view read cleanly: every DB is covered

    def can_read(self, db: str) -> bool:
        return self.complete or db in self.readable


class Analytics:
    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self.engine = get_engine()
        self._cache: dict[str, tuple[float, Any]] = {}
        self._locks: dict[str, threading.Lock] = defaultdict(threading.Lock)
        self._snapshot: datetime | None = None
        self._snapshot_checked = 0.0
        self._snapshot_lock = threading.Lock()
        self._am: dict[str, AccountTeam] = {}  # organisation id (lower case) -> its account team
        self._am_at = 0.0
        self._am_students: dict[str, int] = {}  # organisation id (lower case) -> active students, summed over its branches
        self._am_lock = threading.Lock()

    # ---------------- plumbing ----------------
    def snapshot(self) -> datetime:
        """Latest GeneratedDate. Checked at most every `freshness_check` seconds; a new value drops every cached
        result built from the old snapshot, so the next request reads the new data."""
        with self._snapshot_lock:
            if self._snapshot is None or time.time() - self._snapshot_checked >= self.s.freshness_check:
                g = self._all("SELECT MAX(GeneratedDate) g FROM dbo.MCBOrganisationPaymentsAnalysis WITH (NOLOCK)")[0]["g"]
                self._snapshot_checked = time.time()
                if self._snapshot is not None and g != self._snapshot:
                    log.info("New payments snapshot %s (was %s): clearing cached results", g, self._snapshot)
                    for k in [k for k in self._cache if k != "gwmap"]:
                        self._cache.pop(k, None)
                self._snapshot = g
            return self._snapshot

    def _cutoff(self) -> int:
        """The first yyyymm that is NOT counted: normally the snapshot's own month, which is still in progress;
        with MCB_INCLUDE_CURRENT_MONTH that month is counted too."""
        gen = self.generated_at()
        y, m = gen.year, gen.month
        if self.s.include_current_month:
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        return y * 100 + m

    def _cached(self, key: str, fn: Callable[[], Any], ttl: int | None = None) -> Any:
        """Results are reused only while the database snapshot is unchanged (checked against the DB every
        `freshness_check` seconds), so a cached answer is always identical to re-running the query."""
        ttl = self.s.cache_ttl if ttl is None else ttl
        if key != "gwmap":
            self.snapshot()
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        with self._locks[key]:
            hit = self._cache.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1]
            val = fn()
            self._cache[key] = (time.time(), val)
            return val

    def clear_cache(self) -> None:
        self._cache.clear()
        self._snapshot_checked = 0.0

    def _all(self, sql: str, **p) -> list[dict]:
        """Run a read query. One retry on a dropped / transient connection (Azure SQL MI failovers, idle resets)."""
        for attempt in (1, 2):
            try:
                with self.engine.connect() as c:
                    return [dict(r) for r in c.execute(text(sql), p).mappings().all()]
            except (OperationalError, InterfaceError) as exc:
                if attempt == 2:
                    raise
                log.warning("Transient database error (%s); retrying once", type(exc).__name__)
                time.sleep(1.0)
        return []

    def _filters(self) -> tuple[str, dict]:
        """WHERE fragment applied to every MCBOrganisationPaymentsAnalysis query."""
        clauses, params = [], {}
        if not self.s.include_school_store:
            clauses.append("a.IsSchoolStore = 0")
        for n, db in enumerate(self.s.excluded_dbs):
            params[f"x{n}"] = db
        if params:
            clauses.append("ISNULL(a.DBName, '') NOT IN (" + ", ".join(f":x{n}" for n in range(len(params))) + ")")
        orgs = {f"xo{n}": o for n, o in enumerate(self.s.excluded_orgs)}
        if orgs:
            clauses.append(self._ORG_KEY + " NOT IN (" + ", ".join(":" + k for k in orgs) + ")")
            params.update(orgs)
        return (" AND " + " AND ".join(clauses)) if clauses else "", params

    _ORG_KEY = "CONCAT(a.DBName, ':', a.OrganisationID)"

    # ---------------- reference data ----------------
    def fy_options(self) -> list[str]:
        return self._cached("fys", lambda: [r["fy"] for r in self._all(
            "SELECT DISTINCT FinancialYear fy FROM dbo.MCBOrganisationPaymentsAnalysis WITH (NOLOCK) ORDER BY FinancialYear DESC")])

    def generated_at(self) -> datetime:
        return self.snapshot()

    def extra_orgs(self) -> dict[str, dict]:
        """settings.extra_institutes that exist in dbo.MCBOrganisations (and pass the same exclusions as the rest of the
        portal): institute id -> {db, org_id, name}."""
        want = {k.strip().lower(): k.strip() for k in self.s.extra_institutes.split(",") if re.fullmatch(r"\s*[A-Za-z0-9_]+:\d+\s*", k)}
        if not want:
            return {}

        def load():
            rows = self._all("""SELECT DBName db, OrganisationID org_id, MAX(OrganisationName) name, MAX(CAST(Active AS int)) active
                                FROM dbo.MCBOrganisations WITH (NOLOCK) GROUP BY DBName, OrganisationID""")
            excl_db = {d.lower() for d in self.s.excluded_dbs}
            excl_org = {o.lower() for o in self.s.excluded_orgs}
            out = {}
            for r in rows:
                iid = f"{r['db']}:{r['org_id']}"
                k = iid.lower()
                if k not in want or (r["db"] or "").lower() in excl_db or k in excl_org:
                    continue
                if self.s.hide_inactive_orgs and not r["active"]:
                    continue
                out[iid] = {"db": r["db"], "org_id": int(r["org_id"]), "name": " ".join((r["name"] or "").split()) or iid}
            return out
        return self._cached("extraorgs", load)

    def active_orgs(self) -> set[str]:
        """'DBName:OrganisationID' of organisations with Active = 1 in dbo.MCBOrganisations
        (a key listed twice counts as active if any row is active)."""
        return self._cached("activeorgs", lambda: {f"{r['db']}:{r['org_id']}" for r in self._all(
            """SELECT DBName db, OrganisationID org_id FROM dbo.MCBOrganisations WITH (NOLOCK)
               GROUP BY DBName, OrganisationID HAVING MAX(CAST(Active AS int)) = 1""")})

    def _active_clause(self, alias: str = "a") -> str:
        """SQL condition matching active_orgs(), for queries that must agree with it (accuracy check)."""
        if not self.s.hide_inactive_orgs:
            return ""
        return (f" AND EXISTS (SELECT 1 FROM dbo.MCBOrganisations o WITH (NOLOCK) WHERE o.DBName = {alias}.DBName "
                f"AND o.OrganisationID = {alias}.OrganisationID AND o.Active = 1)")

    def mode_names(self) -> dict[int, str]:
        return self._cached("modes", lambda: {int(r["PaymentModeID"]): r["PaymentMode"] for r in self._all(
            "SELECT PaymentModeID, PaymentMode FROM dbo.MCBFeePaymentModes WITH (NOLOCK)")})

    def gateway_master(self) -> dict[str, dict]:
        """Normalised gateway name -> its row in dbo.MasterPaymentGateways. The flags are edited by hand, so the
        table is re-read as often as the mapping. Several rows can share a name (BillDesk_New, GrayQuest): the name
        takes the row matching `IsActive = 1 AND IsMCBPartner = 1` if there is one, else an active row, else the newest."""
        def load() -> dict[str, dict]:
            rows = self._all("SELECT MasterPaymentGatewayID, MasterPaymentGatewayName, IsActive, IsMCBPartner, IsCommisionSharing "
                             "FROM dbo.MasterPaymentGateways WITH (NOLOCK)")
            rows.sort(key=lambda r: (bool(r["IsActive"]) and bool(r["IsMCBPartner"]), bool(r["IsActive"]), r["MasterPaymentGatewayID"]))
            return {norm(r["MasterPaymentGatewayName"]): r for r in rows}   # best row last, so it wins
        return self._cached("gwmaster", load, ttl=self.s.gateway_map_ttl)

    # ---------------- account team ----------------
    def account_teams(self) -> dict[str, AccountTeam]:
        """Organisation id (lower case) -> its account team, from dbo.USP_GET_BranchAnalysis_MCBMaster. The procedure
        takes about half a minute, so it runs in the background: pages never wait for it, and show what it returned
        last (nothing until its first run after a start has finished)."""
        if not self.s.account_team:
            return {}
        if time.time() - self._am_at >= self.s.account_manager_ttl and self._am_lock.acquire(blocking=False):
            threading.Thread(target=self._load_account_teams, name="account-teams", daemon=True).start()
        return self._am

    def _load_account_teams(self) -> None:
        try:
            users = self._all("SELECT UserID, Name, MobileNo FROM dbo.Users WITH (NOLOCK)")
            mobile = {u["UserID"]: clean(u["MobileNo"]) for u in users}
            by_name: dict[str, set[str]] = defaultdict(set)      # for the sales person, who is recorded by name only
            for u in users:
                if clean(u["Name"]) and clean(u["MobileNo"]):
                    by_name[clean(u["Name"]).lower()].add(clean(u["MobileNo"]))

            def person(name: Any, uid: Any = None) -> str:
                name = clean(name)
                if not name:
                    return ""
                phones = by_name.get(name.lower(), set())
                phone = mobile.get(uid, "") if uid is not None else (next(iter(phones)) if len(phones) == 1 else "")
                return f"{name} · {phone}" if phone else name

            rows = self._all("EXEC dbo.USP_GET_BranchAnalysis_MCBMaster @DBName = NULL, @OrganisationID = NULL")
            out: dict[str, AccountTeam] = {}
            students: dict[str, int] = defaultdict(int)
            for r in rows:                       # one row per branch; the team is the same on every branch
                key = f"{r['DBName']}:{r['OrganisationID']}".lower()
                students[key] += int(r.get("ActiveStudents") or 0)
                if key in out:
                    continue
                out[key] = AccountTeam(
                    location=", ".join(p for p in (clean(r.get("COCityName")), clean(r.get("OrganisationStateName"))) if p),
                    # PersonName is "L2 - Name-phone" (or "-extension"): show the number the same way as the others
                    account_manager=re.sub(r"\s*-\s*(?=\d{3,})", " · ", clean(r.get("PersonName")), count=1),
                    implementation_manager=person(r.get("ImpUserName"), r.get("ImplemUserID")),
                    implementation_executive=person(r.get("ExecutivName"), r.get("ImplementationExecutiveID")),
                    sales_person=person(r.get("SalesManager")),
                    rm=person(r.get("RMName"), r.get("RMUserID")),
                    csm=person(r.get("CSMNames"), r.get("CustomerSuccessManagerID")),
                    customer_type=clean(r.get("CustomerType")))
            self._am, self._am_students = out, dict(students)
            self._am_at = time.time()
            log.info("Account teams loaded: %d organisations", len(out))
        except Exception:                        # keep the last result; try again in five minutes
            log.exception("Could not read account teams from USP_GET_BranchAnalysis_MCBMaster")
            self._am_at = time.time() - self.s.account_manager_ttl + 300
        finally:
            self._am_lock.release()

    # ---------------- fee collections for one FY ----------------
    def fy_data(self, fy: str) -> FyData:
        return self._cached(f"fy:{fy}", lambda: self._load_fy(fy))

    def _load_fy(self, fy: str) -> FyData:
        where, params = self._filters()
        rows = self._all(f"""
            SELECT a.DBName db, a.OrganisationID org_id, a.OrganisationName name, a.PaymentModeID mode_id,
                   a.YearNo * 100 + a.MonthNo ym,
                   SUM(a.PaidAmount) amt, SUM(a.NoOfTransactions) txns, SUM(a.PaidStudents) students
            FROM dbo.MCBOrganisationPaymentsAnalysis a WITH (NOLOCK)
            WHERE a.FinancialYear = :fy {where}
            GROUP BY a.DBName, a.OrganisationID, a.OrganisationName, a.PaymentModeID, a.YearNo, a.MonthNo""", fy=fy, **params)
        if self.s.hide_inactive_orgs:                 # organisations marked inactive are not shown anywhere
            active = self.active_orgs()
            rows = [r for r in rows if f"{r['db']}:{r['org_id']}" in active]
        gen = self.generated_at()
        cutoff = self._cutoff()                      # normally the snapshot's own month: it is still in progress
        months = sorted({r["ym"] for r in rows if r["ym"] < cutoff})
        mset = set(months)
        d = FyData(fy=fy, months=months, mode_month=defaultdict(float), mode_month_txns=defaultdict(int), month_txns=defaultdict(int))
        latest_name: dict[str, tuple[int, str]] = {}
        for r in rows:
            ym = r["ym"]
            if ym not in mset:
                continue
            key = mode_info(int(r["mode_id"]))[0]
            amt, txns = float(r["amt"] or 0), int(r["txns"] or 0)
            d.mode_month[(key, ym)] += amt
            d.mode_month_txns[(key, ym)] += txns
            d.month_txns[ym] += txns
            iid = f"{r['db']}:{r['org_id']}"
            o = d.orgs.get(iid)
            if o is None:
                o = d.orgs[iid] = {"db": r["db"], "org_id": int(r["org_id"]), "pg": defaultdict(float), "off": defaultdict(float),
                                   "pg_txns": defaultdict(int), "students": defaultdict(int),
                                   "modes": defaultdict(float), "mode_txns": defaultdict(int)}   # (mode key, ym) -> rupees / txns
            o["modes"][(key, ym)] += amt
            o["mode_txns"][(key, ym)] += txns
            if key == "pg":
                o["pg"][ym] += amt
                o["pg_txns"][ym] += txns
            else:
                o["off"][ym] += amt
            o["students"][ym] += int(r["students"] or 0)
            if iid not in latest_name or ym >= latest_name[iid][0]:
                latest_name[iid] = (ym, r["name"])
        for iid, o in d.orgs.items():
            o["name"] = " ".join((latest_name[iid][1] or "").split()) or iid
        for iid, x in self.extra_orgs().items():      # listed without collections: every figure is 0
            if iid not in d.orgs:
                d.orgs[iid] = {"db": x["db"], "org_id": x["org_id"], "name": x["name"], "extra": True,
                               "pg": defaultdict(float), "off": defaultdict(float), "pg_txns": defaultdict(int),
                               "students": defaultdict(int), "modes": defaultdict(float), "mode_txns": defaultdict(int)}
        return d

    @staticmethod
    def label(ym: int) -> str:
        return MONTHS[ym % 100]

    def institute_names(self) -> dict[str, str]:
        """Institute id -> its name, from this and last financial year (the newer name wins)."""
        out: dict[str, str] = {}
        for fy in reversed(self.fy_options()[:2]):
            for iid, o in self.fy_data(fy).orgs.items():
                if o.get("name"):
                    out[iid] = o["name"]
        return out

    # ---------------- pipeline owners ----------------
    def pipeline_owners(self) -> list[dict]:
        """Active staff who can own a pipeline deal: dbo.Users with Status = 1 and a UserTypeID from
        settings.pipeline_owner_user_types (22 = Fintech in dbo.MCBUserTypes), by name."""
        types = [int(t) for t in self.s.pipeline_owner_user_types.split(",") if t.strip().isdigit()]
        if not types:
            return []

        def load() -> list[dict]:
            marks = ", ".join(f":t{i}" for i in range(len(types)))
            rows = self._all(f"""SELECT UserID, Name, EmailID FROM dbo.Users WITH (NOLOCK)
                                 WHERE Status = 1 AND UserTypeID IN ({marks}) AND Name IS NOT NULL""",
                             **{f"t{i}": t for i, t in enumerate(types)})
            skip = {int(u) for u in self.s.pipeline_owner_exclude_ids.split(",") if u.strip().isdigit()}
            out = {clean(r["Name"]): r for r in rows if clean(r["Name"]) and int(r["UserID"]) not in skip}
            return [{"id": str(r["UserID"]), "name": nm, "email": clean(r["EmailID"]).lower()}
                    for nm, r in sorted(out.items(), key=lambda t: t[0].lower())]
        return self._cached("pipeowners", load, ttl=600)

    # ---------------- fee dues (campaign audience) ----------------
    def due_students(self, ids: list[str]) -> dict[str, int | None]:
        """Per school id ("DBName:OrganisationID"): students with an active fee instalment due from today to
        DUE_DAYS days ahead, from dbo.Allstudentsfeeduedetails in that school's own database.
        None = the school's database is not on this SQL server, or its table could not be read."""
        visible = self._cached("sysdbs", lambda: {r["name"].lower() for r in self._all("SELECT name FROM sys.databases")}, ttl=3600)

        def one(iid: str) -> tuple[str, int | None]:
            db, _, org = iid.rpartition(":")
            if not SAFE_DB.match(db) or not org.isdigit() or db.lower() not in visible:
                return iid, None

            def load() -> int | None:
                try:
                    r = self._all(f"""
                        SELECT COUNT(DISTINCT A.StudentEnrollmentID) n
                        FROM [{db}].dbo.Allstudentsfeeduedetails A WITH (NOLOCK)
                        WHERE A.Active = 1 AND A.OrganisationID = :org
                          AND CAST(A.DueDate AS DATE) BETWEEN CAST(GETDATE() AS DATE) AND DATEADD(DAY, {DUE_DAYS}, CAST(GETDATE() AS DATE))""",
                                  org=int(org))
                    return int(r[0]["n"] or 0)
                except Exception as exc:
                    log.warning("Fee dues unreadable for %s (%s)", iid, type(exc).__name__)
                    return None
            return iid, self._cached(f"due:{iid.lower()}", load, ttl=DUE_CACHE_TTL)

        with ThreadPoolExecutor(max_workers=6) as pool:
            return dict(pool.map(one, ids))

    # ---------------- gateway mapping ----------------
    def gateway_map(self) -> GatewayMap:
        return self._cached("gwmap", self._load_gateway_map, ttl=self.s.gateway_map_ttl)

    def _load_gateway_map(self) -> GatewayMap:
        try:
            rows = self._all("""SELECT DISTINCT DBName db, OrganisationID org_id, BranchID branch_id, BranchName branch, PaymentGatewayName gateway
                                FROM dbo.MCB_OrganisationPaymentGatewayName WITH (NOLOCK)""")
            return GatewayMap(rows=rows, readable={r["db"] for r in rows}, denied=[], loaded_at=datetime.now(), complete=True)
        except Exception as exc:  # usually SELECT denied on one tenant's view
            log.warning("Combined gateway view unreadable (%s); reading tenant views one by one", type(exc).__name__)
        all_dbs = [r["db"] for r in self._all(
            "SELECT DISTINCT DBName db FROM dbo.MCBOrganisationPaymentsAnalysis WITH (NOLOCK) WHERE DBName IS NOT NULL")]
        dbs = [d for d in all_dbs if SAFE_DB.match(d) and d not in self.s.excluded_dbs]

        def one(db: str) -> tuple[str, list[dict] | None]:
            try:
                got = self._all(f"SELECT * FROM [{db}].dbo.View_OrganisationPaymentGatewayName WITH (NOLOCK)")
            except Exception:
                return db, None
            out = []
            for r in got:
                k = {c.lower(): v for c, v in r.items()}
                if "organisationid" not in k or "paymentgatewayname" not in k:
                    return db, None
                out.append({"db": db, "org_id": k["organisationid"], "branch_id": k.get("branchid"),
                            "branch": k.get("branchname"), "gateway": k["paymentgatewayname"]})
            return db, out

        rows, readable, denied = [], set(), []
        with ThreadPoolExecutor(max_workers=8) as pool:
            for db, got in pool.map(one, dbs):
                if got is None:
                    denied.append(db)
                else:
                    readable.add(db)
                    rows.extend(got)
        return GatewayMap(rows=rows, readable=readable, denied=sorted(denied), loaded_at=datetime.now())

    def org_gateways(self) -> dict[str, dict]:
        """institute id -> {gateways: [..], branches: {id: {name, gateways: [..], na: bool}}, na_rows, rows}.
        A branch can carry several gateway rows; all of them are kept."""
        def build():
            master = self.gateway_master()
            seen: dict[str, str] = {}   # normalised -> display name (master spelling wins, else first seen)

            def canon(raw: str | None) -> str | None:
                k = norm(raw or "")
                if k in NO_GATEWAY:
                    return None
                if k not in seen:
                    m = master.get(k)
                    seen[k] = m["MasterPaymentGatewayName"].strip() if m else (raw or "").strip()
                return seen[k]

            out: dict[str, dict] = {}
            for r in self.gateway_map().rows:
                iid = f"{r['db']}:{r['org_id']}"
                o = out.setdefault(iid, {"gateways": [], "branches": {}, "na_rows": 0, "rows": 0})
                is_na = norm(r["gateway"] or "") in {norm(v) for v in NOT_MCB}
                g = canon(r["gateway"])
                o["rows"] += 1
                o["na_rows"] += int(is_na)
                if g and g not in o["gateways"]:
                    o["gateways"].append(g)
                if r["branch_id"] is not None:
                    b = o["branches"].setdefault(int(r["branch_id"]), {"name": r["branch"] or f"Branch {r['branch_id']}", "gateways": [], "na": False})
                    if g and g not in b["gateways"]:
                        b["gateways"].append(g)
                    b["na"] = b["na"] or is_na
            return out
        # Keyed by the mapping's load time: rebuilt whenever the mapping is re-read from the database.
        key = f"orggw:{self.gateway_map().loaded_at.timestamp()}"
        for old in [k for k in self._cache if k.startswith("orggw:") and k != key]:
            self._cache.pop(old, None)
        return self._cached(key, build)

    def verify_totals(self, fy: str) -> dict:
        """Accuracy check: a direct SQL sum over MCBOrganisationPaymentsAnalysis (same rules: FY, complete months,
        school store and excluded DBs) compared with what the portal is serving."""
        where, params = self._filters()
        gen = self.generated_at()
        cutoff = self._cutoff()
        r = self._all(f"""SELECT SUM(a.PaidAmount) amt, SUM(a.NoOfTransactions) txns,
                                 COUNT(DISTINCT CONCAT(a.DBName, ':', a.OrganisationID)) orgs, COUNT(*) row_count
                          FROM dbo.MCBOrganisationPaymentsAnalysis a WITH (NOLOCK)
                          WHERE a.FinancialYear = :fy AND a.YearNo * 100 + a.MonthNo < :cutoff {where}{self._active_clause()}""",
                      fy=fy, cutoff=cutoff, **params)[0]
        d = self.fy_data(fy)
        portal_amt = sum(d.mode_month.values())
        portal_txns = sum(d.mode_month_txns.values())
        db_amt, db_txns = float(r["amt"] or 0), int(r["txns"] or 0)
        collecting = sum(1 for o in d.orgs.values() if not o.get("extra"))   # listed extras have no rows to reconcile
        ok = abs(db_amt - portal_amt) < 1.0 and db_txns == portal_txns and int(r["orgs"] or 0) == collecting
        return {"fy": fy, "ok": ok, "checked_at": datetime.now().isoformat(timespec="seconds"), "snapshot": gen.isoformat(),
                "database": {"amount_rs": round(db_amt, 2), "transactions": db_txns, "institutes": int(r["orgs"] or 0), "rows": int(r["row_count"] or 0)},
                "portal": {"amount_rs": round(portal_amt, 2), "transactions": portal_txns, "institutes": collecting}}

    def branch_status(self, b: dict) -> str:
        """partner / non_partner (on a gateway) · na (marked NA: not using MCB gateways) · none (no gateway value)."""
        if b["gateways"]:
            return "partner" if any(self.is_partner(g) for g in b["gateways"]) else "non_partner"
        return "na" if b["na"] else "none"

    def branch_mix(self, iid: str) -> dict[str, int]:
        mix = {"partner": 0, "non_partner": 0, "na": 0, "none": 0}
        for b in self.org_gateways().get(iid, {}).get("branches", {}).values():
            mix[self.branch_status(b)] += 1
        return mix

    def branch_gateways(self, iid: str) -> list[GatewayBranches]:
        """Branches grouped by the payment gateway they use; N/A and gateway-less branches get their own groups."""
        groups: dict[str, list[str]] = defaultdict(list)
        for b in self.org_gateways().get(iid, {}).get("branches", {}).values():
            if b["gateways"]:
                for g in b["gateways"]:
                    groups[g].append(b["name"])
            else:
                groups["N/A" if b["na"] else "No gateway"].append(b["name"])
        out = [GatewayBranches(gateway=g, kind="na" if g == "N/A" else "none" if g == "No gateway" else self.gateway_kind(g),
                               branches=sorted(names)) for g, names in groups.items()]
        order = {"partner": 0, "non_partner": 1, "inactive": 2, "unknown": 3, "na": 4, "none": 5}
        return sorted(out, key=lambda x: (order.get(x.kind, 9), -len(x.branches), x.gateway.lower()))

    @staticmethod
    def branch_coverage(mix: dict[str, int]) -> str:
        """all = every branch on an MCB gateway · partial = some branches on, some not · none = no branch on one
        · unmapped = no branch rows at all."""
        total = sum(mix.values())
        on = mix["partner"] + mix["non_partner"]
        if not total:
            return "unmapped"
        return "all" if on == total else "none" if on == 0 else "partial"

    def gateway_status(self, iid: str, db: str) -> str:
        """mcb = at least one branch on an MCB gateway · na = every branch marked NA (not using MCB gateways)
        · unmapped = no rows in the mapping · unknown = tenant DB's view not readable."""
        if not self.gateway_map().can_read(db):
            return "unknown"
        g = self.org_gateways().get(iid)
        if not g or not g["rows"]:
            return "unmapped"
        if g["gateways"]:
            return "mcb"
        return "na" if g["na_rows"] else "unmapped"

    def gateway_kind(self, gateway: str) -> str:
        """From dbo.MasterPaymentGateways:
        partner      IsActive = 1 AND IsMCBPartner = 1   (our partners with an active gateway)
        non_partner  IsActive = 1 AND IsMCBPartner <> 1  (active gateways that are not our partners)
        inactive     IsActive = 0
        unknown      not in the master"""
        m = self.gateway_master().get(norm(gateway))
        if not m:
            return "unknown"
        if not m["IsActive"]:
            return "inactive"
        return "partner" if m["IsMCBPartner"] else "non_partner"

    def is_partner(self, gateway: str) -> bool | None:
        """True only for an active MCB partner gateway; None when the gateway is not in the master."""
        kind = self.gateway_kind(gateway)
        return None if kind == "unknown" else kind == "partner"

    def partner_status(self, iid: str, db: str) -> str:
        """Using a payment gateway = mapped to a gateway with IsActive = 1 in MasterPaymentGateways.
        partner     using a gateway that is also our partner (IsActive = 1 AND IsMCBPartner = 1)
        non_partner using an active gateway, none of them our partner
        no_active   mapped only to gateways that are inactive (IsActive = 0) or not in the master — not in use
        na / unmapped / unknown as in gateway_status()."""
        gs = self.gateway_status(iid, db)
        if gs != "mcb":
            return gs
        kinds = {self.gateway_kind(g) for g in self.org_gateways()[iid]["gateways"]}
        if "partner" in kinds:
            return "partner"
        if "non_partner" in kinds:
            return "non_partner"
        return "no_active"

    def mode_catalog(self, d: FyData) -> list[tuple[str, str, str, str]]:
        """[(key, name, role, play)] for every mode with money in this FY, in display order."""
        keys: dict[str, tuple[str, str, str]] = {}
        for mid, nm in sorted(self.mode_names().items()):
            key, role, play = mode_info(mid)
            keys.setdefault(key, (NAME_OVERRIDES.get(key, nm), role, play))
        for key, _ in d.mode_month:                       # mode IDs present in data but missing from the master
            keys.setdefault(key, (f"Unmapped mode ({key.lstrip('m')})", "Other", "—"))
        totals = defaultdict(float)
        for (k, _), v in d.mode_month.items():
            totals[k] += v
        out = [(k, *v) for k, v in keys.items() if totals.get(k)]
        out.sort(key=lambda m: (MODE_ORDER.index(m[0]) if m[0] in MODE_ORDER else 99, -totals[m[0]]))
        return out

    # ---------------- filters (scope) ----------------
    def scoped(self, fy: str, sc: "Scope") -> tuple[FyData, list[int], list[tuple[str, dict]]]:
        """The FY data, the selected months (yyyymm) and the selected institutes for a filter scope."""
        d = self.fy_data(fy)
        labels = [self.label(m) for m in d.months]
        lo = labels.index(sc.m_from) if sc.m_from in labels else 0
        hi = labels.index(sc.m_to) if sc.m_to in labels else len(labels) - 1
        months = d.months[lo:hi + 1] if lo <= hi else d.months[hi:lo + 1]
        orgs = [(iid, o) for iid, o in d.orgs.items() if self.matches(iid, o, sc)]
        if sc.modes:
            keep = set(sc.modes)
            orgs = [(iid, r) for iid, o in orgs if (r := self._restrict(o, keep))["modes"]]
        return d, months, orgs

    @staticmethod
    def _restrict(o: dict, keep: set[str]) -> dict:
        """The same institute record, counting only the selected payment modes."""
        r = {**o, "modes": defaultdict(float), "mode_txns": defaultdict(int), "pg": defaultdict(float),
             "pg_txns": defaultdict(int), "off": defaultdict(float)}
        for (k, ym), v in o["modes"].items():
            if k in keep:
                r["modes"][(k, ym)] += v
                if k == "pg":
                    r["pg"][ym] += v
                else:
                    r["off"][ym] += v
        for (k, ym), n in o["mode_txns"].items():
            if k in keep:
                r["mode_txns"][(k, ym)] += n
                if k == "pg":
                    r["pg_txns"][ym] += n
        return r

    def matches(self, iid: str, o: dict, sc: "Scope") -> bool:
        if sc.inst and iid != sc.inst:
            return False
        if sc.dbs and o["db"] not in sc.dbs:
            return False
        if sc.partner == CASH_FIRST:
            by_mode: dict[str, float] = defaultdict(float)
            for (k, _), v in o["modes"].items():
                by_mode[k] += v
            if not is_cash_first(by_mode):
                return False
        elif sc.partner and self.partner_status(iid, o["db"]) not in PG_FILTER.get(sc.partner, ("", (sc.partner,)))[1]:
            return False
        if sc.coverage and self.branch_coverage(self.branch_mix(iid)) != sc.coverage:
            return False
        if sc.gw_kind:
            gws = self.org_gateways().get(iid, {}).get("gateways") or []
            if not any(self.gateway_kind(g) == sc.gw_kind for g in gws):
                return False
        if sc.gateway:
            gws = self.org_gateways().get(iid, {}).get("gateways") or []
            if sc.gateway.startswith("__"):
                return not gws and f"__{self.gateway_status(iid, o['db'])}__" == sc.gateway
            return sc.gateway in gws
        return True

    @staticmethod
    def _sum_modes(orgs: list[tuple[str, dict]], months: list[int]) -> tuple[dict, dict]:
        mm: dict[tuple[str, int], float] = defaultdict(float)
        mt: dict[tuple[str, int], int] = defaultdict(int)
        ms = set(months)
        for _, o in orgs:
            for (k, ym), v in o["modes"].items():
                if ym in ms:
                    mm[(k, ym)] += v
            for (k, ym), n in o["mode_txns"].items():
                if ym in ms:
                    mt[(k, ym)] += n
        return mm, mt

    # ---------------- API shapes ----------------
    def payment_modes(self, fy: str, sc: "Scope | None" = None) -> PaymentModes:
        d, months, orgs = self.scoped(fy, sc or Scope())
        mm, mt = self._sum_modes(orgs, months)
        modes = []
        for key, nm, role, play in self.mode_catalog(d):
            values = [round(mm.get((key, m), 0.0) / CR, CR_DP) for m in months]
            if any(values):
                modes.append(PaymentMode(key=key, name=nm, role=role, play=play, values=values))
        totals = [round(sum(v for (k, ym), v in mm.items() if ym == m) / CR, CR_DP) for m in months]
        last = LastMonthStats(txns=sum(n for (k, ym), n in mt.items() if ym == months[-1]) if months else None)
        # The total and its parts, straight from the database sums: fitted so the parts add up to the total shown.
        names = {key: nm for key, nm, _, _ in self.mode_catalog(d)}
        g_amt: dict[tuple[str, int], float] = defaultdict(float)
        g_txn: dict[tuple[str, int], int] = defaultdict(int)
        g_modes: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        ms = set(months)
        for (k, ym), v in mm.items():
            if ym in ms:
                g_amt[(group_of(k), ym)] += v
                g_modes[group_of(k)][k] += v
        for (k, ym), n in mt.items():
            if ym in ms:
                g_txn[(group_of(k), ym)] += n
        gkeys = [g for g, _, _ in SUMMARY_GROUPS]
        by_month = [fit_to_total([g_amt[(g, m)] / CR for g in gkeys], totals[i]) for i, m in enumerate(months)]
        total_fytd = round(sum(v for (k, ym), v in mm.items() if ym in ms) / CR, CR_DP)
        fytd = fit_to_total([sum(g_amt[(g, m)] for m in months) / CR for g in gkeys], total_fytd)
        groups = [ModeGroup(key=g, label=label, values=[by_month[i][j] for i in range(len(months))], fytd=fytd[j],
                            includes=[names.get(k, k) for k, v in sorted(g_modes[g].items(), key=lambda t: -t[1]) if v],
                            txns=[g_txn[(g, m)] for m in months], fytd_txns=sum(g_txn[(g, m)] for m in months))
                  for j, (g, label, _) in enumerate(SUMMARY_GROUPS)]
        return PaymentModes(months=[self.label(m) for m in months], month_totals=totals, modes=modes, last_month=last,
                            total_fytd=total_fytd, groups=groups)

    def total_reconciliation(self, fy: str) -> TotalReconciliation:
        """Every row of the FY, then each rule the portal applies, down to the total it shows. Summed in SQL."""
        def load() -> TotalReconciliation:
            gen = self.generated_at()
            cutoff = self._cutoff()
            t = "dbo.MCBOrganisationPaymentsAnalysis a WITH (NOLOCK)"
            cond, params = ["a.FinancialYear = :fy"], {"fy": fy}

            def total() -> tuple[float, int, int]:
                r = self._all(f"SELECT SUM(a.PaidAmount) amt, COUNT(*) n, COUNT(DISTINCT CONCAT(a.DBName, ':', a.OrganisationID)) orgs "
                              f"FROM {t} WHERE {' AND '.join(cond)}", **params)[0]
                return float(r["amt"] or 0), int(r["n"] or 0), int(r["orgs"] or 0)

            amt, n, orgs = total()
            steps = [TotalStep(key="raw", label=f"Every row for {fy}", amount_rs=round(amt, 2), rows=n, organisations=orgs)]
            rules = [] if self.s.include_current_month else [
                ("month", f"{gen.strftime('%B')}: the month still in progress", "a.YearNo * 100 + a.MonthNo < :cutoff", {"cutoff": cutoff},
                 f"The data was built on {gen.strftime('%d %B %Y')}; only complete months are counted")]
            if not self.s.include_school_store:
                rules.append(("store", "School-store sales", "ISNULL(a.IsSchoolStore, 0) = 0", {}, "IsSchoolStore = 1: sales, not fee collections"))
            if self.s.excluded_dbs:
                dbs = {f"rx{i}": d for i, d in enumerate(self.s.excluded_dbs)}
                rules.append(("demo", "Demo / duplicate databases (" + ", ".join(self.s.excluded_dbs) + ")",
                              "ISNULL(a.DBName, '') NOT IN (" + ", ".join(":" + k for k in dbs) + ")", dbs, "Not real schools"))
            if self.s.excluded_orgs:
                xo = {f"ro{i}": o for i, o in enumerate(self.s.excluded_orgs)}
                rules.append(("orgs", "MCB's own demo / internal organisations", self._ORG_KEY + " NOT IN (" + ", ".join(":" + k for k in xo) + ")",
                              xo, "Listed in MCB_EXCLUDE_ORGS, as in the Payment Gateway Details report"))
            if self.s.hide_inactive_orgs:
                rules.append(("inactive", "Organisations marked inactive", self._active_clause()[5:], {}, "MCBOrganisations.Active = 0, or not listed there"))
            for key, label, clause, extra, note in rules:
                cond.append(clause)
                params.update(extra)
                now, n2, orgs2 = total()
                steps.append(TotalStep(key=key, label="minus " + label, amount_rs=round(now - amt, 2), rows=n - n2, organisations=orgs - orgs2, note=note))
                amt, n, orgs = now, n2, orgs2
            steps.append(TotalStep(key="portal", label="Total fees collected (what the portal shows)", amount_rs=round(amt, 2), rows=n, organisations=orgs))
            return TotalReconciliation(fy=fy, snapshot=gen.isoformat(), steps=steps)
        return self._cached(f"recon:{fy}", load)

    def monthly_summary(self, fy: str, sc: "Scope | None" = None) -> MonthlySummary:
        """Every complete month within the filters (one school when sc.inst is set): fees, payments and the parts."""
        _, months, orgs = self.scoped(fy, sc or Scope())
        mm, mt = self._sum_modes(orgs, months)
        short = {"pg": "Online via MCB", "neft": "Bank transfer / UPI", "offline": "Offline", "ecs": "Auto-debit (ECS)",
                 "loan": "Education loan", "other": "Other"}
        gkeys = [g for g, _, _ in SUMMARY_GROUPS]
        rows = []
        for m in months:
            parts = {g: 0.0 for g in gkeys}
            for (k, ym), v in mm.items():
                if ym == m:
                    parts[group_of(k)] += v
            parts = {g: round(v, 2) for g, v in parts.items()}
            rows.append(MonthRow(month=self.label(m), year=m // 100, total_rs=round(sum(parts.values()), 2),
                                 txns=sum(n for (k, ym), n in mt.items() if ym == m), groups=parts))
        return MonthlySummary(fy=fy, groups=[{"key": g, "label": label, "short": short[g]} for g, label, _ in SUMMARY_GROUPS],
                              months=rows, total_rs=round(sum(r.total_rs for r in rows), 2), txns=sum(r.txns for r in rows),
                              group_totals={g: round(sum(r.groups[g] for r in rows), 2) for g in gkeys})

    def month_detail(self, fy: str, month: str, kind: str, sc: "Scope | None" = None) -> MonthDetail:
        """Everything behind one chart column: the payment modes and the schools that make up `kind` of fees in
        `month`, within the filters. kind = 'all', a SUMMARY_GROUPS key or a payment-mode key."""
        d, months, orgs = self.scoped(fy, sc or Scope())
        ym = next((m for m in months if self.label(m) == month), None)
        if ym is None:
            raise ValueError(f"No complete month '{month}' in FY {fy}")
        catalog = {key: (nm, role) for key, nm, role, _ in self.mode_catalog(d)}
        group_labels = {g: label for g, label, _ in SUMMARY_GROUPS}
        if kind == "all":
            keep, label = None, "All fees collected"
        elif kind in group_labels:
            keep, label = {k for k in catalog if group_of(k) == kind}, group_labels[kind]
        elif kind in catalog:
            keep, label = {kind}, catalog[kind][0]
        else:
            raise ValueError(f"Unknown kind '{kind}'")
        m_amt: dict[str, float] = defaultdict(float)
        m_txn: dict[str, int] = defaultdict(int)
        insts = []
        for iid, o in orgs:
            amt, txns = 0.0, 0
            for (k, mon), v in o["modes"].items():
                if mon == ym and (keep is None or k in keep):
                    n = o["mode_txns"].get((k, mon), 0)
                    amt += v
                    txns += n
                    m_amt[k] += v
                    m_txn[k] += n
            if amt or txns:
                insts.append(MonthInstitute(id=iid, name=o["name"], db=o["db"], amount_rs=round(amt, 2), txns=txns))
        insts.sort(key=lambda i: -i.amount_rs)
        modes = [MonthMode(key=k, name=catalog.get(k, (k, "Other"))[0], role=catalog.get(k, (k, "Other"))[1],
                           amount_rs=round(v, 2), txns=m_txn[k]) for k, v in sorted(m_amt.items(), key=lambda t: -t[1])]
        return MonthDetail(fy=fy, month=month, year=ym // 100, kind=kind, label=label, total_rs=round(sum(m_amt.values()), 2),
                           txns=sum(m_txn.values()), modes=modes, institutes=insts)

    def gateways(self, fy: str, sc: "Scope | None" = None) -> tuple[GatewaySummary, list[Gateway]]:
        d, months, orgs = self.scoped(fy, sc or Scope())
        ms = set(months)
        monthly = [round(sum(o["pg"].get(m, 0.0) for _, o in orgs) / CR, CR_DP) for m in months]
        txns = [sum(o["pg_txns"].get(m, 0) for _, o in orgs) for m in months]
        by_seg: dict[str, list[float]] = defaultdict(lambda: [0.0] * len(months))
        seg_txns: dict[str, int] = defaultdict(int)
        for iid, o in orgs:
            if not o["pg"]:
                continue
            seg = self.partner_status(iid, o["db"])
            for i, m in enumerate(months):
                by_seg[seg][i] += o["pg"].get(m, 0.0)
            seg_txns[seg] += sum(n for ym, n in o["pg_txns"].items() if ym in ms)
        summary = GatewaySummary(months=[self.label(m) for m in months], monthly=monthly, txns=txns,
                                 fytd=round(sum(monthly), CR_DP), fytd_txns=sum(txns), attributed=True,
                                 by_segment={k: [round(v / CR, CR_DP) for v in vals] for k, vals in by_seg.items()},
                                 segment_txns=dict(seg_txns))
        # Attribute each institute's gateway collections to its mapped gateway(s), split evenly when it has several.
        og = self.org_gateways()
        last, prev = (months[-1] if months else None), (months[-2] if len(months) > 1 else None)
        agg: dict[str, dict] = defaultdict(lambda: {"amt": 0.0, "txns": 0.0, "last": 0.0, "prev": 0.0, "inst": set()})
        pseudo = {"na": NOT_MCB_LABEL, "unmapped": UNMAPPED_LABEL, "unknown": UNREADABLE_LABEL}
        for iid, o in orgs:
            amt = sum(v for ym, v in o["pg"].items() if ym in ms)
            if not amt:
                continue
            gws = og.get(iid, {}).get("gateways") or [pseudo[self.gateway_status(iid, o["db"])]]
            share = 1 / len(gws)
            n_txn = sum(n for ym, n in o["pg_txns"].items() if ym in ms)
            for g in gws:
                a = agg[g]
                a.setdefault("schools", []).append(GatewaySchool(id=iid, amount_rs=round(amt * share, 2), txns=round(n_txn * share), gateways=len(gws)))
                a["amt"] += amt * share
                a["txns"] += sum(n for ym, n in o["pg_txns"].items() if ym in ms) * share
                a["last"] += o["pg"].get(last, 0.0) * share
                a["prev"] += o["pg"].get(prev, 0.0) * share
                a["inst"].add(iid)
        master = self.gateway_master()
        out = []
        for g, a in agg.items():
            m = master.get(norm(g))
            n = round(a["txns"])
            out.append(Gateway(
                name=g, volume=round(a["amt"] / CR, CR_DP), txns=n, avg_ticket=round(a["amt"] / n, 2) if n else 0,
                last_month=round(a["last"] / CR, CR_DP), mom_pct=round((a["last"] / a["prev"] - 1) * 100, 1) if a["prev"] else None,
                institutes=len(a["inst"]),
                is_partner=self.is_partner(g) if m else None,
                active=bool(m["IsActive"]) if m else None,
                kind="" if g in pseudo.values() else self.gateway_kind(g),
                note={UNREADABLE_LABEL: "Tenant DB not readable", NOT_MCB_LABEL: "Own gateway, not MCB"}.get(g, ""),
                schools=sorted(a.get("schools", []), key=lambda s: (-s.amount_rs, s.id))))
        out.sort(key=lambda x: x.volume, reverse=True)
        return summary, out

    def loans(self, fy: str, sc: "Scope | None" = None) -> LoanSummary:
        _, months, orgs = self.scoped(fy, sc or Scope())
        mm, mt = self._sum_modes(orgs, months)
        amount = [round(mm.get(("loan", m), 0.0) / CR, CR_DP) for m in months]
        txns = [mt.get(("loan", m), 0) for m in months]
        return LoanSummary(months=[self.label(m) for m in months], amount=amount, txns=txns,
                           fytd=round(sum(amount), CR_DP), fytd_txns=sum(txns), fee_ledger_cr=round(sum(amount), CR_DP),
                           partial_last_month=False, source="fee_ledger")

    def _financing(self, fy: str) -> dict:
        """Loan / EMI partners ("financing sources") for one FY: who is mapped to which institute, and what was
        paid through each, per institute and month. Empty when the views cannot be read."""
        def load() -> dict:
            try:
                tx = self._all("""SELECT DBName db, OrganisationID org_id, FinancingSourceName name, YearNo * 100 + MonthNo ym,
                                         SUM(PaidAmount) amt, SUM(NoOfTransactions) txns
                                  FROM dbo.MCB_FinancingSourceWiseTransactions WITH (NOLOCK) WHERE FinancialYear = :fy
                                  GROUP BY DBName, OrganisationID, FinancingSourceName, YearNo, MonthNo""", fy=fy)
                maps = self._all("""SELECT DISTINCT DBName db, OrganisationID org_id, FinancingSourceName name
                                    FROM dbo.MCB_FinancingSourceToOrganisation WITH (NOLOCK)""")
                master = self._all("SELECT MasterFinancingSourceName name, IsActive FROM dbo.MasterFinancingSources WITH (NOLOCK)")
            except Exception as exc:
                log.warning("Loan-partner (financing source) views unreadable: %s", type(exc).__name__)
                return {"tx": [], "maps": [], "in_use": {}}
            return {"tx": tx, "maps": maps, "in_use": {norm(m["name"]): bool(m["IsActive"]) for m in master}}
        return self._cached(f"financing:{fy}", load)

    def loan_partners(self, fy: str, sc: "Scope | None" = None) -> list[LoanPartner]:
        """Partner scorecard: one row per financing source, for the institutes and months in the filters.
        Partners switched off in the master are listed only if they still carried a loan."""
        _, months, orgs = self.scoped(fy, sc or Scope())
        ms, in_scope = set(months), {iid for iid, _ in orgs}
        f = self._financing(fy)
        rows: dict[str, dict] = {}

        def row(name: str) -> dict:
            return rows.setdefault(norm(name), {"name": (name or "").strip(), "mapped": set(), "active": set(), "amt": 0.0, "txns": 0,
                                                "by": defaultdict(lambda: [0.0, 0])})

        for m in f["maps"]:
            iid = f"{m['db']}:{m['org_id']}"
            if iid in in_scope:
                row(m["name"])["mapped"].add(iid)
        for t in f["tx"]:
            iid = f"{t['db']}:{t['org_id']}"
            if iid in in_scope and t["ym"] in ms:
                r = row(t["name"])
                r["amt"] += float(t["amt"] or 0)
                r["txns"] += int(t["txns"] or 0)
                r["by"][iid][0] += float(t["amt"] or 0)
                r["by"][iid][1] += int(t["txns"] or 0)
                if t["amt"] or t["txns"]:
                    r["active"].add(iid)
        out = []
        for k, r in rows.items():
            in_use = f["in_use"].get(k, True)
            if not in_use and not r["txns"]:
                continue
            out.append(LoanPartner(name=r["name"], institutes=len(r["mapped"] | r["active"]), disbursed_cr=round(r["amt"] / CR, CR_DP),
                                   loans=r["txns"], disbursed_rs=round(r["amt"], 2), active_institutes=len(r["active"]), in_use=in_use,
                                   schools=sorted((PartnerSchool(id=i, amount_rs=round(r["by"][i][0], 2) if i in r["by"] else 0.0,
                                                                 loans=r["by"][i][1] if i in r["by"] else 0)
                                                   for i in r["mapped"] | r["active"]), key=lambda s: (-s.amount_rs, -s.loans, s.id))))
        out.sort(key=lambda p: (-p.disbursed_rs, -(p.loans or 0), -p.institutes, p.name.lower()))
        return out

    def loan_reconciliation(self, fy: str, sc: "Scope | None" = None) -> dict:
        """Why the partner total differs from the fee ledger's Loan Payments mode, school by school:
        schools with loan payments but no partner transaction ("unassigned"), and the net difference at the rest."""
        _, months, orgs = self.scoped(fy, sc or Scope())
        ms = set(months)
        fin_amt: dict[str, float] = defaultdict(float)
        fin_txn: dict[str, int] = defaultdict(int)
        in_scope = {iid for iid, _ in orgs}
        for t in self._financing(fy)["tx"]:
            iid = f"{t['db']}:{t['org_id']}"
            if iid in in_scope and t["ym"] in ms:
                fin_amt[iid] += float(t["amt"] or 0)
                fin_txn[iid] += int(t["txns"] or 0)
        led_total = led_txns = un_amt = un_txns = diff_amt = diff_txns = 0
        unassigned = []
        for iid, o in orgs:
            amt = sum(v for (k, ym), v in o["modes"].items() if k == "loan" and ym in ms)
            txns = sum(n for (k, ym), n in o["mode_txns"].items() if k == "loan" and ym in ms)
            led_total += amt
            led_txns += txns
            if fin_amt.get(iid) or fin_txn.get(iid):
                diff_amt += amt - fin_amt[iid]
                diff_txns += txns - fin_txn[iid]
            elif amt or txns:
                un_amt += amt
                un_txns += txns
                unassigned.append((iid, amt))
        unassigned.sort(key=lambda t: -t[1])
        return {"ledger_total_rs": round(led_total, 2), "ledger_loans": led_txns, "unassigned_rs": round(un_amt, 2), "unassigned_loans": un_txns,
                "unassigned_institutes": [i for i, _ in unassigned], "difference_rs": round(diff_amt, 2), "difference_loans": diff_txns}

    def institutes(self, fy: str, owners: dict[str, str], consent: dict[str, Consent], sc: "Scope | None" = None) -> Institutes:
        _, months, orgs = self.scoped(fy, sc or Scope())
        ms = set(months)
        # School figures cover the latest N complete months, unless a month range was picked: then exactly that range.
        window = months if (sc and (sc.m_from or sc.m_to)) else months[-self.s.institute_months:]
        og = self.org_gateways()
        am = self.account_teams()
        none = AccountTeam()
        insts = []
        for iid, o in orgs:
            g = og.get(iid, {})
            status = self.gateway_status(iid, o["db"])
            fy_modes: dict[str, float] = defaultdict(float)
            for (k, ym), v in o["modes"].items():
                if ym in ms:
                    fy_modes[k] += v
            if not any(fy_modes.values()) and not o.get("extra"):
                continue                         # nothing collected in the selected months (listed extras still show)
            mix = self.branch_mix(iid)
            insts.append(Institute(
                branch_mix=mix, branch_coverage=self.branch_coverage(mix), branch_gateways=self.branch_gateways(iid),
                partner_status=self.partner_status(iid, o["db"]),
                fy_modes={k: round(v, 2) for k, v in fy_modes.items() if v},
                fy_txns=sum(n for (k, ym), n in o["mode_txns"].items() if ym in ms),
                id=iid, name=o["name"], db=o["db"], org_id=o["org_id"],
                branches=len(g.get("branches", {})), students=max((o["students"].get(m, 0) for m in window), default=0),
                months=[(round(o["pg"].get(m, 0.0), 2), round(o["off"].get(m, 0.0), 2)) for m in window],
                offline_months=[round(sum(o["modes"].get((k, m), 0.0) for k in OFFLINE_KEYS), 2) for m in window],
                active_students=self._am_students.get(iid.lower()) if self._am_at > 0 else None,
                owner=owners.get(iid, ""), account_manager=am.get(iid.lower(), none).account_manager, account=am.get(iid.lower(), none), consent=consent.get(iid, Consent()),
                gateways=g.get("gateways", []), gateway_known=status != "unknown", gateway_status=status,
                na_branches=mix["na"]))
        return Institutes(months=[self.label(m) for m in window], institutes=insts,
                          account_ready=not self.s.account_team or self._am_at > 0)

    def branches(self, iid: str) -> list[Branch]:
        g = self.org_gateways().get(iid, {})
        out = []
        for bid, b in sorted(g.get("branches", {}).items()):
            st = self.branch_status(b)
            out.append(Branch(id=bid, name=b["name"], gateways=b["gateways"], status=st,
                              gateway=", ".join(b["gateways"]) or ("N/A" if st == "na" else None),
                              is_partner=True if st == "partner" else False if st == "non_partner" else None))
        return out

    def institute_modes(self, fy: str, iid: str, sc: "Scope | None" = None) -> tuple[list[str], list[InstituteMode], list[int]]:
        """Every payment mode this institute used in the selected months (rupees), plus paying students per month."""
        d, months, _ = self.scoped(fy, Scope(m_from=(sc or Scope()).m_from, m_to=(sc or Scope()).m_to))
        o = d.orgs.get(iid)
        if o is None:
            return [], [], []
        modes = []
        keep = set((sc or Scope()).modes)
        for key, nm, role, _ in self.mode_catalog(d):
            if keep and key not in keep:
                continue
            values = [round(o["modes"].get((key, m), 0.0), 2) for m in months]
            if any(values):
                modes.append(InstituteMode(key=key, name=nm, role=role, values=values,
                                           txns=[o["mode_txns"].get((key, m), 0) for m in months]))
        return [self.label(m) for m in months], modes, [o["students"].get(m, 0) for m in months]

    def gateway_master_list(self, fy: str, sc: "Scope | None" = None) -> list[MasterGateway]:
        """Every gateway in dbo.MasterPaymentGateways — active and inactive — plus mapped gateways missing from it,
        with branches / institutes mapped (within the filters) and attributed volume."""
        sc = sc or Scope()
        _, gws = self.gateways(fy, sc)
        vol = {norm(g.name): g for g in gws}
        _, _, orgs = self.scoped(fy, sc)
        in_scope = {iid for iid, _ in orgs}
        branches: dict[str, int] = defaultdict(int)
        insts: dict[str, set] = defaultdict(set)
        for iid, g in self.org_gateways().items():
            if iid not in in_scope:
                continue
            for b in g["branches"].values():
                for name in b["gateways"]:
                    branches[norm(name)] += 1
            for name in g["gateways"]:
                insts[norm(name)].add(iid)
        rows: dict[str, MasterGateway] = {}
        for k, m in self.gateway_master().items():
            v = vol.get(k)
            rows[k] = MasterGateway(
                id=m["MasterPaymentGatewayID"], name=m["MasterPaymentGatewayName"].strip(), in_master=True,
                active=bool(m["IsActive"]), partner=bool(m["IsMCBPartner"]), commission_sharing=m["IsCommisionSharing"],
                kind=self.gateway_kind(m["MasterPaymentGatewayName"]), branches=branches.get(k, 0), institutes=len(insts.get(k, ())),
                institute_ids=sorted(insts.get(k, ())),
                volume=v.volume if v else 0.0, txns=v.txns if v else 0, last_month=v.last_month if v else 0.0, mom_pct=v.mom_pct if v else None)
        for k in set(branches) | set(insts):            # mapped to institutes but missing from the master
            if k not in rows:
                v = vol.get(k)
                name = v.name if v else next(n for iid, g in self.org_gateways().items() for n in g["gateways"] if norm(n) == k)
                rows[k] = MasterGateway(id=None, name=name, in_master=False, active=None, partner=None, commission_sharing=None,
                                        kind="unknown", branches=branches.get(k, 0), institutes=len(insts.get(k, ())),
                                        institute_ids=sorted(insts.get(k, ())),
                                        volume=v.volume if v else 0.0, txns=v.txns if v else 0,
                                        last_month=v.last_month if v else 0.0, mom_pct=v.mom_pct if v else None)
        # Inactive gateways (IsActive = 0) are not shown.
        return sorted((r for r in rows.values() if r.kind != "inactive"), key=lambda r: (-r.volume, -r.branches, r.name.lower()))

    def mode_options(self, fy: str) -> list[FilterOption]:
        """Payment modes from dbo.MCBFeePaymentModes (UPI's two IDs merged), with institutes using each this FY."""
        d = self.fy_data(fy)
        used: dict[str, int] = defaultdict(int)
        for o in d.orgs.values():
            for k in {k for (k, _) in o["modes"]}:
                used[k] += 1
        seen, out = set(), []
        for mid, nm in sorted(self.mode_names().items()):
            key = mode_info(mid)[0]
            if key in seen:
                continue
            seen.add(key)
            out.append(FilterOption(value=key, label=NAME_OVERRIDES.get(key, nm), count=used.get(key, 0)))
        out.sort(key=lambda o: (MODE_ORDER.index(o.value) if o.value in MODE_ORDER else 99, o.label))
        return out

    def fy_month_labels(self, fy: str) -> list[str]:
        return [self.label(m) for m in self.fy_data(fy).months]

    def filter_options(self, fy: str, inst: Institutes) -> dict[str, list[FilterOption]]:
        dbs: dict[str, int] = defaultdict(int)
        gws: dict[str, int] = defaultdict(int)
        for i in inst.institutes:
            dbs[i.db] += 1
            for g in i.gateways:
                gws[g] += 1
            if not i.gateways:
                gws["__" + i.gateway_status + "__"] += 1
        label = {"__na__": NOT_MCB_LABEL, "__unmapped__": UNMAPPED_LABEL, "__unknown__": UNREADABLE_LABEL}
        seg, cov = defaultdict(int), defaultdict(int)
        for i in inst.institutes:
            seg[i.partner_status] += 1
            cov[i.branch_coverage] += 1
        return {
            "dbs": [FilterOption(value=k, label=k, count=v) for k, v in sorted(dbs.items())],
            "gateways": [FilterOption(value=k, label=label.get(k, k), count=v) for k, v in sorted(gws.items(), key=lambda t: (t[0].startswith("__"), t[0].lower()))],
            "partners": [FilterOption(value=k, label=lbl, count=sum(seg[s] for s in segs)) for k, (lbl, segs) in PG_FILTER.items()]
                        + [FilterOption(value=CASH_FIRST, label=CASH_FIRST_LABEL, count=sum(1 for i in inst.institutes if is_cash_first(i.fy_modes)))],
            "coverage": [FilterOption(value=k, label=lbl, count=cov[k]) for k, lbl in COVERAGE_LABELS.items() if cov.get(k)],
        }
