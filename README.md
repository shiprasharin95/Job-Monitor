# Job Failure Monitor (Cloud ALM + S/4HANA Cloud, SAP BTP)

Monitors SAP S/4HANA Cloud Public Edition application jobs on system **my409865**. It pulls job runs from **SAP Cloud ALM Job & Automation Monitoring**, reads the real **error reason from the S/4HANA job log**, keeps the history in **SAP HANA Cloud**, and offers it three ways:

- **Dashboard** – a Fiori Elements app (same layout as the IDoc Processing Monitor) with KPI tiles, charts, top errors and a filterable list of failed jobs. Each job opens an object page with details, the full job log and an **Analyze with AI** button.
- **E-mail** – one combined e-mail per scheduler with all their failed jobs, error reasons and AI analysis (Microsoft Graph).
- **Joule / A2A** – a read-only agent endpoint that returns a deterministic summary plus a dashboard link.

**Test URL:** https://job-failure-monitor.cfapps.eu20-001.hana.ondemand.com/

---

## 1. Architecture

```
 SAP Cloud ALM (eu10)                                SAP S/4HANA Cloud my409865
  ├─ Analytics API  DP_JOB_MONITORING (hourly counts)  └─ SAP_COM_0326 BC_EXT_APPJOB_MANAGEMENT;v=0002
  └─ Raw Data Outbound Logs  provider jam.run              (job header, steps, job log messages)
            │  destination CLOUD_ALM_API (OAuth2 client credentials)      │  destination S4HC_JournalEntry (USER_COM_0002)
            ▼                                                             ▼
┌──────────────────────── SAP BTP subaccount sap-genai (Cloud Foundry eu20, space GenAI) ─────────────────────────┐
│ JOB_Failure_Dashboard (CAP Node.js, 1 instance)                                                                 │
│  ├─ Sync every 60 s: analytics -> failed runs (jam.run) -> S/4 job log -> upsert                                 │
│  ├─ OData V4 /odata/v4/job-monitor  (XSUAA, scope User; syncNow requires Admin)                                 │
│  ├─ Fiori app  /job-monitor/webapp/index.html                                                                    │
│  ├─ POST /run  scheduled e-mail digest (scope JobRunner, SAP Job Scheduling)                                    │
│  └─ POST /a2a  + /.well-known/agent-card.json  (scope A2AClient)                                                 │
│        │                                     │                                    │                              │
│        ▼                                     ▼                                    ▼                              │
│  SAP HANA Cloud (HDI)              GENERATIVE_AI_HUB (SAP AI Core,     AzureMailService (Microsoft Graph,        │
│  JobRuns · SyncRuns · SyncState    GPT-4.1 deployment d4da60fb50a82e0d) Mail.Send)                              │
│  notification log/claims                                                                                         │
│                                                                                                                  │
│ cloud-alm-job-monitor-router (approuter, XSUAA login) ── forwards user token ──► JOB_Failure_Dashboard           │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**HANA is the only data source for users.** The dashboard, e-mail and A2A agent read HANA. Only the sync calls Cloud ALM. The object page reads the full job log live from S/4HANA for the one run being viewed.

---

## 2. Where each piece of data comes from

| Data | Source | Notes |
|---|---|---|
| Job runs, success/failure counts per hour | Cloud ALM Analytics API, provider `DP_JOB_MONITORING` (`POST /calm-analytics/v1/analytics/providers/data?provider=...`) | `tableType: raw`, hourly resolution, one-day chunks (provider limit 5,000 rows). Filtered to service ID `802b3bea-d94c-4c32-bcd2-e7517a7788fc` (my409865). |
| Which individual runs failed | Cloud ALM Raw Data Outbound Logs, provider **`jam.run`** (`GET /calm-logs/v1/logs`) | Needs `serviceId`, windows of at most 1 hour. A run failed when `status_rating` or `appl_status_rating` is `3`. Its text fields are empty, so it gives no reason on its own. |
| **Error reason** | S/4HANA job log via **SAP_COM_0326** | Cloud ALM `schedule_id` = S/4 `JobName`, Cloud ALM run `id` = S/4 `JobRunCount`. Navigation: `JobHeaderSet → JobStepSet → JobStepLogInfoSet → JobLogMessageSet`. Messages of type E/A/X form the reason (falls back to W, then all). |
| Scheduled by | S/4 job header `JobCreatedByFormattedName` | Name only; no e-mail address is provided by either API. |
| AI analysis | SAP AI Core, GPT-4.1 | Grounded prompt: SAP help.sap.com only, at most two likely causes, documented resolution steps. Stored on the run (`aiAnalysis`). |

**Example from real data:** "Turnkey schedule for the intelligent scenario CDSTDAI_ABP_CDSTRAL" → *Error occurred while reading intelligent scenario / Exception occurred in R_ISLM_SCHEDULE_TURNKEY->R_ISLM_SCHEDULE_TURNKEY at line 110* (matches the Application Jobs app).

---

## 3. Dashboard (Fiori Elements)

Built like the IDoc Processing Monitor: an FPM custom main page (`sap.fe.core.fpm`) plus a standard Object Page, UI5 1.136, `sap_horizon`.

**Main page** (`app/job-monitor/webapp/ext/main/`):
- Header: last sync status, period selector **1h / 24h / 7 days / 30 days** (`?period=` in the URL preselects it; default 7 days), auto-refresh switch (30 s), refresh, **Pull from Cloud ALM** (any dashboard user; immediate incremental sync, same as the IDoc monitor).
- KPI tiles: Total Job Runs, Successful (with success rate), Failed, Warnings, In Process. Clicking a tile filters the list.
- Charts: **Job runs over time** (stacked columns) and **By job** (top 10, failures first; stacked bars). Clicking a bar filters the list.
- **Top errors** table: job, error reason, run count. Clicking a row filters the list.
- Filter bar + **Job Runs** list. Shows failed runs by default. Columns: Job, Processing State, Error Reason (Job Log), Job Type, System, Scheduled By, Failed in Hour (UTC).

**Object page** (click a run), driven by `app/annotations.cds`:
- Header: Processing State, Failed in Hour, Scheduled By.
- **Overview**: Job, Schedule (scheduled by, S/4 job name and run count), Source System.
- **Error Details**: the full error reason.
- **AI Analysis**: the stored AI root-cause analysis and when it ran. Press *Generate AI Analysis* inside this tab to (re)generate it.
- **Job Log**: every message of the S/4 job log (type, message, message class/number), read live.

### OData service `/odata/v4/job-monitor` (`srv/job-monitor-service.cds`)

| Element | Purpose |
|---|---|
| `JobRuns` | List and object page. Bound action `analyzeWithAI()`. Navigation `logMessages`. |
| `JobLogMessages` | Live S/4 job log for one run. |
| `getKpis(period)`, `getTrend(period)`, `getByJob(period)`, `getTopErrors(period)` | Dashboard figures, computed deterministically from HANA. |
| `syncNow()` | Immediate Cloud ALM sync (Pull from Cloud ALM). Any dashboard user. |
| `failedJobs`, `jobErrors`, `summary`, `analyzeJob`, `sendSchedulerDigest`, `testConnection` | Existing API used by the A2A agent, scheduler and tests. |

---

## 4. Sync (`srv/cloud-alm-sync.js`, `srv/calm-client.js`, `srv/s4-job-log.js`)

- Starts when the app starts, then every 60 s (`CLOUD_ALM_SYNC_INTERVAL_SECONDS`, minimum 60). One run at a time.
- Continues from the watermark in `SyncState`, aligned to full hours. The first run backfills `CLOUD_ALM_INITIAL_LOOKBACK_DAYS` (7).
- Each hour × job × outcome becomes one `JobRuns` row (idempotent key), so figures never double count.
- For each failed bucket it reads the failed runs from `jam.run`, then their S/4 job log, and stores the reason, the scheduler name and the S/4 run reference. Results are cached in memory.
- A real job-log reason is never overwritten by the analytics placeholder text, and the AI analysis is never overwritten by the sync.
- Every run is logged in `SyncRuns`.

---

## 5. E-mail digest and scheduling

- `POST /run` (scope `JobRunner`, granted only to the bound SAP Job Scheduling service) groups failed jobs by recipient and sends **one combined e-mail per scheduler**, each job with system, time, error reason and AI analysis.
- Duplicate protection: a HANA claim is created before sending, and a job is not re-notified for `NOTIFICATION_REPEAT_WORKING_DAYS` (5) working days.
- Recipient: neither API provides the scheduler's e-mail, so the digest currently goes to `DEFAULT_SCHEDULER_EMAIL`. Only domains in `ALLOWED_NOTIFICATION_DOMAINS` are allowed.
- Mail is sent through destination `AzureMailService` (`/users/{MAIL_FROM}/sendMail`). A test digest with 3 failed jobs was sent successfully.

See `JOB-SCHEDULING.md` for creating the schedule.

---

## 6. Security

| Item | Setting |
|---|---|
| Login | Approuter + XSUAA (`cloud-alm-job-monitor-xsuaa`); the user token is forwarded to CAP. |
| Scopes | `User` (dashboard incl. Pull from Cloud ALM), `Admin` (reserved), `JobRunner` (scheduler only), `A2AClient` (agent). |
| Role collections | `JobFailureMonitor_Viewer`, `JobFailureMonitor_Admin`. Assign in the BTP cockpit → Security → Role Collections. |
| Cloud ALM / S/4 / AI / Mail | Technical destinations; credentials stay in the BTP destination service. Cloud ALM has no per-user job authorisations, so no principal propagation is used for data reads. |

---

## 7. BTP resources (org BearingPointGmbH_sap-genai, space GenAI, eu20-001)

| Resource | Name |
|---|---|
| CAP backend | `JOB_Failure_Dashboard` (route `job-failure-monitor-srv.cfapps.eu20-001.hana.ondemand.com`, internal; called only by the approuter) |
| Approuter | `cloud-alm-job-monitor-router` (route `job-failure-monitor.cfapps.eu20-001.hana.ondemand.com`, the URL users open) |
| HANA HDI | `cloud-alm-job-monitor-db` (deployer app `cloud-alm-job-history-db-deployer`, stopped after deploy) |
| Stack | All apps run on `cflinuxfs5` (set in both manifests) |
| XSUAA | `cloud-alm-job-monitor-xsuaa` |
| Destination service | `cloud-alm-job-monitor-destination` |
| Job Scheduling | `cloud-alm-job-monitor-scheduler` (standard plan) |
| Destinations used | `CLOUD_ALM_API`, `S4HC_JournalEntry`, `GENERATIVE_AI_HUB`, `AzureMailService` |
| S/4 communication arrangement | `SAP_COM_0326` on my409865, user `USER_COM_0002` |

### Environment (`manifest.yml`)

| Variable | Value / meaning |
|---|---|
| `CLOUD_ALM_SOURCE_MODE` | `ANALYTICS` |
| `CLOUD_ALM_SERVICE_IDS` | `802b3bea-d94c-4c32-bcd2-e7517a7788fc` (my409865 only) |
| `CLOUD_ALM_INITIAL_LOOKBACK_DAYS` / `CLOUD_ALM_SYNC_INTERVAL_SECONDS` | `7` / `60` |
| `S4_JOB_LOG_DESTINATION` | optional; defaults to `S4HC_JournalEntry` |
| `AI_DEPLOYMENT_ID` / `AI_API_VERSION` | optional; default `d4da60fb50a82e0d` / `2024-10-21` |
| `DEFAULT_SCHEDULER_EMAIL` / `DEFAULT_SCHEDULER_NAME` | digest recipient |
| `MAIL_FROM` | sender mailbox `cap-notifications@bearingpoint.com` |
| `DASHBOARD_URL` | link used in the A2A answer |

---

## 8. Build and deploy

```powershell
npm install
npx cds build --production

