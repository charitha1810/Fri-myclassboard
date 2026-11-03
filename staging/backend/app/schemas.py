"""API contract. Every response the frontend reads is one of these models.

Units: fields ending in `_cr` and the mode/gateway/loan series are ₹ crore; institute month
pairs and fields ending in `_rs` are rupees.
"""
from datetime import date
from typing import Literal, Optional

from pydantic import BaseModel, Field

Role = Literal["Earns", "Convertible", "Outside MCB PG", "Mandate", "Other"]
ConsentState = Literal["y", "p", "n"]  # granted, pending, not asked
Channel = Literal["sms", "wa", "app"]


# ---------- Meta & settings ----------
class Freshness(BaseModel):
    org_wise: str
    gateway: str
    modes: str


class Owner(BaseModel):
    id: str  # initials shown in avatars
    name: str


class User(BaseModel):
    initials: str
    email: str


class Meta(BaseModel):
    fy: str
    fy_options: list[str]
    freshness: Freshness
    owners: list[Owner]
    user: User
    notices: list[str] = []  # data-coverage caveats shown to users (e.g. tenant DBs without access)
    snapshot: str = ""       # ISO GeneratedDate of the payments snapshot these figures come from


class RevenueSettings(BaseModel):
    take_bps: float = Field(30, ge=0, le=500)
    loan_fee_pct: float = Field(1.0, ge=0, le=10)
    conv_pct: float = Field(30, ge=0, le=100)
    quarter_target_rs: Optional[float] = None


# ---------- Payment modes ----------
class PaymentMode(BaseModel):
    key: str
    name: str
    role: Role
    play: str
    values: list[float]  # ₹ Cr per month, aligned with PaymentModes.months


class LastMonthStats(BaseModel):
    txns: Optional[int] = None
    paying_students: Optional[int] = None


class ModeGroup(BaseModel):
    """One part of total fees. Every payment mode belongs to exactly one group, and the rounded values are fitted
    so the groups add up to the total to the last paisa shown: sum(values[i]) == month_totals[i], sum(fytd) == total_fytd."""
    key: str             # pg / neft / offline / ecs / loan / other
    label: str
    includes: list[str]  # database names of the payment modes in this group that have money
    values: list[float]  # ₹ Cr per month, aligned with PaymentModes.months
    fytd: float          # ₹ Cr over all the months
    txns: list[int]
    fytd_txns: int


class PaymentModes(BaseModel):
    months: list[str]
    month_totals: list[float]
    modes: list[PaymentMode]
    last_month: LastMonthStats
    total_fytd: float = 0.0          # ₹ Cr over all the months, rounded once from the database sum
    groups: list[ModeGroup] = []


class MonthMode(BaseModel):
    key: str
    name: str
    role: Role
    amount_rs: float
    txns: int


class MonthInstitute(BaseModel):
    id: str
    name: str
    db: str
    amount_rs: float
    txns: int


class TotalStep(BaseModel):
    key: str           # raw / month / store / demo / inactive / portal
    label: str
    amount_rs: float   # the raw and portal lines are totals; the lines between are what is taken off (negative)
    rows: int          # rows of MCBOrganisationPaymentsAnalysis behind the line
    organisations: int = 0
    note: str = ""


class TotalReconciliation(BaseModel):
    """From every row of the financial year to the portal's "Total fees collected", one rule at a time.
    steps[0].amount_rs + sum(steps[1:-1].amount_rs) == steps[-1].amount_rs."""
    fy: str
    snapshot: str
    steps: list[TotalStep]


class MonthRow(BaseModel):
    month: str                 # 'Apr'
    year: int
    total_rs: float            # == sum(groups.values())
    txns: int
    groups: dict[str, float]   # rupees by SUMMARY_GROUPS key


