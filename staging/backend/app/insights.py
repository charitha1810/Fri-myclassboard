"""Rules that turn raw aggregates into notes, signals and alerts.

Shared by every data source, so the narrative on screen always follows the numbers.
"""
from __future__ import annotations

from .schemas import Alert, Freshness, Gateway, GatewaySummary, Institute, Signal

FULL_MONTH = {
    "Jan": "January", "Feb": "February", "Mar": "March", "Apr": "April", "May": "May", "Jun": "June",
    "Jul": "July", "Aug": "August", "Sep": "September", "Oct": "October", "Nov": "November", "Dec": "December",
}


def _nf(v: float, d: int = 0) -> str:
    """Indian digit grouping: 12,34,567.89"""
    neg = v < 0
    s = f"{abs(v):.{d}f}"
    whole, _, frac = s.partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    return ("-" if neg else "") + whole + ("." + frac if frac else "")


def cr(v: float, d: int = 1) -> str:
    """A crore figure written as the full rupee amount, to the paisa (no Cr / L rounding)."""
    return rs(v * 1e7)


def rs(r: float) -> str:
    return f"₹{_nf(r, 2)}"


def _duplicates(gws: list[Gateway]) -> list[tuple[Gateway, Gateway]]:
    seen: dict[tuple, Gateway] = {}
    pairs = []
    for g in gws:
        key = (round(g.volume, 2), g.txns)
        if g.txns and key in seen:
            pairs.append((seen[key], g))
        else:
            seen[key] = g
    return pairs


def _prev(g: Gateway) -> float | None:
    if g.mom_pct is None or g.mom_pct <= -100:
        return None
    return g.last_month / (1 + g.mom_pct / 100)


def annotate_gateways(gws: list[Gateway], summary: GatewaySummary, check_duplicates: bool = True) -> list[Gateway]:
    """Fill the leaderboard's note column where the data itself does not carry one."""
    last = summary.months[-1] if summary.months else ""
    network_ticket = summary.fytd * 1e7 / summary.fytd_txns if summary.fytd_txns else 0
    dup_of = {b.name: a.name for a, b in _duplicates(gws)} if check_duplicates else {}
    out = []
    for g in gws:
        note = g.note
        if g.name in PSEUDO_GATEWAYS:
            pass
        elif g.name in dup_of:
            note = f"Identical to {dup_of[g.name]}"
        elif not note:
            if not g.last_month:
                note = f"No {FULL_MONTH.get(last, last)} volume"
            elif g.mom_pct is not None and g.mom_pct <= -20 and g.volume >= 0.01 * summary.fytd:
                note = "Falling — churn risk"
            elif g.mom_pct is not None and g.mom_pct >= 100 and g.last_month >= 10:
                note = "Spike — find the driver"
            elif "emi" in g.name.lower() and network_ticket and g.avg_ticket >= 1.8 * network_ticket:
                note = "High ticket — EMI demand"
        out.append(g.model_copy(update={"note": note}))
    return out


PSEUDO_GATEWAYS = {"Mapping not readable", "No gateway mapping", "No MCB gateway"}


