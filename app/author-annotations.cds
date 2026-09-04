using { AuthorService } from '../srv/author-service';

// Report A — Tutorial Engagement (Analytical List Page).
// Starts-vs-completions bar per tutorial, completion-rate criticality in the table.
// Grain: 1 row per tutorialSlug (#2138 finding-1 split-grain). No measure is ever
// summed across parents; mission/group is a filter via the `parents` association.
annotate AuthorService.AuthorTutorialEngagement with @(
  Aggregation.ApplySupported: {
    Transformations: ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'],
    GroupableProperties: [ tutorialTitle ],
    AggregatableProperties: [
      { Property: startedLearners },
      { Property: completedLearners },
      { Property: completions }
    ]
  },
  Analytics.AggregatedProperty #totalStarted: {
    Name: 'totalStarted', AggregationMethod: 'sum',
    AggregatableProperty: startedLearners, ![@Common.Label]: 'Started'
  },
  Analytics.AggregatedProperty #totalCompleted: {
    Name: 'totalCompleted', AggregationMethod: 'sum',
    AggregatableProperty: completedLearners, ![@Common.Label]: 'Completed'
  },
  UI.Chart: {
    ChartType: #Bar,
    Dimensions: [tutorialTitle],
    DynamicMeasures: [
      '@Analytics.AggregatedProperty#totalStarted',
      '@Analytics.AggregatedProperty#totalCompleted'
    ]
  },
  UI.PresentationVariant: {
    Visualizations: ['@UI.Chart', '@UI.LineItem'],
    SortOrder: [{ Property: startedLearners, Descending: true }]
  },
  UI.SelectionFields: [ parents.missionTitle, parents.groupTitle, tutorialTitle ],
  UI.DataPoint #rate: {
    Value: completionRatePct,
    Title: 'Completion Rate %',
    CriticalityCalculation: {
      ImprovementDirection      : #Maximize,
      DeviationRangeLowValue    : 25,
      ToleranceRangeLowValue    : 50
    }
  },
  UI.LineItem: [
    { Value: tutorialTitle },
    { Value: startedLearners,   Label: 'Started' },
    { Value: completedLearners, Label: 'Completed' },
    { Value: completions,       Label: 'Completions' },
    { $Type: 'UI.DataFieldForAnnotation', Target: '@UI.DataPoint#rate', Label: 'Completion Rate %' }
  ]
) {
  tutorialSlug      @UI.Hidden;
  tutorialTitle     @title: 'Tutorial'   @Analytics.Dimension;
  startedLearners   @title: 'Started'    @Analytics.Measure @Aggregation.default: #SUM;
  completedLearners @title: 'Completed'  @Analytics.Measure @Aggregation.default: #SUM;
  completions       @title: 'Completions' @Analytics.Measure @Aggregation.default: #SUM;
  completionRatePct @title: 'Completion Rate %';
};

// Report B — Tutorial Completions (List Report). Completions over time, filterable
// by mission/group/tutorial/date. Grain: 1 row per completion event (recordId)
// (#2138 finding-1 split-grain). completionCount summed once per event; mission/
// group is a filter via the `parents` association, never a summed join.
annotate AuthorService.AuthorTutorialCompletions with @(
  Aggregation.ApplySupported: {
    Transformations: ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'],
    GroupableProperties: [ completionDay, tutorialTitle ],
    AggregatableProperties: [ { Property: completionCount } ]
  },
  Analytics.AggregatedProperty #totalCompletions: {
    Name: 'totalCompletions', AggregationMethod: 'sum',
    AggregatableProperty: completionCount, ![@Common.Label]: 'Completions'
  },
  UI.Chart: {
    ChartType: #Column,
    Dimensions: [completionDay],
    DynamicMeasures: ['@Analytics.AggregatedProperty#totalCompletions']
  },
  UI.PresentationVariant: {
    Visualizations: ['@UI.Chart', '@UI.LineItem'],
    SortOrder: [{ Property: completionDate, Descending: true }]
  },
  UI.SelectionFields: [ parents.missionTitle, parents.groupTitle, tutorialTitle, completionDate ],
  UI.LineItem: [
    { Value: completionDate },
    { Value: tutorialTitle },
    { Value: completionCount, Label: 'Completions' }
  ]
) {
  recordId        @UI.Hidden;
  tutorialSlug    @UI.Hidden;
  tutorialTitle   @title: 'Tutorial'        @Analytics.Dimension;
  completionDate  @title: 'Completion Date' @Analytics.Dimension;
  completionDay   @title: 'Completion Day'  @Analytics.Dimension;
  completionCount @title: 'Completions'     @Analytics.Measure @Aggregation.default: #SUM;
};

// #2138 — filter value help + labels for BOTH reports above. Their
// UI.SelectionFields reference `parents.missionTitle` / `parents.groupTitle`,
// so FE derives the filter-field label and value help from the navigation
// TARGET (AuthorTutorialParents), not from the base view. Without these the
// filters showed the raw technical column name and a free-text box.
// Value help mirrors AdminService.CompletionAnalytics (app/admin-annotations.cds):
// the denormalized title string maps to Missions/Groups.title, with slug as the
// read-only secondary text. Missions/Groups are projected on AuthorService.
annotate AuthorService.AuthorTutorialParents with {
  parentKey     @UI.Hidden;
  tutorialSlug  @UI.Hidden;
  tutorialTitle @title: 'Tutorial';
  missionTitle  @title: 'Mission' @Common.ValueList: {
    CollectionPath: 'Missions',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: missionTitle, ValueListProperty: 'title' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' }
    ]
  };
  groupTitle    @title: 'Group' @Common.ValueList: {
    CollectionPath: 'Groups',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: groupTitle, ValueListProperty: 'title' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' }
    ]
  };
};