class MonthlySummary(BaseModel):
    """Fees month by month, split into the same parts as the headline tiles, in rupees.
    total_rs == sum(months.total_rs) and group_totals[k] == sum(months.groups[k])."""
    fy: str
    groups: list[dict[str, str]]   # [{key, label, short}] in display order
    months: list[MonthRow]
    total_rs: float
    txns: int
    group_totals: dict[str, float]


class MonthDetail(BaseModel):
    """One month of one kind of fees: every payment mode and every school behind a chart column."""
    fy: str
    month: str           # 'Apr'
    year: int
    kind: str            # all / a group key / a payment-mode key
    label: str
    total_rs: float      # == sum(modes.amount_rs) == sum(institutes.amount_rs)
    txns: int
    modes: list[MonthMode]
    institutes: list[MonthInstitute]   # every school with money, biggest first


# ---------- Gateways ----------
class GatewaySummary(BaseModel):
    months: list[str]
    monthly: list[float]
    txns: list[int]
    fytd: float
    fytd_txns: int
    # True when per-gateway figures are attributed from institute→gateway mappings rather than reported per gateway.
    attributed: bool = True
    # Online Payment (₹ Cr) per month by partner segment: partner / non_partner / na / unmapped / unknown
    by_segment: dict[str, list[float]] = {}
    segment_txns: dict[str, int] = {}


class GatewaySchool(BaseModel):
    id: str            # institute id
    amount_rs: float   # this school's online fees credited to the gateway (split equally when it uses several)
    txns: int
    gateways: int = 1  # how many gateways the school's online fees are split between


class Gateway(BaseModel):
    name: str
    volume: float
    txns: int
    avg_ticket: float
    last_month: float
    mom_pct: Optional[float]
    institutes: int = 0
    is_partner: Optional[bool] = None
    active: Optional[bool] = None
    # partner = IsActive=1 & IsMCBPartner=1 · non_partner = IsActive=1, not a partner · inactive = IsActive=0
    # · unknown = not in MasterPaymentGateways · "" = pseudo rows (N/A, no mapping)
    kind: str = ""
    note: str = ""
    schools: list[GatewaySchool] = []   # the `institutes` behind this row, biggest first; adds up to the volume


class MasterGateway(BaseModel):
    """One row of dbo.MasterPaymentGateways (active and inactive), or a mapped gateway missing from it."""
    id: Optional[int]
    name: str
    in_master: bool
    active: Optional[bool]
    partner: Optional[bool]
    commission_sharing: Optional[bool]
    kind: str
    branches: int = 0
    institutes: int = 0
    volume: float = 0.0     # attributed Online Payment, ₹ Cr, within the filters
    txns: int = 0
    last_month: float = 0.0
    mom_pct: Optional[float] = None
    institute_ids: list[str] = []   # the `institutes` mapped to this gateway, within the filters


class Signal(BaseModel):
    kind: Literal["data", "churn", "growth", "emi"]
    text: str


class Gateways(BaseModel):
    summary: GatewaySummary
    gateways: list[Gateway]
    signals: list[Signal]


# ---------- Loans ----------
class LoanSummary(BaseModel):
    months: list[str]
    amount: list[float]
    txns: list[int]
    fytd: float
    fytd_txns: int
    fee_ledger_cr: Optional[float] = None
    partial_last_month: bool = False
    source: str = "fee_ledger"  # "fee_ledger" = Loan Payments mode; partner disbursal feed not connected yet


class PartnerSchool(BaseModel):
    id: str               # institute id
    amount_rs: float      # paid through this partner in the selected months (0 = mapped only)
    loans: int


class LoanPartner(BaseModel):
    """One financing source (loan / EMI partner) from the financing-source tables, within the filters."""
    name: str
    institutes: int                 # institutes mapped to this partner (MCB_FinancingSourceToOrganisation)
    disbursed_cr: Optional[float]
    loans: Optional[int]            # NoOfTransactions
    disbursed_rs: float = 0.0       # exact rupees (PaidAmount) for the selected months
    active_institutes: int = 0      # institutes with at least one loan payment through this partner
    in_use: bool = True             # IsActive in MasterFinancingSources (True when not listed there)
    schools: list[PartnerSchool] = []   # every mapped or paying institute, biggest amount first; sums to disbursed_rs / loans


