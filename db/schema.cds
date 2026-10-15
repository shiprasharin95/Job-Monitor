namespace job.monitor;

using { managed } from '@sap/cds/common';

entity FAILURE_NOTIFICATION_LOG : managed {
  key failureKey     : String(512);
      schedulerEmail : String(320);
      firstNotified  : Timestamp;
      lastNotified   : Timestamp;
      resolved       : Boolean default false;
      resolvedAt     : Timestamp;
}

entity FAILURE_NOTIFICATION_CLAIM {
  key idempotencyKey : String(64);
      failureKey     : String(512);
      schedulerEmail : String(320);
      status         : String(16);
      outcomeCode    : String(80);
      claimedAt      : Timestamp @cds.on.insert: $now;
      completedAt    : Timestamp;
}

entity JobRuns {
  key sourceRunKey   : String(64);
      sourceRunId    : String(512);
      jobId          : String(255);
      jobName        : String(500);
      application    : String(255);
      system         : String(255);
      statusGroup    : String(16);
      sourceStatus   : String(80);
      criticality    : String(40);
      startedAt      : Timestamp;
      finishedAt     : Timestamp;
      errorText      : LargeString;
      schedulerName  : String(500);
      schedulerEmail : String(320);
      lastUpdatedAt  : Timestamp;
      raw             : LargeString;
      // S/4HANA run reference (Cloud ALM schedule_id / run id) used to open the job log.
      s4JobName      : String(64);
      s4JobRunCount  : String(32);
      // Latest AI analysis, cached so the object page shows it without re-calling the model.
      aiAnalysis     : LargeString;
      aiAnalyzedAt   : Timestamp;
}

entity JobRunEvents {
  key eventKey       : String(64);
      sourceRunKey   : String(64);
      jobId          : String(255);
      occurredAt     : Timestamp;
      severity       : String(80);
      code           : String(255);
      description    : LargeString;
      raw             : LargeString;
}

entity SyncRuns : managed {
  key ID              : UUID;
      source           : String(80);
      status           : String(16);
      startedAt        : Timestamp;
      finishedAt       : Timestamp;
      windowFrom       : Timestamp;
      windowTo         : Timestamp;
      recordsRead      : Integer default 0;
      runsWritten      : Integer default 0;
      eventsWritten    : Integer default 0;
      sourceMode       : String(40);
      errorText        : LargeString;
}

entity SyncState {
  key source          : String(80);
      watermark       : Timestamp;
      lastSuccessfulAt: Timestamp;
      lastSyncRun_ID  : UUID;
}
