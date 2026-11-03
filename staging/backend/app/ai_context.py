"""Build the compact, factual context Claude sees for suggestions — portfolio (current filters) or one school."""
from __future__ import annotations

from .analytics import COVERAGE_LABELS, PG_FILTER_LABELS, SEGMENT_LABELS, Analytics, Scope
from .commission import OFFLINE, partner_fraction
from .schemas import CommissionView, Institute, InstituteMode, RevenueSettings

CR, LAKH = 1e7, 1e5


def _cr(v: float) -> float:
    return round(v / CR, 2)


def _filters(sc: Scope) -> dict:
    f = {k: v for k, v in {"databases": list(sc.dbs), "gateway_partner": PG_FILTER_LABELS.get(sc.partner, sc.partner),
                            "branch_coverage": COVERAGE_LABELS.get(sc.coverage, sc.coverage), "gateway": sc.gateway,
                            "gateway_status": sc.gw_kind, "payment_modes": list(sc.modes), "school": sc.inst,
                            "from_month": sc.m_from, "to_month": sc.m_to}.items() if v}
    return f or {"note": "no filters: all institutes, full financial year to date"}


def portfolio_context(an: Analytics, fy: str, sc: Scope, inst: list[Institute], months: list[str],
                      cv: CommissionView, st: RevenueSettings) -> dict:
    total = sum(sum(i.fy_modes.values()) for i in inst)
    names = {k: nm for k, nm, _, _ in an.mode_catalog(an.fy_data(fy))}   # readable payment-mode names, not internal keys
    by_mode: dict[str, float] = {}
    for i in inst:
        for k, v in i.fy_modes.items():
            n = names.get(k, k)
            by_mode[n] = by_mode.get(n, 0.0) + v
    segs = []
    for key, label in SEGMENT_LABELS.items():
        lst = [i for i in inst if i.partner_status == key]
        if not lst:
            continue
        t = sum(sum(i.fy_modes.values()) for i in lst)
        pg = sum(i.fy_modes.get("pg", 0.0) for i in lst)
        segs.append({"segment": label, "institutes": len(lst), "collected_cr": _cr(t), "online_mcb_pg_cr": _cr(pg),
                     "online_share_pct": round(100 * pg / t, 1) if t else 0,
                     "offline_cash_card_cheque_dd_cr": _cr(sum(sum(i.fy_modes.get(k, 0.0) for k in OFFLINE) for i in lst))})
    cov = []
    for key, label in COVERAGE_LABELS.items():
        lst = [i for i in inst if i.branch_coverage == key]
        if lst:
            t = sum(sum(i.fy_modes.values()) for i in lst)
            pg = sum(i.fy_modes.get("pg", 0.0) for i in lst)
            cov.append({"coverage": label, "institutes": len(lst), "branches": sum(i.branches for i in lst),
                        "branches_na": sum(i.branch_mix.get("na", 0) for i in lst), "collected_cr": _cr(t),
                        "online_share_pct": round(100 * pg / t, 1) if t else 0})
    _, gws = an.gateways(fy, sc)
    gateways = [{"gateway": g.name, "status": g.kind or "n/a", "volume_cr": round(g.volume, 2), "institutes": g.institutes,
                 "last_month_vs_previous_pct": g.mom_pct} for g in gws[:15]]
    return {
        "financial_year": fy, "months": months, "filters": _filters(sc),
        "assumptions": {"commission_rate_bps": st.take_bps, "commission_rate_pct": st.take_bps / 100,
                        "offline_conversion_target_pct": st.conv_pct, "loan_fee_pct": st.loan_fee_pct},
        "totals": {"institutes": len(inst), "collected_cr": _cr(total),
                   "by_payment_mode_cr": {k: _cr(v) for k, v in sorted(by_mode.items(), key=lambda t: -t[1]) if v >= 1e5},
                   "partner_gateway_volume_cr": _cr(cv.earning_volume_rs),
                   "partner_gateway_volume_yr_cr": _cr(cv.earning_volume_yr_rs),
                   "commission_now_yr_lakh": round(cv.commission_yr_rs / LAKH, 1)},
        "segments": segs, "branch_coverage": cov, "gateways": gateways,
        "levers_computed": [{"lever": lv.key, "title": lv.title, "institutes": lv.institutes,
                             "extra_volume_yr_cr": _cr(lv.volume_yr_rs), "extra_commission_yr_lakh": round(lv.commission_yr_rs / LAKH, 1),
                             "top_institutes": [{"name": r.name, "db": r.db, "collected_cr": _cr(r.collected_rs), "online_mcb_pg_cr": _cr(r.online_rs),
                                                 "offline_cr": _cr(r.offline_rs), "gateways": r.gateways, "basis": r.note} for r in lv.top[:8]]}
                            for lv in cv.levers],
    }


def institute_context(an: Analytics, fy: str, i: Institute, months: list[str], modes: list[InstituteMode],
                      branches: list, peers: list[Institute], st: RevenueSettings) -> dict:
    total = sum(sum(m.values) for m in modes)
    seg_peers = [p for p in peers if p.partner_status == "partner" and p.id != i.id]
    peer_share = (sum(p.fy_modes.get("pg", 0.0) for p in seg_peers) / sum(sum(p.fy_modes.values()) for p in seg_peers)) if seg_peers else 0
    return {
        "financial_year": fy, "months": months,
        "assumptions": {"commission_rate_bps": st.take_bps, "offline_conversion_target_pct": st.conv_pct},
        "school": {"name": i.name, "database": i.db, "organisation_id": i.org_id,
                   "gateway_partner_segment": SEGMENT_LABELS.get(i.partner_status, i.partner_status),
                   "branch_coverage": COVERAGE_LABELS.get(i.branch_coverage, i.branch_coverage),
                   "branches_total": i.branches, "branches_by_status": i.branch_mix,
                   "gateways": [{"name": g, "status": an.gateway_kind(g)} for g in i.gateways],
                   "share_of_online_on_partner_gateways_pct": round(100 * partner_fraction(an, i), 0),
                   "peak_paying_students_in_a_month": i.students},
        "collections_by_mode_and_month_lakh": {m.name: dict(zip(months, [round(v / LAKH, 1) for v in m.values])) for m in modes},
        "transactions_by_mode": {m.name: sum(m.txns) for m in modes},
        "total_collected_cr": _cr(total),
        "online_mcb_pg_share_pct": round(100 * sum(sum(m.values) for m in modes if m.key == "pg") / total, 1) if total else 0,
        "benchmark_online_share_of_partner_institutes_pct": round(100 * peer_share, 1),
        "branches": [{"name": b.name, "gateways": b.gateways, "status": b.status} for b in branches[:60]],
    }