class Loans(BaseModel):
    summary: LoanSummary
    partners: list[LoanPartner]
    partners_total_rs: float = 0.0  # sum of partners.disbursed_rs; not the same table as summary (fee ledger)
    partners_loans: int = 0
    # Reconciliation with the fee ledger's Loan Payments mode (the chart), so the scorecard adds up to it:
    #   ledger_total_rs == partners_total_rs + unassigned_rs + difference_rs   (and the same for the loan counts)
    ledger_total_rs: float = 0.0
    ledger_loans: int = 0
    unassigned_rs: float = 0.0        # loan payments at schools with no partner transaction at all
    unassigned_loans: int = 0
    unassigned_institutes: list[str] = []   # those schools' ids, biggest loan payments first
    difference_rs: float = 0.0        # ledger minus partner amount at schools that do have partner transactions
    difference_loans: int = 0


# ---------- Institutes ----------
class Consent(BaseModel):
    sms: ConsentState = "n"
    wa: ConsentState = "n"
    app: ConsentState = "n"


class Branch(BaseModel):
    id: int
    name: str
    gateway: Optional[str] = None      # display text: gateway names, or "N/A"
    gateways: list[str] = []
    status: Literal["partner", "non_partner", "na", "none"] = "none"
    is_partner: Optional[bool] = None


PartnerStatus = Literal["partner", "non_partner", "no_active", "na", "unmapped", "unknown"]


class GatewayBranches(BaseModel):
    """One payment gateway an institute uses and the branches on it (a branch on two gateways appears under both)."""
    gateway: str                 # gateway name, "N/A" (not using MCB gateways) or "No gateway"
    kind: str                    # partner / non_partner / inactive / unknown / na / none
    branches: list[str] = []


class InstituteMode(BaseModel):
    key: str
    name: str
    role: Role
    values: list[float]  # rupees per month, aligned with InstituteDetail.months
    txns: list[int]


class AccountTeam(BaseModel):
    """Who looks after an organisation, from dbo.USP_GET_BranchAnalysis_MCBMaster ("Name · phone"; "" = not recorded)."""
    location: str = ""
    account_manager: str = ""
    implementation_manager: str = ""
    implementation_executive: str = ""
    sales_person: str = ""
    rm: str = ""
    csm: str = ""
    customer_type: str = ""


class Institute(BaseModel):
    id: str            # "<DBName>:<OrganisationID>" — OrganisationID repeats across tenant DBs
    name: str
    db: str
    org_id: int
    type: Optional[str] = None
    region: Optional[str] = None
    branches: int = 0
    students: int = 0  # most students paying in any month of the window
    # Active students across the school's branches (USP_GET_BranchAnalysis_MCBMaster.ActiveStudents); None = not loaded yet
    active_students: Optional[int] = None
    months: list[tuple[float, float]]  # [MCB gateway rs, every other payment mode rs] per month in Institutes.months
    offline_months: list[float] = []   # cash + card swipe + cheque + DD per month: the part of "other" that is offline
    owner: str = ""
    account_manager: str = ""          # same as account.account_manager, kept flat for lists
    account: AccountTeam = AccountTeam()
    consent: Consent
    gateways: list[str] = []
    gateway_known: bool = False  # False when the tenant DB's gateway view could not be read
    # mcb = on an MCB gateway · na = mapping says "NA": not using MCB payment gateways · unmapped · unknown
    gateway_status: Literal["mcb", "na", "unmapped", "unknown"] = "unmapped"
    na_branches: int = 0  # branches marked NA (not on an MCB gateway)
    # partner = on an MCB-partner gateway (MasterPaymentGateways.IsMCBPartner) · non_partner = gateway, not a partner
    partner_status: PartnerStatus = "unmapped"
    # Branches by gateway status: partner / non_partner (on an MCB gateway) · na (marked NA) · none (no value)
    branch_mix: dict[str, int] = {}
    # all / partial / none branches on an MCB gateway · unmapped = no branch rows
    branch_coverage: Literal["all", "partial", "none", "unmapped"] = "unmapped"
    # Which payment gateway each branch uses, grouped by gateway (biggest group first)
    branch_gateways: list[GatewayBranches] = []
    fy_modes: dict[str, float] = {}  # FY-to-date rupees by payment-mode key (complete months)
    fy_txns: int = 0


