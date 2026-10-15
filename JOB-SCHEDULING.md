# Job Failure Warning Scheduler

The production scheduler invokes `POST /run` on the server module route. The endpoint requires the XSUAA `JobRunner` scope and cannot be called anonymously.

## Create the job

1. Deploy the MTA after the `cloud-alm-job-monitor-scheduler` Job Scheduling service is created and bound.
2. Open the Job Scheduling dashboard for that service instance.
3. Create an HTTP job with method `POST` and target URL `https://<server-module-route>/run`.
4. Select the generated OAuth client for the scheduler service binding.
5. Use an explicit time zone and a minimum frequency of five minutes. A weekday 06:00 schedule can use cron `0 6 * * 1-5`.

## Delivery behavior

- The workflow reads failed jobs from persisted `JobRuns`; the 60-second synchronization loop is the only Cloud ALM reader.
- Jobs are grouped by `schedulerEmail`.
- Each scheduler receives one combined e-mail per run, even when several of their jobs fail.
- A persistent claim is created before mail delivery. Failed jobs are not re-notified for the configured number of working days (`NOTIFICATION_REPEAT_WORKING_DAYS`, default `5`).
- A job without a valid recipient email or an allowed recipient domain is skipped.

## Required source fields

The raw failure source must provide `schedulerEmail` and ideally `schedulerName`. The Cloud ALM Jobs analytics resource is aggregated and may not supply scheduler and error-detail fields, so configure `CloudAlmRawJobLogPath` whenever Raw Data Outbound Logs or another approved execution-detail source is available.

## Synchronization process

The CAP module is intentionally configured for one application instance because the in-flight lock is process-local. It starts one synchronization after CAP is served and repeats every 60 seconds. `SyncState` and duplicate-safe run/event keys protect overlapping re-reads; `SyncRuns` records success and failure audits. Do not scale the service above one instance without replacing the process lock with a database or platform-distributed lock.

The browser JWT is forwarded through the approuter only to authenticate CAP requests. It is never propagated to Cloud ALM. Synchronization uses the technical OAuth client configured in `CLOUD_ALM_API`.
