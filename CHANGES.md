# Changes

What changed on the live site (fri.myclassboard.com), newest first, one section per day.
Every backup in `staging\backup\<timestamp>\` holds a `CHANGES.md` with that day's section below and the exact
files that changed in that snapshot. Add the day's notes here when a change goes live; `backup-live.ps1` copies them.

## 2026-11-02

- **WhatsApp fee reminders now go to the parents** (live only): `MCB_WHATSAPP_SEND_TO_PARENTS=true` in live's
  `backend\.env` (only that line changed). Send in the Campaigns fee-due pop-up messages the father's number, else the
  mother's, with no test limit; the WhatsApp report marks them Live. "Send test to me" still goes to the test number.
  Staging stays in test mode. App notifications stay in test mode (`MCB_PUSH_SEND_TO_PARENTS=false`).
- **WhatsApp report, message list of a school**: the Message id column is removed, and a **Buttons tapped** filter
  (All messages / Any button tapped / Download App / Check EMI & Loan / No button tapped) with a count of the messages
  shown. Frontend only (`index.html`, `js/views/wareport.js`). Counting Pay Now taps was tried in staging and dropped.
- Snapshots: 20261030-184241 (before, unchanged since) · 20261102-115804 (after parents on) ·
  20261102-122313 (after report filter)

## 2026-10-30

- **36 more schools listed in the portal** (Institutes, Campaigns, Institute 360) although they have no fee collections
  yet: they show with ₹0 collected, their payment-gateway mapping (7 on an MCB partner gateway — grayQuest / NTTData —
  29 marked N/A) and branch PG / No PG split. Names come from `dbo.MCBOrganisations` (active rows only). The list is the
  new setting `MCB_EXTRA_INSTITUTES` in `backend\.env` (`DBName:OrganisationID`, comma separated; added to live's `.env`).
  Totals, commission and alerts are unchanged (the extras add ₹0); the reconciliation check counts collecting schools only.
  To use them in Campaigns, grant reminder consent in Setup → Consent register.
- **Campaigns: "Send test to me" opens a pop-up**: pick an approved WhatsApp template, see it filled with sample values
  (₹4,400 · Aarav Sharma · due in 7 days, Pay Now button), enter a 10-digit mobile number (+91) and send. Only that
  number gets the message; at most 20 tests per signed-in user per hour. New API `POST /api/whatsapp/test-send`.
- **Campaigns step 3 schedules app notifications only**: it works only while App push is on (otherwise the reminder days
  are disabled and Schedule campaign is off), with a note "You have scheduled notifications to parents through the MCB
  parent app" once scheduled. A scheduled campaign is saved with the App channel only; WhatsApp stays a manual send from
  the fee-due pop-up. The summary box reads "App notifications, at most".

- **Fee-due data preloaded for every institution.** At start-up, and every 2 hours, the server reads a compact summary of
  each institution's unpaid instalments for the financial year (student, due day, partly paid) from the fee search
  indexes — 1,568 institutions, 2 at a time; a sweep takes about an hour. Campaigns' **Fee due** counts (and their
  month / "Which parents" changes) come from it in about a second; a school not read yet is read on first use as before.
  The fee-due pop-up no longer looks up parents' names and phones (the pop-up does not show them); they are read only
  for the students a WhatsApp is sent to — CHIREC's list now loads in ~13 s instead of ~27 s. At most 40 full school
  lists are kept in memory. New settings `MCB_FEE_PRELOAD` (on), `MCB_FEE_PRELOAD_HOURS` (2), `MCB_FEE_PRELOAD_WORKERS` (2);
  new API `GET /api/campaigns/preload-status`. Staging's preload is off (`MCB_FEE_PRELOAD=false` in staging's `.env`) so
  the search service is read once.
- **WhatsApp webhook and delivery log.** New public `POST /api/wa-hook/<secret>` (secret in `MCB_WHATSAPP_WEBHOOK_SECRET`
  in the live `.env`; any other path answers 404) for AiSensy to report delivery statuses (sent / delivered / read /
  failed) and parents' replies and button taps. Every event is stored in the new table `portal.wa_events` (with the
  event as received); signed-in users can read them with `GET /api/whatsapp/events?message_id=…`. Every fee reminder
  and test sent from the portal is recorded in `portal.wa_sent` (message id, number, school, template).
- **"Download App" reply.** When a parent taps the Download App quick reply of a fee reminder, the portal answers in
  the chat with the school's app store links from `[MCB-Web].dbo.MobileAppSchools`; a null, blank or 0 link falls back
  to the common MCB parent app. Repeated deliveries of the same tap are answered once (`portal.wa_handled`).
- **Templates page lists 3 more templates**: fri_fee_reminder_overdue, fri_fee_reminder_dd, fri_fee_reminder_d15 (Pay
  Now now opens the student's pay link; Check EMI & Loan and Download App are quick replies). They can be picked by
  hand in the send step and the test pop-up; the due-date rules are unchanged.
- **AiSensy token shared through Postgres** (`portal.api_tokens`, app `aisensy`): all workers use one token and ask for
  a new one only when it is missing, expired or refused.
- **"Check EMI & Loan" reply.** When a parent taps Check EMI & Loan on a fee reminder, the portal answers in the chat
  for that reminder's student and school: if any branch of the school uses the grayQuest gateway, "EMI and fee loan
  options are available at <school>…", else "…not available at <school> at the moment. We have noted your interest…";
  both end with the student's pay link `https://fee.s.gy/<code>`. `portal.wa_sent` now also keeps the student's name and
  pay code of each reminder (`student_name`, `pay_code`); a tap on a reminder sent before this is not answered. Texts and
  gateway in settings `whatsapp_emi_reply_yes`, `whatsapp_emi_reply_no`, `whatsapp_emi_gateway`.