class Institutes(BaseModel):
    months: list[str]
    institutes: list[Institute]
    account_ready: bool = True   # False while the account teams are still being read after a start


class InstituteDetail(BaseModel):
    institute: Institute
    branch_list: list[Branch]
    months: list[str] = []            # every complete month of the FY
    modes: list[InstituteMode] = []   # payment modes used, month by month
    students: list[int] = []          # paying students per month (summed across modes)
    gateway_partner: dict[str, Optional[bool]] = {}


class FilterOption(BaseModel):
    value: str
    label: str
    count: int = 0
    pg: str = ""    # school options only: the school's value in the "Which gateway the school uses" filter


class FilterOptions(BaseModel):
    """Every dropdown on the Institutes screen is built from this; nothing is hardcoded in the UI."""
    dbs: list[FilterOption]
    gateways: list[FilterOption]
    partners: list[FilterOption] = []
    coverage: list[FilterOption] = []
    months: list[str] = []                 # complete months of the FY, for the from / to filter
    modes: list[FilterOption] = []         # payment modes from MCBFeePaymentModes
    gw_kinds: list[FilterOption] = []      # active partner / active non-partner / inactive / not in master
    institutes: list[FilterOption] = []    # every school, for the school filter and picker
    branches: list[FilterOption]
    owners: list[FilterOption]
    types: list[FilterOption] = []
    regions: list[FilterOption] = []


class AssignOwner(BaseModel):
    ids: list[str]
    owner: str


class ConsentUpdate(BaseModel):
    channel: Channel
    state: ConsentState


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    follow_up: Optional[str] = None  # ISO date


class Note(BaseModel):
    id: str
    institute_id: str
    created_at: str
    text: str
    follow_up: Optional[str] = None


class Alert(BaseModel):
    severity: Literal["danger", "warning", "info", "growth"]
    title: str
    text: str
    institute_id: Optional[str] = None


# ---------- Pipeline ----------
class Stage(BaseModel):
    id: str
    name: str
    prob: float


class Deal(BaseModel):
    id: str
    stage: str
    institute_id: str
    play: str
    next: str = "Plan first call"
    owner: str = ""
    days: int = 0
    loan_only: bool = False


class Pipeline(BaseModel):
    stages: list[Stage]
    deals: list[Deal]


class DealIn(BaseModel):
    institute_id: str
    play: str
    next: str = "Plan first call"
    owner: Optional[str] = None
    loan_only: bool = False


class DealMove(BaseModel):
    stage: str


# ---------- Commission ----------
class CommissionInstitute(BaseModel):
    id: str
    name: str
    db: str
    volume_rs: float            # extra partner-gateway volume this lever would bring, selected months
    commission_yr_rs: float     # annualised commission on that volume
    collected_rs: float
    online_rs: float
    offline_rs: float
    gateways: list[str] = []
    partner_status: str = ""
    note: str = ""


class CommissionLever(BaseModel):
    key: str
    title: str
    how: str
    institutes: int
    volume_rs: float
    volume_yr_rs: float
    commission_yr_rs: float
    top: list[CommissionInstitute]
    filter: dict[str, str] = {}   # global filter that lists this lever's institutes


class CommissionView(BaseModel):
    months: int
    rate_bps: float
    conv_pct: float
    earning_volume_rs: float      # Online Payment attributed to active partner gateways
    earning_volume_yr_rs: float
    commission_rs: float
    commission_yr_rs: float
    loan_fee_yr_rs: float
    total_collected_rs: float
    levers: list[CommissionLever]


