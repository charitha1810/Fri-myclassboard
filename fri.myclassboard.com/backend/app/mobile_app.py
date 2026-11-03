"""Mobile-app push notifications through MyClassBoard's notification API.

  POST {push_api_url}   {"registrationTokens": <one FCM device token>, "customData": {"type": ...}, "title", "message",
                         "ImagePath": "", "FCMPrivateKey_Json": <the school's MobileAppGCMSenderDetails.FCMPrivateKey_Json>}

A student is reachable when its parent (UserTypeID 6) or student (5) login (dbo.Users, PersonalID = StudentEnrollmentID, Status = 1) has an
active, logged-in device subscription (dbo.MobileAppStudentDeviceAblySubscription) with a device token. Both tables, and
MobileAppGCMSenderDetails, are in the school's own database, read through the same server connection.
"""
from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.request

from .config import get_settings

log = logging.getLogger("mcb.mobile_app")

PARENT_USER_TYPE = 6


class PushUnavailable(Exception):
    """The notification API refused or failed the request, or the school has no push setup."""


def _db(db: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_]+", db):
        raise PushUnavailable(f"Bad database name {db}")
    return f"[{db}]"


def fcm_key(an, db: str, org: int) -> str:
    """The school's FCMPrivateKey_Json (MobileAppGCMSenderDetails), organisation-wide row first."""
    rows = an._all(f"""SELECT TOP 1 FCMPrivateKey_Json k FROM {_db(db)}.dbo.MobileAppGCMSenderDetails WITH (NOLOCK)
                       WHERE OrganisationID = :org AND ISNULL(FCMPrivateKey_Json, '') <> ''
                       ORDER BY CASE WHEN BranchID IS NULL THEN 0 ELSE 1 END, MobileAppGCMSenderDetailID DESC""", org=org)
    return (rows[0]["k"] or "").strip() if rows else ""


def device_tokens(an, db: str, org: int, student_ids: list[int]) -> dict[int, list[str]]:
    """StudentEnrollmentID -> the app's device tokens, parent logins first then newest (at most push_devices_per_student each).
    Students without an active parent login, or without a logged-in device, are absent."""
    cap = max(get_settings().push_devices_per_student, 1)
    out: dict[int, list[str]] = {}
    ids = [int(i) for i in student_ids]
    for i in range(0, len(ids), 500):
        part = ",".join(str(x) for x in ids[i:i + 500])
        rows = an._all(f"""
            SELECT s.StudentEnrollmentID id, s.device_token tok, u.UserTypeID ut, MAX(s.SubscribedDate) at
            FROM {_db(db)}.dbo.MobileAppStudentDeviceAblySubscription s WITH (NOLOCK)
            JOIN {_db(db)}.dbo.Users u WITH (NOLOCK)
              ON u.UserID = s.UserID AND u.PersonalID = s.StudentEnrollmentID AND u.UserTypeID IN (5, {PARENT_USER_TYPE}) AND u.Status = 1
            WHERE s.OrgaisationID = :org AND s.StudentEnrollmentID IN ({part})
              AND s.IsActive = 1 AND s.IsSubscribed = 1 AND s.LoginStatus = 1 AND ISNULL(s.device_token, '') <> ''
            GROUP BY s.StudentEnrollmentID, s.device_token, u.UserTypeID""", org=org)
        for r in sorted(rows, key=lambda r: (r["ut"] != PARENT_USER_TYPE, -(r["at"].timestamp() if r["at"] else 0))):
            toks = out.setdefault(int(r["id"]), [])
            if len(toks) < cap:
                toks.append(r["tok"].strip())
    return out


def send(tokens: str | list[str], key: str, title: str, message: str) -> dict:
    """Send one notification to one or more device tokens (the API takes them comma separated). Returns the API's answer."""
    s = get_settings()
    body = {"registrationTokens": tokens if isinstance(tokens, str) else ",".join(tokens), "customData": {"type": s.push_type}, "title": title, "message": message,
            "ImagePath": "", "FCMPrivateKey_Json": key}
    req = urllib.request.Request(s.push_api_url, method="POST", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "MCB-RevenueIntelligence/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        log.warning("Push API refused (%s): %s", e.code, detail)
        raise PushUnavailable(f"Notification API refused the request ({e.code}): {detail[:200]}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        log.warning("Push API unreachable: %s", e)
        raise PushUnavailable("Notification API is unreachable") from None
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {"raw": raw[:300]}