- **WhatsApp report** (new page under Grow, below Campaigns). Every WhatsApp message sent from the portal — campaigns
  and "Send test to me" (one row of its own) — per institution for today / 7 / 30 / 90 days / 12 months: sent,
  delivered, read, failed, Download App and Check EMI & Loan taps, students, first and last sent, each marked Test
  (test mode or Send test to me) or Live. Click a row for its messages: time, Test/Live, student, number, template and
  pay link, status with sent / delivered / read times or the error, buttons tapped with times, message id. Messages of
  other systems on the same AiSensy account are not counted. `portal.wa_sent` has a new `test` column (every earlier
  send marked test). New APIs `GET /api/whatsapp/report`, `GET /api/whatsapp/report/messages`.
- **Webhook URL opened in a browser** (`GET /api/wa-hook/<secret>`) shows what AiSensy has sent, newest first, as JSON
  with `received_at` / `happened_at` and the event as received; `?date=yyyy-mm-dd`, `?message_id=`, `?limit=` (100,
  at most 1000). It includes the other system's events on the same AiSensy account; a wrong secret answers 404.
- **Due month-wise organisations** (new page under Grow, below Campaigns): pick a month and year to list the schools with
  fees due in that month (#, school, database, organisation ID, due month; search; the name opens Institute 360 when the
  portal has the school). From MCBMaster's `dbo.USP_GET_OrganisationDueMonths @MonthNo, @YearNo` (read-only; demo
  organisations are left out by the procedure), cached 10 minutes per month. New API `GET /api/campaigns/due-months`.
- **"Send test to me" uses a fixed test student**: Kavali Vidharth Sai E (26ARN0002, MKTGDEMO), ₹4,400 due in 7 days,
  and Pay Now opens that student's real pay link `https://fee.s.gy/6ilSntvGd` (it was the placeholder `/test`). The
  pop-up's preview and text show these values. Settings `whatsapp_test_student`, `whatsapp_test_student_code`,
  `whatsapp_test_pay_code`, `whatsapp_test_amount`. (MCBStudentEnrollment holds `xtl1bcDSn` for this student, which
  fee.s.gy answers 404 to; `6ilSntvGd` is the working link.)