# ---------- AI suggestions ----------
class Suggestion(BaseModel):
    title: str
    lever: str
    priority: Literal["high", "medium", "low"]
    why: str
    action: str
    institutes: list[str] = []
    expected_volume_cr: float = 0.0
    expected_commission_lakh_yr: float = 0.0


class SuggestionsOut(BaseModel):
    scope: str
    headline: str
    suggestions: list[Suggestion]
    data_notes: list[str] = []
    model: str
    generated_at: str
    snapshot: str
    cached: bool = False


class SuggestionsIn(BaseModel):
    institute_id: Optional[str] = None   # None = portfolio (current filters)
    refresh: bool = False


# ---------- Campaigns ----------
class CampaignIn(BaseModel):
    name: str
    status: Literal["draft", "scheduled"] = "draft"
    scope: Literal["selected", "all"] = "selected"
    institute_ids: list[str] = []
    channels: list[Channel] = []
    parent_filters: list[str] = []
    message: str
    amount_mode: str
    expiry: str
    short_domain: str = ""
    payment_options: list[str] = []
    cadence: list[str] = []


class Activity(BaseModel):
    at: str            # ISO timestamp
    who: str = ""      # signed-in user who did it; "" for entries from before the activity log existed
    kind: str          # note / pipeline / owner / consent / campaign
    text: str


class ActivityView(BaseModel):
    owners: list[str] = []      # assigned pipeline owner(s) of the institute
    can_add: bool = False       # the signed-in user is one of them
    items: list[Activity] = []


class ActivityIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


class DueStudents(BaseModel):
    schools: dict[str, Optional[int]]   # school id -> students with unpaid fees; None = no fee search index for that school


class DueStudent(BaseModel):
    id: Optional[int] = None  # StudentEnrollmentID
    name: str
    code: str = ""
    cls: str = ""
    branch: str = ""
    amount: float            # unpaid: instalment amount - concession - paid, summed over all the student's instalments
    due_date: Optional[date]  # earliest unpaid instalment (None = no due date set)
    items: int = 0
    dues: list[tuple[Optional[date], float, bool]] = []   # each unpaid instalment: (due date, amount, partly paid)
    father: str = ""
    father_phone: str = ""
    mother: str = ""
    mother_phone: str = ""


class WhatsAppTestIn(BaseModel):
    to: str = Field(min_length=10, max_length=16)   # mobile number for the test
    template: str
    institute: str = ""        # school name shown in the test (not part of the template text)


class WhatsAppSendIn(BaseModel):
    institute_id: str
    student_ids: list[int] = Field(min_length=1, max_length=2000)   # StudentEnrollmentID
    month: str = ""           # yyyy-mm (several comma-separated): remind only those months' instalments; "" = all of the year
    template: str = ""        # one of settings.aisensy_template_choices; "" = chosen by days to the due date
    filters: list[str] = []   # "Which parents": due_7d, partially_paid (feesearch.AUDIENCE_FILTERS)


class PushSendIn(BaseModel):
    institute_id: str
    student_ids: list[int] = Field(min_length=1, max_length=2000)   # StudentEnrollmentID
    month: str = ""
    filters: list[str] = []
    title: str = ""           # "" = "Fee due {due_date}"; {student_name} {amount_due} {due_date} {institute} are filled in
    message: str = ""         # "" = "₹{amount_due} for {student_name}. Tap to pay securely — UPI, card or EMI."


class DueList(BaseModel):
    institute_id: str
    institute: str
    today: date               # India date the list was read (due dates before it are overdue)
    fy: str = ""              # financial year the list covers, e.g. 2026-27
    students: list[DueStudent]
    branch_pg: dict[str, list[str]] = {}   # branch name (lower case) -> its payment gateways; [] = no PG; absent = unknown


class CampaignOut(BaseModel):
    id: str
    status: str
    institutes: int
