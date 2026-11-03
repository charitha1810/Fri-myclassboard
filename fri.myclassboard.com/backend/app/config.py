"""Runtime configuration, read from environment variables (or backend/.env)."""
from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BACKEND_DIR.parent / "frontend"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_prefix="MCB_", extra="ignore")

    # SQL Server / Azure SQL Managed Instance (read-only analytics source)
    db_server: str = ""
    db_port: int = 1433
    db_user: str = ""
    db_password: SecretStr = SecretStr("")
    db_name: str = "MCBMaster"
    db_driver: str = "ODBC Driver 18 for SQL Server"

    # Tenant databases to leave out of every figure (demo / test), comma separated.
    exclude_dbs: str = "MKTGDEMO"
    # Single organisations to leave out of every figure (MCB's own demo / internal ones), as "DBName:OrganisationID",
    # comma separated. Together with exclude_dbs this reproduces the Admin MIS "Payment Gateway Details" report.
    exclude_orgs: str = ""
    # School-store sales (IsSchoolStore = 1) are not fee collections; off by default.
    include_school_store: bool = False
    # Count the month the snapshot was built in as well (it is still in progress, so it holds only part of a month).
    # Off by default: "latest month" comparisons are only meaningful between complete months.
    include_current_month: bool = False
    # Leave out organisations marked inactive in dbo.MCBOrganisations (Active = 0) everywhere.
    hide_inactive_orgs: bool = True
    # Fee-due preload: a compact summary (student, due day, partly paid) of every institution's unpaid instalments is
    # read from the fee search indexes in the background at start-up and every fee_preload_hours, so Campaigns' Fee due
    # counts answer at once. fee_preload_workers schools are read at a time.
    fee_preload: bool = True
    fee_preload_hours: float = 2.0
    fee_preload_workers: int = 2
    # Institutes listed in the portal even without fee collections ("DBName:OrganisationID", comma separated): they show
    # with Rs 0 collected, so they can be picked in Campaigns and Institutes. Names come from dbo.MCBOrganisations.
    extra_institutes: str = ""
    # How many of the latest complete months the institute scoring window covers.
    institute_months: int = 4
    # Seconds to cache query results; the source tables refresh about once a day.
    cache_ttl: int = 600

    # Portal-only data (owners, notes, pipeline, settings, consent, campaigns) lives in PostgreSQL, never in production.
    # e.g. postgresql+psycopg://mcb_portal:secret@localhost:5432/mcb_portal
    app_db_url: SecretStr = SecretStr("")
    # How often (seconds) to re-check MCBOrganisationPaymentsAnalysis for a new snapshot (GeneratedDate).
    # A page load fires several requests at once; 5 s means every page load verifies against the database once.
    freshness_check: int = 5
    # Seconds before the organisation → gateway mapping (a live view) and the gateway master are re-read.
    gateway_map_ttl: int = 120

    # AI suggestions (Claude API). Key from MCB_ANTHROPIC_API_KEY, else the SDK's own ANTHROPIC_API_KEY / profile.
    anthropic_api_key: SecretStr = SecretStr("")
    # Needed when the key is not scoped to a workspace (Console → Settings → Workspaces, id starts with "wrkspc_").
    anthropic_workspace_id: str = ""
    ai_model: str = "claude-opus-5-5"
    ai_effort: str = "medium"           # low | medium | high — depth of reasoning per suggestion run
    ai_cache_minutes: int = 60          # identical requests on the same data snapshot reuse the last answer

    # Campaigns, fee-due pop-up: Azure AI Search indexes, one per school database ({db} = DBName in lower case);
    # one key per service, a query key is enough.
    # Fee instalments per student:
    fee_search_endpoint: str = "https://mcbsearch.search.windows.net"
    fee_search_index: str = "index-{db}-feedetails"
    fee_search_key: SecretStr = SecretStr("")
    # Father / mother details per StudentEnrollmentID:
    student_search_endpoint: str = "https://mcbstudentreports.search.windows.net"
    student_search_index: str = "index-{db}-rptstudentsfulldata"
    student_search_key: SecretStr = SecretStr("")

    # WhatsApp through AiSensy (https://aisensy.stoplight.io).
    # Direct API: username + password (+ project id) give a JWT bearer token. Used when the username is set.
    aisensy_direct_url: str = "https://backend.aisensy.com/direct-apis/t1"
    aisensy_username: str = ""
    aisensy_password: SecretStr = SecretStr("")
    aisensy_direct_project_id: str = ""
    # Partner API key (used when the Direct API login is not set).
    aisensy_base_url: str = "https://apis.aisensy.com"
    aisensy_partner_id: str = ""
    aisensy_partner_key: SecretStr = SecretStr("")
    # The AiSensy project (WhatsApp business number) messages are sent from.
    aisensy_project_id: str = ""
    # Approved WhatsApp template for the fee reminder, its language, and its body variables in order.
    # Approved fee-reminder templates, picked by days to the student's earliest due date (negative = overdue):
    # "days:name" pairs, the first whose days the reminder is at or before wins.
    aisensy_templates: str = ("-7:fri_fee_overdue_7d_after,-1:fri_fee_overdue_3d_after,0:fri_fee_reminder_due_today,"
                              "1:fri_fee_reminder_1d_before,3:fri_fee_reminder_3d_before,9999:fri_fee_reminder_7d_before")
    # Templates a user may pick in the fee-due pop-up instead of the automatic choice (all take amount, student, date).
    aisensy_template_choices: str = ("fri_fee_overdue_7d_after,fri_fee_overdue_3d_after,fri_fee_reminder_due_today,"
                                     "fri_fee_reminder_1d_before,fri_fee_reminder_3d_before,fri_fee_reminder_7d_before,"
                                     "fee_reminder_1d_before,fee_reminder_3d_before,fee_reminder_7d_before,"
                                     "fri_fee_reminder_overdue,fri_fee_reminder_dd,fri_fee_reminder_d15")
    aisensy_template_language: str = "en"
    aisensy_template_params: str = "amount_due,student_name,due_date"   # the templates' {{1}}, {{2}}, {{3}}
    # "Send test to me" sends the WhatsApp test here (with country code, e.g. 9198xxxxxxxx). Nothing goes to parents.
    whatsapp_test_number: str = ""
    # False (staging): every fee reminder goes to whatsapp_test_number instead of the parent, at most
    # whatsapp_test_limit per send. True: reminders go to the parents' own numbers.
    whatsapp_send_to_parents: bool = False
    whatsapp_test_limit: int = 3
    # "Send test to me" always uses this test student (26ARN0002, MKTGDEMO) and their real pay link
    # https://fee.s.gy/<whatsapp_test_pay_code>, so Pay Now opens a working payment page.
    whatsapp_test_student: str = "Kavali Vidharth Sai E"
    whatsapp_test_student_code: str = "26ARN0002"
    whatsapp_test_pay_code: str = "6ilSntvGd"
    whatsapp_test_amount: str = "4,400"
    # "Download App" reply: the school's own store links from [MCB-Web].dbo.MobileAppSchools; these common MCB parent app
    # links are used when the school's link is null, blank or 0.
    app_default_android: str = "https://play.google.com/store/apps/details?id=com.mcb.myclassboard.activity"
    app_default_ios: str = "https://apps.apple.com/in/app/mcb-parent-app/id1266182786"
    # Sent when a parent taps the "Download App" quick reply of a fee reminder ({institute}, {ios}, {android} are filled).
    whatsapp_app_reply: str = ("*Download App*\n\nDownload the {institute} app to pay fees and get all school notifications.\n"
                               "iPhone (App Store): {ios}\nAndroid (Google Play): {android}")
    whatsapp_app_button: str = "Download App"
    # Sent when a parent taps "Check EMI & Loan": _yes when the school has the grayQuest gateway (EMI / fee loans),
    # else _no. {student}, {institute} and {payment_link} (https://fee.s.gy/<student's code>) are filled.
    whatsapp_emi_button: str = "Check EMI & Loan"
    whatsapp_emi_gateway: str = "grayQuest"
    whatsapp_emi_reply_yes: str = (
        "*Check EMI & Loan*\n\nThank you for showing interest in EMI and fee loan options for {student}’s fee.\n\n"
        "We are pleased to inform you that EMI and fee loan options are available at {institute}. You can explore the "
        "available options and choose a suitable payment plan.\n\nFor more details and to proceed, please use the secure "
        "payment link below:\n\n{payment_link}\n\nThank you!")
    whatsapp_emi_reply_no: str = (
        "*Check EMI & Loan*\n\nThank you for showing interest in EMI and fee loan options for {student}’s fee.\n\n"
        "EMI and fee loan options are not available at {institute} at the moment. We have noted your interest and will "
        "get back to you.\n\nMeanwhile, you can pay the fee online using this secure payment link:\n{payment_link}\n\nThank you.")
    # AiSensy calls https://<site>/api/wa-hook/<this secret> with parents' replies and button taps. Empty: the hook is off.
    whatsapp_webhook_secret: SecretStr = SecretStr("")
    # The templates' "Pay Now" is a URL button, https://fee.s.gy/{{1}}: {{1}} = MCBStudentEnrollment.StdAlphaNumericCode.

    # Mobile-app push notifications (MyClassBoard notification API); device tokens and the school's FCM key come from
    # the school's own database.
    push_api_url: str = "https://notificationapi.myclassboard.com/api/Notification/SendNotifications"
    push_type: str = "Chat"             # customData.type the app opens the notification with
    push_devices_per_student: int = 3   # newest parent devices notified per student
    # "" (staging): every push goes to this one device token instead of the parents' phones, at most push_test_limit per
    # send. Set push_send_to_parents true to notify the parents' own devices.
    push_test_token: str = ""
    push_send_to_parents: bool = False
    push_test_limit: int = 3

    # Production
    log_level: str = "INFO"
    gzip_min_bytes: int = 1000
    # Account owners shown in assign menus: "RC:Ravi Chandra,SM:Sneha M"
    owners: str = ""
    # Who can own a pipeline deal: active dbo.Users of these UserTypeIDs (MCBUserTypes; 22 = Fintech), comma separated
    pipeline_owner_user_types: str = "22"
    # dbo.Users.UserID values never offered as pipeline owners (491 = Avanse, a partner account), comma separated
    pipeline_owner_exclude_ids: str = "491"
    # The account team shown against each organisation (account manager, implementation, sales, RM, CSM, customer
    # type, location), read from dbo.USP_GET_BranchAnalysis_MCBMaster; phone numbers come from dbo.Users.
    # The procedure is slow, so it is re-run only every ttl seconds. False switches it off.
    account_team: bool = True
    account_manager_ttl: int = 3600
    # Shown in the account menu and used for "Send test to me".
    user_email: str = ""

    # Sign-in: Google account, allowed only for active MCBMaster staff (dbo.Users, Status = 1) — same as Admin MIS.
    # The site's origin must be listed under "Authorized JavaScript origins" for this client in Google Cloud Console.
    google_client_id: str = "429290070059-pk04va9e5hjpfc7feg7tsdl8k1dfr3ur.apps.googleusercontent.com"
    # Which dbo.Users.UserTypeID values may sign in (comma separated).
    login_user_type_ids: str = "1"
    # Signs the session cookie. Must be set (and identical across workers), or sessions end on every restart.
    session_secret: SecretStr = SecretStr("")
    session_hours: int = 12
    # Send the session cookie over HTTPS only; set false only for plain-http local development.
    cookie_secure: bool = True

    # Origins allowed to call the API when the frontend is hosted elsewhere (comma separated).
    cors_origins: str = ""

    @property
    def allowed_user_type_ids(self) -> list[int]:
        return [int(t) for t in self.login_user_type_ids.split(",") if t.strip()] or [1]

    @property
    def excluded_dbs(self) -> list[str]:
        return [d.strip() for d in self.exclude_dbs.split(",") if d.strip()]

    @property
    def excluded_orgs(self) -> list[str]:
        return [o.strip() for o in self.exclude_orgs.split(",") if ":" in o]

    def odbc_connection_string(self) -> str:
        def braced(v: str) -> str:  # ODBC-escape values that may contain ; { } or spaces
            return "{" + v.replace("}", "}}") + "}"
        parts = [
            f"DRIVER={braced(self.db_driver)}",
            f"SERVER=tcp:{self.db_server},{self.db_port}",
            f"UID={braced(self.db_user)}",
            f"PWD={braced(self.db_password.get_secret_value())}",
            "Encrypt=yes",
            "TrustServerCertificate=no",
            "Connection Timeout=30",
            "ApplicationIntent=ReadOnly",
        ]
        if self.db_name:
            parts.append(f"DATABASE={braced(self.db_name)}")
        return ";".join(parts) + ";"


@lru_cache
def get_settings() -> Settings:
    return Settings()
