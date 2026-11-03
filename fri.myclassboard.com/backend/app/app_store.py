"""Portal-only data the production database does not hold: owners, notes, pipeline deals,
revenue settings, reminder consent and campaigns.

Stored in PostgreSQL (schema `portal`, created on first start) so the SQL Server analytics
login stays read-only.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import date, datetime, timezone

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url

from .schemas import Activity, CampaignIn, Consent, Deal, DealIn, Note, NoteIn, RevenueSettings, Stage

STAGES = [
    Stage(id="id", name="Identified", prob=0.10), Stage(id="ct", name="Contacted", prob=0.25),
    Stage(id="pr", name="Proposal / demo", prob=0.40), Stage(id="ky", name="Consent & KYC", prob=0.60),
    Stage(id="ob", name="Onboarding", prob=0.80), Stage(id="lv", name="Live", prob=1.0),
]
STAGE_IDS = {s.id for s in STAGES}
log = logging.getLogger("mcb.store")
STAGE_NAME = {s.id: s.name for s in STAGES}
CHANNEL_NAME = {"sms": "SMS", "wa": "WhatsApp", "app": "App"}
CONSENT_NAME = {"y": "granted", "p": "pending", "n": "not asked"}

DDL = [
    "CREATE SCHEMA IF NOT EXISTS portal",
    """CREATE TABLE IF NOT EXISTS portal.settings (
         id smallint PRIMARY KEY CHECK (id = 1),
         take_bps numeric(7,2) NOT NULL, loan_fee_pct numeric(5,2) NOT NULL, conv_pct numeric(5,2) NOT NULL,
         quarter_target_rs numeric(16,2), updated_at timestamptz NOT NULL DEFAULT now())""",
    """CREATE TABLE IF NOT EXISTS portal.institute_owner (
         institute_id text PRIMARY KEY, owner text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())""",
    """CREATE TABLE IF NOT EXISTS portal.consent (
         institute_id text NOT NULL, channel text NOT NULL CHECK (channel IN ('sms','wa','app')),
         state char(1) NOT NULL CHECK (state IN ('y','p','n')), updated_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (institute_id, channel))""",
    """CREATE TABLE IF NOT EXISTS portal.notes (
         id text PRIMARY KEY, institute_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
         text text NOT NULL, follow_up date)""",
    "CREATE INDEX IF NOT EXISTS ix_notes_inst ON portal.notes (institute_id, created_at DESC)",
    """CREATE TABLE IF NOT EXISTS portal.deals (
         id text PRIMARY KEY, institute_id text NOT NULL, stage text NOT NULL, play text NOT NULL,
         next_step text NOT NULL, owner text, loan_only boolean NOT NULL DEFAULT false,
         created_at timestamptz NOT NULL DEFAULT now(), stage_changed_at timestamptz NOT NULL DEFAULT now())""",
    "CREATE INDEX IF NOT EXISTS ix_deals_inst ON portal.deals (institute_id, play)",
    """CREATE TABLE IF NOT EXISTS portal.campaigns (
         id text PRIMARY KEY, name text NOT NULL, status text NOT NULL, payload jsonb NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now())""",
    # What happened against each institute, who did it and when. `source` keys the entries back-filled from the
    # tables above, so the back-fill can run on every start without duplicating them.
    """CREATE TABLE IF NOT EXISTS portal.activity (
         id bigserial PRIMARY KEY, institute_id text NOT NULL, institute_name text NOT NULL,
         at timestamptz NOT NULL DEFAULT now(), actor text, kind text NOT NULL, summary text NOT NULL, source text UNIQUE)""",
    # Tables made before institute_name existed get the column here; require_activity_names() fills it, then makes it NOT NULL.
    "ALTER TABLE portal.activity ADD COLUMN IF NOT EXISTS institute_name text",
    "CREATE INDEX IF NOT EXISTS ix_activity_inst ON portal.activity (institute_id, at DESC)",
    # One row once the back-fill has run: it runs a single time, before anything is logged live.
    """CREATE TABLE IF NOT EXISTS portal.activity_backfill (
         id smallint PRIMARY KEY CHECK (id = 1), done_at timestamptz NOT NULL DEFAULT now())""",
    # WhatsApp fee reminders sent, so a parent's button tap (which names the message) can be traced to the school.
    """CREATE TABLE IF NOT EXISTS portal.wa_sent (
         message_id text PRIMARY KEY, phone text NOT NULL, institute_id text NOT NULL, institute_name text NOT NULL,
         template text NOT NULL, sent_at timestamptz NOT NULL DEFAULT now())""",
    "CREATE INDEX IF NOT EXISTS ix_wa_sent_phone ON portal.wa_sent (phone, sent_at DESC)",
    # The student a reminder was about and their pay link code (https://fee.s.gy/<code>), for the button replies.
    "ALTER TABLE portal.wa_sent ADD COLUMN IF NOT EXISTS student_name text",
    "ALTER TABLE portal.wa_sent ADD COLUMN IF NOT EXISTS pay_code text",
    # test = sent in test mode (to the test number, not the parent) or from "Send test to me". Every send recorded before
    # this column existed was a test.
    "ALTER TABLE portal.wa_sent ADD COLUMN IF NOT EXISTS test boolean",
    "UPDATE portal.wa_sent SET test = true WHERE test IS NULL",
    # Access tokens of outside services, one per app (e.g. 'aisensy'): every worker and manual test uses the same one,
    # because asking the service for a new token cancels the previous one.
    """CREATE TABLE IF NOT EXISTS portal.api_tokens (
         app text PRIMARY KEY, token text NOT NULL, valid_until timestamptz NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now())""",
    # Everything AiSensy's webhook reports: delivery statuses of our messages (sent / delivered / read / failed) and
    # parents' messages and button taps. One row per status or message; `payload` keeps the event as received.
    """CREATE TABLE IF NOT EXISTS portal.wa_events (
         id bigserial PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now(),
         kind text NOT NULL, message_id text, phone text, status text, detail text, context_id text,
         event_at timestamptz, payload jsonb NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS ix_wa_events_msg ON portal.wa_events (message_id)",
    "CREATE INDEX IF NOT EXISTS ix_wa_events_at ON portal.wa_events (received_at DESC)",
    # Incoming WhatsApp messages already answered (AiSensy may deliver the same event more than once).
    """CREATE TABLE IF NOT EXISTS portal.wa_handled (
         message_id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())""",
]


