using JobMonitorService as service from '../srv/job-monitor-service';

annotate service.JobRuns with @(
  Capabilities.FilterRestrictions.FilterExpressionRestrictions: [
    { Property: startedAt, AllowedExpressions: 'SingleRange' }
  ],
  UI.SelectionFields: [ statusGroup, jobName, system, schedulerName, startedAt ],
  UI.PresentationVariant: {
    SortOrder     : [{ Property: startedAt, Descending: true }],
    Visualizations: ['@UI.LineItem']
  },
  UI.LineItem: [
    { Value: jobName, @UI.Importance: #High },
    { Value: statusGroup, Criticality: statusCriticality, CriticalityRepresentation: #WithIcon, @UI.Importance: #High },
    { Value: errorText, @UI.Importance: #High },
    { Value: application },
    { Value: system },
    { Value: schedulerName },
    { Value: startedAt, @UI.Importance: #High }
  ],

  UI.HeaderInfo: {
    TypeName      : 'Job Run',
    TypeNamePlural: 'Job Runs',
    Title         : { Value: jobName },
    Description   : { Value: system }
  },
  UI.HeaderFacets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#state' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#started' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#scheduler' }
  ],
  UI.DataPoint #state    : { Value: statusGroup, Title: 'Processing State', Criticality: statusCriticality },
  UI.DataPoint #started  : { Value: startedAt, Title: 'Failed in hour (UTC)' },
  UI.DataPoint #scheduler: { Value: schedulerName, Title: 'Scheduled By' },

  UI.FieldGroup #Job: { Data: [
    { Value: jobName }, { Value: jobId }, { Value: application },
    { Value: statusGroup, Criticality: statusCriticality, CriticalityRepresentation: #WithIcon },
    { Value: startedAt }, { Value: finishedAt }
  ]},
  UI.FieldGroup #Schedule: { Data: [
    { Value: schedulerName }, { Value: s4JobName }, { Value: s4JobRunCount }
  ]},
  UI.FieldGroup #System: { Data: [
    { Value: system }, { Value: lastUpdatedAt }, { Value: sourceRunKey }
  ]},
  UI.FieldGroup #Error: { Data: [ { Value: errorText } ] },
  // The AI action lives only in the AI Analysis tab (section toolbar), not in the page header.
  UI.FieldGroup #AI   : { Data: [
    { $Type: 'UI.DataFieldForAction', Action: 'JobMonitorService.analyzeWithAI', Label: 'Generate AI Analysis' },
    { Value: aiAnalysis }, { Value: aiAnalyzedAt }
  ] },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', ID: 'Overview', Label: 'Overview', Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Job',           Target: '@UI.FieldGroup#Job' },
      { $Type: 'UI.ReferenceFacet', Label: 'Schedule',      Target: '@UI.FieldGroup#Schedule' },
      { $Type: 'UI.ReferenceFacet', Label: 'Source System', Target: '@UI.FieldGroup#System' }
    ]},
    { $Type: 'UI.ReferenceFacet', ID: 'ErrorFacet', Label: 'Error Details', Target: '@UI.FieldGroup#Error' },
    { $Type: 'UI.ReferenceFacet', ID: 'AIFacet', Label: 'AI Analysis', Target: '@UI.FieldGroup#AI' },
    { $Type: 'UI.ReferenceFacet', ID: 'LogFacet', Label: 'Job Log', Target: 'logMessages/@UI.LineItem' }
  ]
) {
  sourceRunKey      @title: 'Run Key';
  jobName           @title: 'Job' @Common.ValueList: { CollectionPath: 'Jobs', Parameters: [
                      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: jobName, ValueListProperty: 'jobName' } ] };
  jobId             @title: 'Cloud ALM Job ID';
  application       @title: 'Job Type';
  system            @title: 'System' @Common.ValueList: { CollectionPath: 'Systems', Parameters: [
                      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: system, ValueListProperty: 'system' } ] };
  statusGroup       @title: 'Processing State' @Common.ValueListWithFixedValues @Common.ValueList: { CollectionPath: 'StatusGroups', Parameters: [
                      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: statusGroup, ValueListProperty: 'code' },
                      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'text' } ] };
  statusCriticality @UI.Hidden;
  startedAt         @title: 'Failed in Hour (UTC)';
  finishedAt        @title: 'Hour End (UTC)';
  lastUpdatedAt     @title: 'Last Sync Update';
  errorText         @title: 'Error Reason (Job Log)' @UI.MultiLineText;
  schedulerName     @title: 'Scheduled By';
  s4JobName         @title: 'S/4HANA Job Name';
  s4JobRunCount     @title: 'S/4HANA Job Run Count';
  aiAnalysis        @title: 'AI Root-Cause Analysis' @UI.MultiLineText;
  aiAnalyzedAt      @title: 'Analyzed At';
};

annotate service.JobLogMessages with @(
  UI.PresentationVariant: { SortOrder: [{ Property: sequenceNo }], Visualizations: ['@UI.LineItem'] },
  UI.LineItem: [
    { Value: sequenceNo },
    { Value: typeText, Criticality: criticality, CriticalityRepresentation: #WithIcon },
    { Value: text },
    { Value: messageId }
  ]
) {
  sourceRunKey @UI.Hidden;
  criticality  @UI.Hidden;
  msgType      @UI.Hidden;
  sequenceNo   @title: 'Seq.';
  typeText     @title: 'Type';
  text         @title: 'Message';
  messageId    @title: 'Message Class / No.';
};

annotate service.StatusGroups with {
  code @title: 'Processing State' @Common.Text: text @Common.TextArrangement: #TextOnly;
  text @title: 'Description';
};
annotate service.Jobs    with { jobName @title: 'Job'; };
annotate service.Systems with { system  @title: 'System'; };