# HANA schema (only when db/schema.cds changes)
cd gen/db
cf push cloud-alm-job-history-db-deployer -p . -b nodejs_buildpack -s cflinuxfs5 --no-route --health-check-type process -m 128M -k 256M --no-manifest
cf stop cloud-alm-job-history-db-deployer
cd ../..

# Backend (serves the Fiori app from app/)
cf push

# Approuter
cd approuter
cf push -f manifest.yml
```

After a schema change that adds columns to `JobRuns`, clear the watermark once so history is re-read: `cf run-task JOB_Failure_Dashboard --command "node srv/reset-watermark.js" --name reset -m 256M`.

---

## 9. Project structure

```
app/annotations.cds                       Fiori annotations (list, filters, object page)
app/job-monitor/webapp/                   Fiori app (manifest, Component, ext/main custom page)
approuter/                                Approuter (xs-app.json, manifest.yml)
db/schema.cds                             JobRuns, SyncRuns, SyncState, notification log/claims
srv/job-monitor-service.cds|js            OData service, dashboard functions, AI action
srv/job-store.js                          Deterministic KPIs, trend, by-job, top errors
srv/cloud-alm-sync.js                     60 s sync, watermark, upsert
srv/calm-client.js                        Cloud ALM analytics + raw logs (jam.run)
srv/s4-job-log.js                         S/4HANA job log via SAP_COM_0326
srv/job-failure-agent.js                  AI analysis (SAP AI Core) and e-mail digest (Graph)
srv/scheduled-warning-runner.js           Grouped scheduler digest for POST /run
srv/scheduler-tracking.js                 Notification claims and repeat suppression
srv/reset-watermark.js                    Operational task: re-read history
server.js                                 Bootstrap: redirects, /run, /a2a, agent card, sync start
xs-security.json                          Scopes and role collections
docs/                                     Use-case submission and architecture diagram
JOB-SCHEDULING.md                         Scheduler setup
```

---

## 10. Change history

1. Built the CAP app on BTP with Cloud ALM access through destination `CLOUD_ALM_API` (no secrets in code).
2. Added XSUAA, approuter, HANA HDI, Job Scheduling, the protected `/run` endpoint, notification claims and the A2A endpoint (PO Monitor pattern).
3. Moved to the IDoc Monitor pattern: 60 s sync into HANA, deterministic figures, read-only agent.
4. Restricted the source to my409865 and switched to the working analytics provider `DP_JOB_MONITORING` (hourly raw rows).
5. Added per-run failure detection via Raw Data Outbound Logs `jam.run`.
6. Added the real error reason from the S/4HANA job log via SAP_COM_0326, plus the scheduler name.
7. Connected AI analysis to SAP AI Core (GPT-4.1) using the real log messages, and the combined e-mail to Microsoft Graph; both verified end to end.
8. Replaced the plain HTML page with the Fiori Elements dashboard and object page (KPI tiles, charts, top errors, job list, job log, Analyze with AI).
9. Moved to clean URLs (`job-failure-monitor` / `job-failure-monitor-srv`), removed the random routes, switched all apps to the `cflinuxfs5` stack and deleted the obsolete `cloud-alm-job-monitor-db-deployer`.
10. Pull from Cloud ALM opened to all dashboard users (it failed with 403 for non-admins); the AI action moved from the object page header into the AI Analysis tab.

---

## 11. Open items

- **Scheduler e-mail address:** only the name is available. To send each person their own digest, add a name-to-e-mail mapping or a business-user lookup on my409865.
- **Daily schedule:** create the job in the Job Scheduling dashboard (`POST /run`, e.g. `0 6 * * 1-5`); see `JOB-SCHEDULING.md`.
- **Joule:** register the A2A agent in Joule Studio.
- **Roles:** assign `JobFailureMonitor_Viewer` to users (this includes Pull from Cloud ALM).
- **Credentials:** rotate the Cloud ALM client secret that was shared in chat.