class AppStore:
    def __init__(self, url: str) -> None:
        if not url:
            raise RuntimeError("MCB_APP_DB_URL is not set (e.g. postgresql+psycopg://user:pass@localhost:5432/mcb_portal)")
        self._ensure_database(url)
        # connect_timeout: a stopped or firewalled server fails in seconds instead of hanging a worker thread.
        self.engine: Engine = create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=5,
                                            pool_timeout=5, connect_args={"connect_timeout": 5})
        with self.engine.begin() as c:
            for stmt in DDL:
                c.execute(text(stmt))

    @staticmethod
    def _ensure_database(url: str) -> None:
        """Create the portal database on first start if the server has none by that name."""
        u = make_url(url)
        if not u.database or u.database == "postgres":
            return
        admin = create_engine(u.set(database="postgres"), isolation_level="AUTOCOMMIT", pool_pre_ping=True,
                              connect_args={"connect_timeout": 5})
        try:
            with admin.connect() as c:
                if not c.execute(text("SELECT 1 FROM pg_database WHERE datname = :d"), {"d": u.database}).first():
                    c.execute(text(f'CREATE DATABASE "{u.database}"'))
        finally:
            admin.dispose()

    def _q(self, sql: str, **p) -> list[dict]:
        with self.engine.connect() as c:
            return [dict(r) for r in c.execute(text(sql), p).mappings().all()]

    def _x(self, sql: str, **p) -> int:
        with self.engine.begin() as c:
            return c.execute(text(sql), p).rowcount

    # ---- settings ----
    def get_settings(self) -> RevenueSettings:
        r = self._q("SELECT take_bps, loan_fee_pct, conv_pct, quarter_target_rs FROM portal.settings WHERE id = 1")
        return RevenueSettings(**{k: (float(v) if v is not None else None) for k, v in r[0].items()}) if r else RevenueSettings()

    def save_settings(self, s: RevenueSettings) -> RevenueSettings:
        self._x("""INSERT INTO portal.settings (id, take_bps, loan_fee_pct, conv_pct, quarter_target_rs)
                   VALUES (1, :take_bps, :loan_fee_pct, :conv_pct, :quarter_target_rs)
                   ON CONFLICT (id) DO UPDATE SET take_bps = EXCLUDED.take_bps, loan_fee_pct = EXCLUDED.loan_fee_pct,
                     conv_pct = EXCLUDED.conv_pct, quarter_target_rs = EXCLUDED.quarter_target_rs, updated_at = now()""",
                **s.model_dump())
        return s

    # ---- owners & consent (overlaid on institutes) ----
    def owners_by_institute(self) -> dict[str, str]:
        return {r["institute_id"]: r["owner"] for r in self._q("SELECT institute_id, owner FROM portal.institute_owner")}

    def assign_owner(self, ids: list[str], owner: str) -> int:
        if not ids:
            return 0
        with self.engine.begin() as c:
            if owner:
                c.execute(text("""INSERT INTO portal.institute_owner (institute_id, owner) VALUES (:i, :o)
                                  ON CONFLICT (institute_id) DO UPDATE SET owner = EXCLUDED.owner, updated_at = now()"""),
                          [{"i": i, "o": owner} for i in ids])
            else:
                c.execute(text("DELETE FROM portal.institute_owner WHERE institute_id = ANY(:ids)"), {"ids": ids})
        return len(ids)

    def consent_by_institute(self) -> dict[str, Consent]:
        out: dict[str, dict] = {}
        for r in self._q("SELECT institute_id, channel, state FROM portal.consent"):
            out.setdefault(r["institute_id"], {})[r["channel"]] = r["state"]
        return {k: Consent(**v) for k, v in out.items()}

    def set_consent(self, institute_id: str, channel: str, state: str) -> None:
        self._x("""INSERT INTO portal.consent (institute_id, channel, state) VALUES (:i, :c, :s)
                   ON CONFLICT (institute_id, channel) DO UPDATE SET state = EXCLUDED.state, updated_at = now()""",
                i=institute_id, c=channel, s=state)

    def request_consent(self, institute_id: str) -> None:
        # Only channels never asked become pending; granted / pending stay as they are.
        with self.engine.begin() as c:
            for ch in ("sms", "wa", "app"):
                c.execute(text("""INSERT INTO portal.consent (institute_id, channel, state) VALUES (:i, :c, 'p')
                                  ON CONFLICT (institute_id, channel) DO UPDATE SET state = 'p', updated_at = now()
                                  WHERE portal.consent.state = 'n'"""), {"i": institute_id, "c": ch})

    # ---- notes ----
    def notes(self, institute_id: str) -> list[Note]:
        return [Note(id=r["id"], institute_id=r["institute_id"], created_at=r["created_at"].isoformat(timespec="seconds"),
                     text=r["text"], follow_up=r["follow_up"].isoformat() if r["follow_up"] else None)
                for r in self._q("""SELECT id, institute_id, created_at, text, follow_up FROM portal.notes
                                    WHERE institute_id = :i ORDER BY created_at DESC""", i=institute_id)]

    def add_note(self, institute_id: str, note: NoteIn) -> Note:
        nid = uuid.uuid4().hex[:12]
        follow = date.fromisoformat(note.follow_up) if note.follow_up else None
        # engine.begin(): the INSERT … RETURNING must be committed (a plain connect() would roll it back).
        with self.engine.begin() as c:
            created = c.execute(text("""INSERT INTO portal.notes (id, institute_id, text, follow_up) VALUES (:id, :i, :t, :f)
                                        RETURNING created_at"""), {"id": nid, "i": institute_id, "t": note.text, "f": follow}).scalar_one()
        return Note(id=nid, institute_id=institute_id, created_at=created.isoformat(timespec="seconds"),
                    text=note.text, follow_up=note.follow_up)

    # ---- pipeline ----
    def deals(self) -> list[Deal]:
        now = datetime.now(timezone.utc)
        return [Deal(id=r["id"], stage=r["stage"], institute_id=r["institute_id"], play=r["play"], next=r["next_step"],
                     owner=r["owner"] or "", days=(now - r["stage_changed_at"]).days, loan_only=r["loan_only"])
                for r in self._q("SELECT * FROM portal.deals ORDER BY created_at")]

    def find_open_deal(self, institute_id: str, play: str) -> bool:
        return bool(self._q("SELECT 1 FROM portal.deals WHERE institute_id = :i AND play = :p AND stage <> 'lv'",
                            i=institute_id, p=play))

    def add_deal(self, d: DealIn, owner: str) -> Deal:
        deal = Deal(id="d" + uuid.uuid4().hex[:10], stage="id", institute_id=d.institute_id, play=d.play, next=d.next,
                    owner=owner, days=0, loan_only=d.loan_only)
        self._x("""INSERT INTO portal.deals (id, institute_id, stage, play, next_step, owner, loan_only)
                   VALUES (:id, :i, :s, :p, :n, :o, :l)""",
                id=deal.id, i=deal.institute_id, s=deal.stage, p=deal.play, n=deal.next, o=owner or None, l=deal.loan_only)
        return deal

    def move_deal(self, deal_id: str, stage: str) -> Deal | None:
        if not self._x("UPDATE portal.deals SET stage = :s, stage_changed_at = now() WHERE id = :id", s=stage, id=deal_id):
            return None
        return next(x for x in self.deals() if x.id == deal_id)

    def in_pipeline(self, institute_id: str) -> bool:
        return bool(self._q("SELECT 1 FROM portal.deals WHERE institute_id = :i LIMIT 1", i=institute_id))

    def delete_deal(self, deal_id: str) -> dict | None:
        """Remove a deal; returns what it was (institute, stage, play, owner) or None if there was none."""
        with self.engine.begin() as c:
            r = c.execute(text("""DELETE FROM portal.deals WHERE id = :id
                                  RETURNING institute_id, stage, play, owner"""), {"id": deal_id}).mappings().first()
        return dict(r) if r else None

    def deal_owners(self, institute_id: str) -> list[str]:
        """Owner names on this institute's pipeline deals, newest deal first."""
        return [r["owner"] for r in self._q("""SELECT owner FROM portal.deals WHERE institute_id = :i AND owner IS NOT NULL
                                               AND owner <> '' ORDER BY created_at DESC""", i=institute_id)]

    def deal(self, deal_id: str) -> dict | None:
        r = self._q("SELECT institute_id, stage, play FROM portal.deals WHERE id = :id", id=deal_id)
        return r[0] if r else None

    # ---- outside services' tokens ----
    def get_token(self, app: str) -> tuple[str, float] | None:
        """(token, valid until as epoch seconds) stored for the app, if any."""
        r = self._q("SELECT token, valid_until FROM portal.api_tokens WHERE app = :a", a=app)
        return (r[0]["token"], r[0]["valid_until"].timestamp()) if r else None

    def save_token(self, app: str, token: str, valid_until: float) -> None:
        self._x("""INSERT INTO portal.api_tokens (app, token, valid_until) VALUES (:a, :t, to_timestamp(:u))
                   ON CONFLICT (app) DO UPDATE SET token = EXCLUDED.token, valid_until = EXCLUDED.valid_until, updated_at = now()""",
                a=app, t=token, u=valid_until)

    # ---- WhatsApp ----
    def record_wa_sent(self, rows: list[dict]) -> None:
        """rows: {message_id, phone, institute_id, institute_name, template, student_name?, pay_code?}. Never fails the
        send it describes."""
        rows = [{"student_name": None, "pay_code": None, "test": True, **r} for r in rows if r.get("message_id")]
        if not rows:
            return
        try:
            with self.engine.begin() as c:
                c.execute(text("""INSERT INTO portal.wa_sent (message_id, phone, institute_id, institute_name, template,
                                                                student_name, pay_code, test)
                                  VALUES (:message_id, :phone, :institute_id, :institute_name, :template, :student_name,
                                          :pay_code, :test)
                                  ON CONFLICT (message_id) DO NOTHING"""), rows)
        except Exception:
            log.exception("WhatsApp sends could not be recorded")

    def wa_sent_for(self, message_id: str | None, phone: str) -> dict | None:
        """The reminder a reply is about: by the message it names, else the newest one sent to that number (30 days)."""
        cols = "institute_id, institute_name, student_name, pay_code"
        r = self._q(f"SELECT {cols} FROM portal.wa_sent WHERE message_id = :m", m=message_id) if message_id else []
        if not r:
            r = self._q(f"""SELECT {cols} FROM portal.wa_sent WHERE phone = :p
                           AND sent_at > now() - interval '30 days' ORDER BY sent_at DESC LIMIT 1""", p=phone)
        return r[0] if r else None

    def record_wa_events(self, rows: list[dict]) -> None:
        """rows: {kind, message_id, phone, status, detail, context_id, event_at (epoch or None), payload (dict)}."""
        if not rows:
            return
        try:
            with self.engine.begin() as c:
                c.execute(text("""INSERT INTO portal.wa_events (kind, message_id, phone, status, detail, context_id, event_at, payload)
                                  VALUES (:kind, :message_id, :phone, :status, :detail, :context_id,
                                          to_timestamp(CAST(:event_at AS double precision)), CAST(:payload AS jsonb))"""),
                          [{**r, "payload": json.dumps(r["payload"], default=str)} for r in rows])
        except Exception:
            log.exception("WhatsApp webhook events could not be recorded")

    def wa_feed(self, day: str = "", message_id: str = "", limit: int = 100) -> list[dict]:
        """Webhook events as received, newest first, with their JSON: on one India date (yyyy-mm-dd) and/or for one
        message (its statuses and the replies naming it)."""
        where, p = [], {"n": max(1, min(limit, 1000))}
        if day:
            where.append("(received_at AT TIME ZONE 'Asia/Kolkata')::date = CAST(:d AS date)"); p["d"] = day
        if message_id:
            where.append("(message_id = :m OR context_id = :m)"); p["m"] = message_id
        rows = self._q(f"""SELECT received_at, event_at, kind, status, detail, phone, message_id, context_id, payload
                           FROM portal.wa_events {"WHERE " + " AND ".join(where) if where else ""}
                           ORDER BY received_at DESC, id DESC LIMIT :n""", **p)
        iso = lambda v: v.isoformat(timespec="seconds") if v else None
        return [{"received_at": iso(r["received_at"]), "happened_at": iso(r["event_at"]), "event": r["kind"],
                 "status": r["status"], "detail": r["detail"], "phone": r["phone"], "message_id": r["message_id"],
                 "reply_to": r["context_id"], "json": r["payload"]} for r in rows]

    def wa_events(self, message_id: str = "", limit: int = 100) -> list[dict]:
        rows = self._q(f"""SELECT received_at, kind, message_id, phone, status, detail, context_id, event_at
                           FROM portal.wa_events {"WHERE message_id = :m OR context_id = :m" if message_id else ""}
                           ORDER BY received_at DESC LIMIT :n""", m=message_id, n=max(1, min(limit, 500)))
        for r in rows:
            for k in ("received_at", "event_at"):
                r[k] = r[k].isoformat(timespec="seconds") if r[k] else None
        return rows

    # Our sends only (portal.wa_sent: campaigns and "Send test to me"), with what the webhook reported for each: the
    # delivery statuses with their times and the buttons tapped on it.
    _WA_REPORT = """
        WITH s AS (SELECT * FROM portal.wa_sent WHERE sent_at >= now() - make_interval(days => :days)),
        st AS (SELECT message_id, bool_or(status = 'failed') failed, bool_or(status = 'read') rd,
                      bool_or(status IN ('delivered', 'read')) dl, min(event_at) FILTER (WHERE status = 'sent') sent_ok_at,
                      min(event_at) FILTER (WHERE status = 'delivered') delivered_at,
                      min(event_at) FILTER (WHERE status = 'read') read_at,
                      string_agg(DISTINCT detail, '; ') FILTER (WHERE status = 'failed') error
               FROM portal.wa_events WHERE kind = 'status' AND message_id IN (SELECT message_id FROM s) GROUP BY 1),
        tp AS (SELECT context_id, bool_or(lower(detail) = lower(:app)) app, bool_or(lower(detail) = lower(:emi)) emi,
                      min(event_at) FILTER (WHERE lower(detail) = lower(:app)) app_at,
                      min(event_at) FILTER (WHERE lower(detail) = lower(:emi)) emi_at,
                      string_agg(DISTINCT detail, ', ') other
               FROM portal.wa_events WHERE kind = 'message' AND context_id IN (SELECT message_id FROM s) GROUP BY 1)"""

    def wa_report(self, days: int, app_button: str, emi_button: str) -> list[dict]:
        """Per institution: reminders sent in the last `days` days and how many were delivered, read, failed, and had
        Download App / Check EMI & Loan tapped; `tests` of them were tests. "Send test to me" messages (no institution)
        are one row with institute_id ''."""
        rows = self._q(self._WA_REPORT + """
            SELECT max(s.institute_id) institute_id, max(s.institute_name) institute_name, count(*) sent,
                   count(*) FILTER (WHERE s.test) tests,
                   count(*) FILTER (WHERE st.dl) delivered, count(*) FILTER (WHERE st.rd) read,
                   count(*) FILTER (WHERE st.failed) failed, count(*) FILTER (WHERE tp.app) download_app,
                   count(*) FILTER (WHERE tp.emi) check_emi, count(DISTINCT s.student_name) students,
                   min(s.sent_at) first_sent, max(s.sent_at) last_sent
            FROM s LEFT JOIN st USING (message_id) LEFT JOIN tp ON tp.context_id = s.message_id
            GROUP BY lower(s.institute_id) ORDER BY max(s.sent_at) DESC""", days=days, app=app_button, emi=emi_button)
        for r in rows:
            for k in ("first_sent", "last_sent"):
                r[k] = r[k].isoformat(timespec="seconds")
        return rows

    def wa_report_messages(self, institute_id: str, days: int, app_button: str, emi_button: str) -> list[dict]:
        """The reminders sent to one institution's parents in the last `days` days, newest first, with their status."""
        rows = self._q(self._WA_REPORT + """
            SELECT s.sent_at, s.message_id, s.student_name, s.phone, s.template, s.pay_code, s.test,
                   CASE WHEN st.failed THEN 'failed' WHEN st.rd THEN 'read' WHEN st.dl THEN 'delivered'
                        WHEN st.message_id IS NOT NULL THEN 'sent' ELSE 'accepted' END status,
                   st.error, st.sent_ok_at, st.delivered_at, st.read_at,
                   coalesce(tp.app, false) download_app, tp.app_at, coalesce(tp.emi, false) check_emi, tp.emi_at
            FROM s LEFT JOIN st USING (message_id) LEFT JOIN tp ON tp.context_id = s.message_id
            WHERE lower(s.institute_id) = lower(:iid) ORDER BY s.sent_at DESC LIMIT 1000""",
                       days=days, app=app_button, emi=emi_button, iid=institute_id)
        for r in rows:
            for k in ("sent_at", "sent_ok_at", "delivered_at", "read_at", "app_at", "emi_at"):
                r[k] = r[k].isoformat(timespec="seconds") if r[k] else None
        return rows

    def wa_first_time(self, message_id: str) -> bool:
        """True once per incoming message id (later deliveries of the same event are ignored)."""
        return self._x("INSERT INTO portal.wa_handled (message_id) VALUES (:m) ON CONFLICT DO NOTHING", m=message_id) == 1

    # ---- activity ----
    def log_activity(self, institute_ids: list[str] | str, names: dict[str, str], actor: str, kind: str, summary: str) -> None:
        """Record one action against one or more institutes, each with its name (mandatory: an institute without a
        name is not recorded). Never fails the action it describes."""
        ids = [institute_ids] if isinstance(institute_ids, str) else list(institute_ids)
        rows = [{"i": i, "n": names[i], "a": actor or None, "k": kind, "s": summary[:1000]} for i in ids if (names.get(i) or "").strip()]
        if len(rows) < len(ids):
            log.warning("Activity not recorded for %d institute(s) without a name: %s", len(ids) - len(rows),
                        [i for i in ids if not (names.get(i) or "").strip()][:5])
        if not rows:
            return
        try:
            with self.engine.begin() as c:
                c.execute(text("""INSERT INTO portal.activity (institute_id, institute_name, actor, kind, summary)
                                  VALUES (:i, :n, :a, :k, :s)"""), rows)
        except Exception:
            log.exception("Activity could not be recorded")

    def log_activity_named(self, an, institute_ids: list[str] | str, actor: str, kind: str, summary: str) -> None:
        """log_activity with each institute's name looked up in the school data (`an`: Analytics)."""
        try:
            names = an.institute_names()
        except Exception:
            log.exception("Institute names unavailable; activity not recorded")
            return
        self.log_activity(institute_ids, names, actor, kind, summary)

    def activity(self, institute_id: str, limit: int = 200) -> list[Activity]:
        return [Activity(at=r["at"].isoformat(timespec="seconds"), who=r["actor"] or "", kind=r["kind"], text=r["summary"])
                for r in self._q("""SELECT at, actor, kind, summary FROM portal.activity WHERE institute_id = :i
                                    ORDER BY at DESC, id DESC LIMIT :n""", i=institute_id, n=limit)]

    def backfill_activity(self, names: dict[str, str]) -> None:
        """Entries for what was stored before the activity log existed (notes, deals, owners, consent, campaigns),
        dated when it happened. Who did it was never recorded, so `actor` stays empty. Runs once only (marker row in
        portal.activity_backfill): later actions are logged live, and re-reading these tables would duplicate them."""
        if self._q("SELECT 1 FROM portal.activity_backfill WHERE id = 1"):
            return
        ins = text("""INSERT INTO portal.activity (institute_id, institute_name, at, kind, summary, source)
                       VALUES (:i, :n, :at, :k, :s, :src) ON CONFLICT (source) DO NOTHING""")
        rows: list[dict] = []
        for n in self._q("SELECT id, institute_id, created_at, text, follow_up FROM portal.notes"):
            rows.append({"i": n["institute_id"], "at": n["created_at"], "k": "note", "src": f"note:{n['id']}",
                         "s": f"Note / call logged: {n['text']}" + (f" (follow up {n['follow_up']:%d %b %Y})" if n["follow_up"] else "")})
        for d in self._q("SELECT id, institute_id, stage, play, owner, created_at, stage_changed_at FROM portal.deals"):
            rows.append({"i": d["institute_id"], "at": d["created_at"], "k": "pipeline", "src": f"deal:{d['id']}",
                         "s": f"Added to pipeline: {d['play']}" + (f" · owner {d['owner']}" if d["owner"] else "")})
            if d["stage"] != "id":
                rows.append({"i": d["institute_id"], "at": d["stage_changed_at"], "k": "pipeline", "src": f"dealstage:{d['id']}",
                             "s": f"Pipeline stage now {STAGE_NAME.get(d['stage'], d['stage'])}: {d['play']}"})
        for o in self._q("SELECT institute_id, owner, updated_at FROM portal.institute_owner"):
            rows.append({"i": o["institute_id"], "at": o["updated_at"], "k": "owner", "src": f"owner0:{o['institute_id']}",
                         "s": f"Account owner set to {o['owner']}"})
        for c in self._q("SELECT institute_id, channel, state, updated_at FROM portal.consent"):
            rows.append({"i": c["institute_id"], "at": c["updated_at"], "k": "consent", "src": f"consent0:{c['institute_id']}:{c['channel']}",
                         "s": f"{CHANNEL_NAME.get(c['channel'], c['channel'])} reminder consent {CONSENT_NAME.get(c['state'], c['state'])}"})
        for cp in self._q("SELECT id, name, status, payload, created_at FROM portal.campaigns"):
            p = cp["payload"] if isinstance(cp["payload"], dict) else json.loads(cp["payload"])
            for i in (p.get("institute_ids") or []):
                rows.append({"i": i, "at": cp["created_at"], "k": "campaign", "src": f"camp:{cp['id']}:{i}",
                             "s": f"Included in campaign \"{cp['name']}\" ({cp['status']})"})
        for r in rows:                              # name is mandatory; an institute no longer in the data keeps its id
            r["n"] = names.get(r["i"]) or r["i"]
        with self.engine.begin() as c:
            if rows:
                c.execute(ins, rows)
            c.execute(text("INSERT INTO portal.activity_backfill (id) VALUES (1) ON CONFLICT (id) DO NOTHING"))

    def require_activity_names(self, names: dict[str, str]) -> None:
        """Fill institute_name on rows written before the column existed, then make it NOT NULL."""
        with self.engine.begin() as c:
            missing = [r[0] for r in c.execute(text("SELECT DISTINCT institute_id FROM portal.activity WHERE institute_name IS NULL"))]
            if missing:
                c.execute(text("UPDATE portal.activity SET institute_name = :n WHERE institute_id = :i AND institute_name IS NULL"),
                          [{"i": i, "n": names.get(i) or i} for i in missing])
            c.execute(text("ALTER TABLE portal.activity ALTER COLUMN institute_name SET NOT NULL"))

    # ---- campaigns ----
    def save_campaign(self, c: CampaignIn) -> str:
        cid = "c" + uuid.uuid4().hex[:10]
        self._x("INSERT INTO portal.campaigns (id, name, status, payload) VALUES (:id, :n, :s, CAST(:p AS jsonb))",
                id=cid, n=c.name, s=c.status, p=json.dumps(c.model_dump()))
        return cid
