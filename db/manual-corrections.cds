// Manual corrections written by support users, stored in HANA (not in Cloud ALM).
// One row per failed run: the free text describes the steps a colleague performed to fix it and is
// shown again next to the AI analysis of every run with the same job name.
namespace job.monitor;

entity ManualCorrections {
  key ID             : UUID;
      sourceKey      : String(64);
      objectId       : String(500);
      category       : String(200);
      system         : String(200);
      errorText      : String(4000);
      correctionText : String(5000);
      createdBy      : String(120);
      createdAt      : Timestamp;
      modifiedBy     : String(120);
      modifiedAt     : Timestamp;
}
