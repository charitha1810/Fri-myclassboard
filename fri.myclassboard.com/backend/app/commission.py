"""Commission model: MCB earns on fee payments that flow through ACTIVE MCB-PARTNER gateways
(MasterPaymentGateways.IsActive = 1 AND IsMCBPartner = 1). Everything here sizes how to grow that flow.

Volumes are in rupees for the selected months; `*_yr` values are annualised (× 12 / months).
"""
from __future__ import annotations

from .analytics import OFFLINE_KEYS, Analytics, Scope  # noqa: F401  (Scope kept for callers' type hints)
from .insights import rs
from .schemas import CommissionInstitute, CommissionLever, CommissionView, Institute, RevenueSettings

OFFLINE = OFFLINE_KEYS


def partner_fraction(an: Analytics, i: Institute) -> float:
    """Share of an institute's gateway collections attributed to active partner gateways (gateways split evenly)."""
    if not i.gateways:
        return 0.0
    return sum(1 for g in i.gateways if an.gateway_kind(g) == "partner") / len(i.gateways)


def _total(i: Institute) -> float:
    return sum(i.fy_modes.values())


def _offline(i: Institute) -> float:
    return sum(i.fy_modes.get(k, 0.0) for k in OFFLINE)


def commission_view(an: Analytics, fy: str, sc: Scope, inst: list[Institute], months: int, st: RevenueSettings,
                    top: int = 10) -> CommissionView:
    rate = st.take_bps / 10000
    conv = st.conv_pct / 100
    annual = 12 / months if months else 0.0

    def row(i: Institute, volume: float, note: str) -> CommissionInstitute:
        return CommissionInstitute(id=i.id, name=i.name, db=i.db, volume_rs=round(volume, 2), commission_yr_rs=round(volume * rate * annual, 2),
                                   collected_rs=round(_total(i), 2), online_rs=round(i.fy_modes.get("pg", 0.0), 2),
                                   offline_rs=round(_offline(i), 2), gateways=i.gateways, partner_status=i.partner_status, note=note)

    def lever(key: str, title: str, how: str, rows: list[CommissionInstitute], preset: dict) -> CommissionLever:
        rows.sort(key=lambda r: r.volume_rs, reverse=True)
        vol = sum(r.volume_rs for r in rows)
        return CommissionLever(key=key, title=title, how=how, institutes=len(rows), volume_rs=round(vol, 2),
                               volume_yr_rs=round(vol * annual, 2), commission_yr_rs=round(vol * rate * annual, 2),
                               top=rows[:top], filter=preset)

    earning = 0.0
    a, b, c, d = [], [], [], []
    for i in inst:
        pg = i.fy_modes.get("pg", 0.0)
        pf = partner_fraction(an, i)
        earning += pg * pf
        off = _offline(i)
        if i.partner_status == "partner" and off > 0:
            a.append(row(i, off * conv, f"If {conv:.0%} of its {rs(off)} cash, card, cheque and DD is paid online instead"))
        if pg * (1 - pf) > 0 and i.partner_status in ("partner", "non_partner", "no_active", "unmapped"):
            b.append(row(i, pg * (1 - pf), "Online fees paid through a gateway that is not our partner"))
        if i.partner_status == "na":
            d.append(row(i, _total(i) * conv, f"Uses no MCB gateway today; assumes {conv:.0%} of its fees move to ours"))
        if i.branch_coverage == "partial" and i.branches:
            na_share = (i.branch_mix.get("na", 0) + i.branch_mix.get("none", 0)) / i.branches
            if na_share > 0:
                c.append(row(i, _total(i) * na_share * conv,
                             f"{i.branch_mix.get('na', 0)} of {i.branches} branches have no MCB gateway (estimated by branch count)"))

    levers = [
        lever("convert_offline", "Get partner-gateway schools to collect cash & cheques online",
              "These schools already have our partner gateway. Send pay-link reminders before due dates and put an MCB UPI QR at the fee counter.",
              a, {"partner": "partner"}),
        lever("switch_gateway", "Switch schools from other gateways to our partner gateway",
              "Parents already pay online here, but through a gateway that is not our partner, so we earn nothing on it today.",
              b, {"gw_kind": "non_partner"}),
        lever("onboard_branches", "Add the remaining branches of schools already with us",
              "The school uses our partner gateway at some branches. Set up the same gateway at the branches that don't have it.",
              c, {"coverage": "partial"}),
        lever("onboard_na", "Sign up schools that don't use any MCB gateway",
              "These schools collect every rupee outside MCB. Sell our partner gateway with pay links and a counter QR.",
              d, {"gateway": "__na__"}),
    ]
    loan = sum(i.fy_modes.get("loan", 0.0) for i in inst)
    return CommissionView(
        months=months, rate_bps=st.take_bps, conv_pct=st.conv_pct,
        earning_volume_rs=round(earning, 2), earning_volume_yr_rs=round(earning * annual, 2),
        commission_rs=round(earning * rate, 2), commission_yr_rs=round(earning * rate * annual, 2),
        loan_fee_yr_rs=round(loan * st.loan_fee_pct / 100 * annual, 2),
        total_collected_rs=round(sum(_total(i) for i in inst), 2), levers=levers)
