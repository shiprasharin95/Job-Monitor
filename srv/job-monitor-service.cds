using { job.monitor as db } from '../db/schema';

@requires: 'User'
@path: 'job-monitor'
service JobMonitorService {

  // ---------------------------------------------------------------- Fiori list + object page
  @readonly
  entity JobRuns as projection on db.JobRuns {
    key sourceRunKey,
        jobName,
        jobId,
        application,
        system,
        statusGroup,
        case statusGroup
          when 'Success'   then 3
          when 'Warning'   then 2
          when 'Error'     then 1
          else 0
        end as statusCriticality : Integer,
        startedAt,
        finishedAt,
        lastUpdatedAt,
        errorText,
        schedulerName,
        s4JobName,
        s4JobRunCount,
        aiAnalysis,
        aiAnalyzedAt,
        logMessages : Association to many JobLogMessages on logMessages.sourceRunKey = sourceRunKey
  } actions {
    // Runs the SAP AI Core agent for this failed run and stores the result on the run.
    action analyzeWithAI() returns JobRuns;
  };

  // Unbound variant used by the AI Analysis tab: the bound action is not addressable from the
  // object page context in every UI5 version, so the section calls this one with the run key.
  action analyzeRunWithAI(sourceRunKey : String) returns JobRuns;

  // Manual corrections written by the operations team and kept in HANA (not in Cloud ALM).
  // One row per failed run; shown again for every run with the same job name.
  type ManualCorrectionReference {
        sourceKey      : String;
        objectId       : String;
        category       : String;
        system         : String;
        correctionText : LargeString;
        createdBy      : String;
        createdAt      : Timestamp;
        modifiedBy     : String;
        modifiedAt     : Timestamp;
  }

  type ManualCorrectionResult { sourceKey : String; correction : ManualCorrectionReference; }

  function getManualCorrection(sourceKey : String) returns ManualCorrectionResult;
  function getSimilarCorrections(jobName : String, excludeKey : String) returns array of ManualCorrectionReference;

  // Saving an empty correctionText deletes the stored correction.
  action saveManualCorrection(
    sourceKey      : String,
    correctionText : String,
    objectId       : String,
    category       : String,
    system         : String,
    errorText      : String
  ) returns ManualCorrectionResult;

  // Full S/4HANA application job log for one run (read live via SAP_COM_0326).
  @readonly
  entity JobLogMessages {
    key sourceRunKey : String(64);
    key sequenceNo   : Integer;
        msgType      : String(1);
        typeText     : String(20);
        criticality  : Integer;
        messageId    : String(40);
        text         : String(1000);
  }

  // Value helps
  @readonly entity StatusGroups { key code : String(12); text : String(40); }
  @readonly entity Jobs as select from db.JobRuns { key jobName } group by jobName;
  @readonly entity Systems as select from db.JobRuns { key system } group by system;

  // ---------------------------------------------------------------- dashboard functions
  type Kpis {
    total        : Integer;
    success      : Integer;
    error        : Integer;
    warning      : Integer;
    inProcess    : Integer;
    successRate  : Decimal(5, 2);
    lastSyncAt   : Timestamp;
    lastSyncOk   : Boolean;
    lastSyncInfo : String;
    dataSource   : String;
  }
  type TrendPoint { bucket : String; success : Integer; error : Integer; warning : Integer; inProcess : Integer; }
  type JobStat    { jobName : String; success : Integer; error : Integer; warning : Integer; inProcess : Integer; total : Integer; }
  type TopError   { jobName : String; errorText : String; count : Integer; }
  type SyncResult { success : Boolean; message : String; }

  function getKpis(period : String)     returns Kpis;
  function getTrend(period : String)    returns array of TrendPoint;
  function getByJob(period : String)    returns array of JobStat;
  function getTopErrors(period : String) returns array of TopError;

  // Same as the IDoc monitor "Pull from Cloud ALM": any dashboard user may trigger an
  // incremental sync; it only refreshes HANA from Cloud ALM and never changes SAP data.
  action syncNow() returns SyncResult;

  // ---------------------------------------------------------------- existing API (A2A, scheduler)
  type Job {
        ID              : UUID;
        jobId           : String(255);
        jobName         : String(500);
        status          : String(80);
        application     : String(255);
        system          : String(255);
        startedAt       : Timestamp;
        finishedAt      : Timestamp;
        durationSeconds : Integer;
        errorSummary    : String(5000);
        schedulerName   : String(500);
        schedulerEmail  : String(320);
        raw             : LargeString;
  }

  type JobError {
        ID          : UUID;
        jobId       : String(255);
        occurredAt  : Timestamp;
        severity    : String(80);
        code        : String(255);
        description : String(5000);
        raw         : LargeString;
  }

  type ConnectionStatus { connected : Boolean; message : String(1000); }

  type DashboardSummary {
    period                : String(4);
    asOf                  : Timestamp;
    totalRuns             : Integer;
    successCount          : Integer;
    errorCount            : Integer;
    warningCount          : Integer;
    inProcessCount        : Integer;
    successRate           : Decimal(5,2);
    topError              : String(5000);
    failuresByJob         : LargeString;
    failuresByApplication : LargeString;
    latestFailedJobs      : LargeString;
    lastSyncAt            : Timestamp;
    lastSyncStatus        : String(16);
  }

  type JobAnalysis     { jobId : String(255); jobName : String(500); analysis : LargeString; }
  type SchedulerDigest { recipient : String(500); jobCount : Integer; subject : String(1000); text : LargeString; html : LargeString; }

  function failedJobs(top : Integer) returns array of Job;
  function jobErrors(jobId : String) returns array of JobError;
  function testConnection() returns ConnectionStatus;
  function summary(period : String, asOf : String) returns DashboardSummary;
  action analyzeJob(jobId : String, jobName : String) returns JobAnalysis;

  // Daily report: one e-mail per scheduler with all failed jobs of the last `hours` (default 24),
  // error reason and AI-generated possible resolution. dryRun returns previews without sending.
  type MailPreview { to : String; scheduler : String; jobCount : Integer; subject : String; text : LargeString; }
  type MailFailure { scheduler : String; to : String; message : String; }
  type DailyReportResult {
    hours      : Integer;
    inspected  : Integer;
    schedulers : Integer;
    mailsSent  : Integer;
    previews   : array of MailPreview;
    failures   : array of MailFailure;
  }
  @requires: 'Admin'
  action sendDailyReport(hours : Integer, dryRun : Boolean, suppress : Boolean, recipient : String) returns DailyReportResult;
  action sendSchedulerDigest(schedulerEmail : String, schedulerName : String, failedJobs : LargeString) returns SchedulerDigest;
}
