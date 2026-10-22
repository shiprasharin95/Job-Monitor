# Job Failure Warning Scheduler

The production scheduler invokes `POST /run` on the server module route. The endpoint requires the XSUAA `JobRunner` scope and cannot be called anonymously.

## Create the job

1. Deploy the MTA after the `cloud-alm-job-monitor-scheduler` Job Scheduling service is created and bound.
2. Open the Job Scheduling dashboard for that service instance.
3. Create an HTTP job with method `POST` and target URL `https://<server-module-route>/run`.
4. Select the generated OAuth client for the scheduler service binding.
5. Use an explicit time zone and a minimum frequency of five minutes. A weekday 06:00 schedule can use cron `0 6 * * 1-5`.

## Delivery behavior (daily report)

- The workflow reads failed jobs from persisted `JobRuns`; the 60-second synchronization loop is the only Cloud ALM reader.
- `POST /run` sends the **daily report**: failed jobs of the last 24 hours, grouped by scheduler.
- The scheduler e-mail is resolved from the job creator user ID via the S/4HANA SOAP service **Business User - Read** (communication scenario **SAP_COM_0093**, same communication user as the job log). Jobs whose creator has no e-mail (for example `SAP System Processing`) go to `DEFAULT_SCHEDULER_EMAIL` in one mail.
- Each mail lists every failed job with Job ID, System, Failed at (UTC hour), Error reason (job log) and an AI-generated "Possible resolution". Sender: `MAIL_FROM` (`cap-notifications@bearingpoint.com`).
- On demand: OData action `sendDailyReport(hours, dryRun, suppress, recipient)` (Admin scope). `dryRun=true` returns the mail previews without sending; `recipient` redirects all mails to one test address.
- Each scheduler receives one combined e-mail per run, even when several of their jobs fail.
- A persistent claim is created before mail delivery. Failed jobs are not re-notified for the configured number of working days (`NOTIFICATION_REPEAT_WORKING_DAYS`, default `5`).
- A job without a valid recipient email or an allowed recipient domain is skipped.

## Required source fields

The raw failure source must provide `schedulerEmail` and ideally `schedulerName`. The Cloud ALM Jobs analytics resource is aggregated and may not supply scheduler and error-detail fields, so configure `CloudAlmRawJobLogPath` whenever Raw Data Outbound Logs or another approved execution-detail source is available.

## Synchronization process

The CAP module is intentionally configured for one application instance because the in-flight lock is process-local. It starts one synchronization after CAP is served and repeats every 60 seconds. `SyncState` and duplicate-safe run/event keys protect overlapping re-reads; `SyncRuns` records success and failure audits. Do not scale the service above one instance without replacing the process lock with a database or platform-distributed lock.

The browser JWT is forwarded through the approuter only to authenticate CAP requests. It is never propagated to Cloud ALM. Synchronization uses the technical OAuth client configured in `CLOUD_ALM_API`.