def gateway_signals(gws: list[Gateway], summary: GatewaySummary, check_duplicates: bool = True) -> list[Signal]:
    sig: list[Signal] = []
    last = FULL_MONTH.get(summary.months[-1], summary.months[-1]) if summary.months else "the last month"
    unread = next((g for g in gws if g.name == "Mapping not readable"), None)
    gws = [g for g in gws if g.name not in PSEUDO_GATEWAYS]
    if unread and summary.fytd:
        sig.append(Signal(kind="data", text=f"{cr(unread.volume)} of gateway collections ({unread.volume / summary.fytd * 100:.1f}%) from "
                                            f"{unread.institutes} institutes cannot be tied to a gateway: their tenant DB's gateway view is not readable by this login."))
    if check_duplicates:
        for a, b in _duplicates(gws):
            sig.append(Signal(kind="data", text=f"{a.name} and {b.name} report identical totals ({cr(a.volume)}, {_nf(a.txns)} transactions). "
                                                f"Confirm whether the {cr(summary.fytd)} total counts {cr(b.volume)} twice."))
    net_growth = None
    if len(summary.monthly) >= 2 and summary.monthly[-2]:
        net_growth = (summary.monthly[-1] / summary.monthly[-2] - 1) * 100
    fallers = [g for g in gws if g.mom_pct is not None and g.mom_pct <= -20 and g.volume >= 0.02 * summary.fytd]
    if fallers:
        g = min(fallers, key=lambda x: x.mom_pct)
        p = _prev(g)
        ctx = " while the network grew" if net_growth and net_growth > 0 else ""
        sig.append(Signal(kind="churn", text=f"{g.name} fell {abs(g.mom_pct):.0f}% in {last} ({cr(p)} → {cr(g.last_month)}){ctx}. Check which institutes moved."))
    dup_names = {b.name for _, b in _duplicates(gws)} if check_duplicates else set()
    growers = sorted(
        [(g, g.last_month - (_prev(g) or 0)) for g in gws if g.mom_pct and g.mom_pct > 0 and g.name not in dup_names],
        key=lambda t: t[1], reverse=True)[:2]
    if growers:
        parts = [f"{g.name} {'tripled' if g.mom_pct >= 200 else 'doubled' if g.mom_pct >= 100 else 'grew ' + f'{g.mom_pct:.0f}%'} "
                 f"({cr(_prev(g))} → {cr(g.last_month)})" for g, _ in growers]
        sig.append(Signal(kind="growth", text=f"{'; '.join(parts)} in {last}. Find the institutes behind it and repeat the playbook."))
    ticket = summary.fytd * 1e7 / summary.fytd_txns if summary.fytd_txns else 0
    for g in gws:
        if "emi" in g.name.lower() and ticket and g.avg_ticket > ticket:
            sig.append(Signal(kind="emi", text=f"{g.name} averages {rs(g.avg_ticket)} a payment — {g.avg_ticket / ticket:.1f}× the network ticket. Offer it wherever fees are high."))
            break
    return sig


def alerts(gws: list[Gateway], institutes: list[Institute], inst_months: list[str], freshness: Freshness,
           check_duplicates: bool = True, top: int = 2) -> list[Alert]:
    """Named alerts for the biggest cases; the long tail is summarised in one line per rule."""
    out: list[Alert] = []
    if check_duplicates:
        for a, b in _duplicates(gws):
            out.append(Alert(severity="danger", title="Possible double count.",
                             text=f"{a.name} and {b.name} report identical totals — {cr(a.volume)} and {_nf(a.txns)} transactions."))
    if len(inst_months) >= 3:
        last2 = " or ".join(FULL_MONTH.get(m, m) for m in inst_months[-2:])
        last = FULL_MONTH.get(inst_months[-1], inst_months[-1])
        dormant = []
        for i in institutes:
            tail = sum(pg + off for pg, off in i.months[-2:])
            earlier = sum(pg + off for pg, off in i.months[:-2])
            if tail == 0 and earlier > 0:
                dormant.append((earlier, i))
        dormant.sort(key=lambda t: t[0], reverse=True)
        for earlier, i in dormant[:top]:
            br = f"({i.branches} branches) " if i.branches > 1 else ""
            out.append(Alert(severity="info", title=i.name, institute_id=i.id,
                             text=f"{br}recorded no collections in {last2} after {rs(earlier)} earlier in the window."))
        if len(dormant) > top:
            out.append(Alert(severity="info", title=f"{len(dormant) - top} more institutes",
                             text=f"also show no collections in {last2}. Open Institutes → “No recent fees” to review them."))
        fresh = []
        for i in institutes:
            pg_last, off_last = i.months[-1]
            pg_before = sum(pg for pg, _ in i.months[:-1])
            if pg_last > 2 and pg_before <= 2 * (len(i.months) - 1) and off_last > pg_last:
                fresh.append((off_last, pg_last, i))
        fresh.sort(key=lambda t: t[0], reverse=True)
        for off_last, pg_last, i in fresh[:top]:
            out.append(Alert(severity="warning", title=i.name, institute_id=i.id,
                             text=f"went live on the gateway in {last} ({rs(pg_last)}) but still collected {rs(off_last)} offline."))
        if len(fresh) > top:
            out.append(Alert(severity="warning", title=f"{len(fresh) - top} more institutes",
                             text=f"started gateway collections in {last} while most fees still came in offline — prime pay-link candidates."))
    stamps = {"payment modes": freshness.modes, "gateways": freshness.gateway, "org-wise": freshness.org_wise}
    if len({v.split(",")[0] for v in stamps.values()}) > 1:
        out.append(Alert(severity="info", title="Refresh times differ",
                         text="— " + ", ".join(f"{k} {v.split(',')[0]}" for k, v in stamps.items()) + ". Align them before month-end reviews."))
    return out