Snapshots: 20261029-191704 (before) · 20261030-114932 (after) · 20261030-114932 (before preload) · 20261030-115826 (after preload) · 20261030-165340 (before webhook) · 20261030-165549 (after webhook) · 20261030-165549 (before EMI reply) · 20261030-171543 (after EMI reply) · 20261030-171543 (before WhatsApp report) · 20261030-174128 (after WhatsApp report) · 20261030-174128 (before Due month-wise) · 20261030-183712 (after Due month-wise) · 20261030-183712 (before test student) · 20261030-184241 (after test student)

## 2026-10-29

- **Campaigns: click the fee-due number of a ticked school** to open a pop-up of that school's students with unpaid
  fees: school name and branch, student name (class, section, admission code), father's and mother's names and phones,
  due amount (instalment − concession − paid, all unpaid instalments) and earliest unpaid due date (overdue in red,
  instalment count below). Earliest due date first; filters **Branch** and **Due month** (choosing a month recalculates
  amount, date and count from that month's instalments only).
  Read from Azure AI Search, one index pair per school database, so it works for every institution (83 databases):
  `index-<dbname>-feedetails` on mcbsearch.search.windows.net (fees) and `index-<dbname>-rptstudentsfulldata` on
  mcbstudentreports.search.windows.net (parents, matched by StudentEnrollmentID). Due dates are read in India time.
  Each school's list is reused for 10 minutes; the first open of a large school takes up to ~40 s (CHIREC).
  New API `GET /api/campaigns/due-students/{id}`; new Python package `azure-search-documents` (installed in live's venv);
  new settings `MCB_FEE_SEARCH_KEY` / `MCB_STUDENT_SEARCH_KEY` in `backend\.env` (names added, keys to be filled in).
- **Campaigns: fee-due app notification (API only, test mode).** New `POST /api/campaigns/push-send` sends a mobile-app
  notification through the MyClassBoard notification API (`notificationapi.myclassboard.com`) to the students ticked in the
  fee-due pop-up: title "Fee due <date>", message "₹<amount> for <student>. Tap to pay securely — UPI, card or EMI.".
  A student is reached only if its parent or student login (`dbo.Users`, `PersonalID` = StudentEnrollmentID, `Status` = 1)
  has an active, logged-in device in `MobileAppStudentDeviceAblySubscription`; the school's `FCMPrivateKey_Json` comes from
  `MobileAppGCMSenderDetails`. A student's devices go in one call, tokens comma separated. Test mode: nothing goes to
  parents; every push goes to `MCB_PUSH_TEST_TOKEN`, at most 3 students per send, until `MCB_PUSH_SEND_TO_PARENTS=true`.
  No button in the pop-up yet. New file `backendpp\mobile_app.py`; the due list now carries each student's id;
  settings `MCB_PUSH_*` added to `backend\.env` (test mode on, test token set).
- **Campaigns: WhatsApp fee reminders through AiSensy (test mode) and a Templates page.** In the fee-due pop-up, tick
  students and **Send message**: the reminder goes out as an approved WhatsApp template picked by days to the due date
  (or one chosen in the pop-up), with the amount, student, due date and a **Pay Now** button (`https://fee.s.gy/<code>`).
  The pop-up also has **Fee due month** filters, a total-students column and an app-notification option; the
  **Message & pay link** step is gone (templates replace it) and SMS is off by default. New sidebar page **Templates** lists
  the AiSensy templates with approval status. New APIs `POST /api/campaigns/whatsapp-send`, `GET /api/whatsapp/templates`,
  `GET /api/whatsapp/status`, `GET /api/campaigns/student-totals`; new `backendpp\whatsapp.py`.
  **Test mode:** nothing goes to parents; every WhatsApp goes to `MCB_WHATSAPP_TEST_NUMBER`, at most 3 per send, until
  `MCB_WHATSAPP_SEND_TO_PARENTS=true`. AiSensy login settings `MCB_AISENSY_*` added to live's `backend\.env`.

Snapshots: 20261028-130404 (before) · 20261029-125201 (after) · 20261029-191353 (before app notification) · 20261029-191504 (after app notification) · 20261029-191504 (before WhatsApp) · 20261029-191704 (after WhatsApp)

## 2026-10-28

- **Add to pipeline → Assign owner.** Every "Add to pipeline" button (school page, its suggestions, Institutes bulk)
  opens a pop-up with one choice, the owner, and adds the deal only after it is picked. Owners are the active Fintech
  users in `dbo.Users` (`Status = 1`, `UserTypeID = 22`), excluding UserID 491 (Avanse); settings
  `pipeline_owner_user_types` (22) and `pipeline_owner_exclude_ids` (491). New API `GET /api/pipeline/owners`.
- **Activity log for each institution** (school pop-up, "Activity", newest first), shown only for institutions in the
  pipeline. Recorded automatically with the signed-in user's email: notes / calls, added to pipeline (play, owner),
  every stage move (from → to), account owner, reminder consent, saved campaigns. Only the institution's assigned
  pipeline owner (matched to their `dbo.Users` login email) can type an entry with "Add activity"; others see it read-only.
  New table `portal.activity` (portal PostgreSQL only) with **`institute_name` mandatory (NOT NULL)**; existing notes,
  deals, owners, consent and campaigns were imported once with their original dates (who did them is not known).
  New API `GET/POST /api/institutes/{id}/activity`.
- **Sign-in on live is Google only.** Local testing tools (sign-in without Google and "Test as" on localhost) live in
  `staging\backend\app\localtest.py`, which is never copied to live; `run-staging.ps1` starts staging through it.

Snapshots: 20261026-175237 (before) · 20261028-125840 (after)

- **Upsell pipeline: "Remove from pipeline"** in each card's ⋯ menu, after a confirmation. The removal is written to the
  school's activity ("Removed from pipeline: <play> (was <stage>, owner <name>)" with who did it). New API
  `DELETE /api/pipeline/{id}`.
- **School page header: Owner** shows the assigned pipeline owner's name (or the account owner from "Assign"), and
  **NA** when nobody is assigned; it updates straight after "Add to pipeline".

Snapshots: 20261028-125840 (before) · 20261028-130404 (after)

## 2026-10-26

- **School page, "How this school's fees were paid: by payment type"**: a small line under two payment types says what
  each one includes (the full sentence shows on hover), in the bar chart and in the month-by-month cards.
  - Online payment (MCB gateway): "UPI, cards, net banking & wallets via MCB gateway".
  - Internet Payment: "NEFT / RTGS / IMPS bank transfer, outside MCB".
  The database records only the payment mode, not the method inside it, so these are descriptions, not amounts.

Snapshots: 20261015-175457 (before) · 20261026-161753 (after)

- **Campaigns, step 3 "Message & pay link"**: removed the pay-link settings from the screen (Amount on the link,
  Link expires, Short-link domain, the UPI / Cards / Net banking / EMI options and the "Every link is unique…" line).
  Saved campaigns now always use the former defaults: full outstanding amount, expiry due date + 3 days, all four
  payment options. The message preview shows the pay link as `pay.example.in/k7Qp2`.

Snapshots: 20261026-161753 (before) · 20261026-172400 (after)

- **Campaigns, step 1 "Audience": students with fees due in the next 20 days.** New column "Fee due, 20 days" for each
  selected school, and a total under the list ("N students with fees due 26 Oct – 15 Nov at X selected institutes").
  Counted in each school's own database (its DBName and OrganisationID) from `dbo.Allstudentsfeeduedetails`:
  `Active = 1`, due date from today to today + 20 days, distinct `StudentEnrollmentID`. Counts are reused for 10 minutes.
  New API: `GET /api/campaigns/due-students?ids=DB:Org,…`. The 5 Ryan databases are on another SQL server and show "n/a".
  Checked on live: Ravindra Bharathi Schools (schoollatest : 32) = 12,610 students due 26 Oct – 15 Nov.

Snapshots: 20261026-172400 (before) · 20261026-173938 (after)

- **Campaigns audience list: "Total students" column.** The "Students" column (most students who paid in one month) is
  now "Total students": active students across all the organisation's branches (`ActiveStudents` from
  `USP_GET_BranchAnalysis_MCBMaster`). Like "Fee due, 20 days", it is shown only once the institute's box is ticked.
  Fee-due column widened slightly. (Showing both figures on the organisations table was tried in staging and dropped on request.)

Snapshots: 20261026-173938 (before) · 20261026-175237 (after)

## 2026-10-15

- **Export preview before download**: "Export view" (Institutes) and "Export" (organisations by payment method) now open a
  preview pop-up (row and column counts, file name, first 50 rows). The CSV downloads only after "Download CSV".
- **Payment methods in "Export view"**: one column per payment method for the selected months (online via MCB gateway,
  bank transfer / direct UPI, cash, card swipe, cheque & DD, auto-debit, education loan, other) plus total collected.
- **School-wise student count**: new "Active students (all branches)" figure per school, summed from `ActiveStudents` in
  `USP_GET_BranchAnalysis_MCBMaster`. Shown in the organisations export (removed again from "Export view", see below).
- **"Export view" columns removed** (on request): Account manager, Implementation manager, Implementation executive,
  Sales person, RM, CSM, Customer type; then DB name and Organisation ID; then Location and Active students.
- **Git**: the site folder (live app, staging, web.config, backup scripts) is now a git repository pushed to
  github.com/rchoudarya/Fri-myclassboard-. Secrets (`.env`), logs and backup snapshots are excluded.
- **Backups**: `backup-live.ps1` now writes `CHANGES.md` and `files.sha256` into every snapshot, and no longer counts the
  `.git` folder or this file as part of live.

Snapshots: 20261015-150312 · 20261015-151036 · 20261015-151257 · 20261015-151647 · 20261015-175457

## 2026-10-13

- **"Which gateway the school uses" filter**: options replaced with Partner PG, Non partner PG, No PG and Mostly cash
  usage. "No PG" covers schools with a gateway set up but not in use, marked NA, with no mapping, or unreadable.
  The commission lever "Sign up schools that don't use any MCB gateway" now opens the list with Gateway name = "No MCB gateway".
- **Institutes screen**: removed the "More filters for this list" card (Number of branches, Account owner, Reminder consent, Find).
- **Top bar**: removed the "Search institute or DB name" box. Emptying the school picker and pressing Enter now clears a
  several-matches search.
- **School filter**: picking a school fills "Which gateway the school uses" with that school's own value; clearing the
  school undoes it.

Snapshots: 20261013-184516 · 20261013-185936 · 20261013-191356 · 20261013-191736

## 2026-10-12

_Reconstructed from the backups; no notes were written that day. Each snapshot's `CHANGES.md` lists its exact files._

- Many releases across the backend (`analytics.py`, `main.py`, `schemas.py`, `commission.py`, `insights.py`, `ai_context.py`,
  `config.py`) and the frontend (Command Center, Coverage, Institutes, Institute 360, school pop-ups, growth and pipeline
  views, charts, styles).
- Configuration changes to `backend\.env` / `.env.example` at 11:33, 16:17, 16:45, 17:00 and 18:34.

Snapshots: 20261012-112342 to 20261012-183456 (17 snapshots)

## 2026-10-09

_Reconstructed from the backups; no notes were written that day._

- First backup of the live site (48 files), taken when the backup script was set up.
- Changes to the backend (`analytics.py`, `config.py`, `auth.py`, `main.py`) and the frontend (filters, segments,
  Command Center, Coverage, organisations table, school pop-up, growth view, styles, README).

Snapshots: 20261009-180954 to 20261009-190843 (6 snapshots)
