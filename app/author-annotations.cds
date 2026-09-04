using { AuthorService } from '../srv/author-service';

// Report A — Tutorial Engagement (Analytical List Page).
// Starts-vs-completions bar per tutorial, completion-rate criticality in the table.
annotate AuthorService.AuthorTutorialEngagement with @(
  Aggregation.ApplySupported: {
    Transformations: ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'],
    GroupableProperties: [ tutorialTitle, missionTitle, groupTitle ],
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
  UI.SelectionFields: [ missionTitle, groupTitle, tutorialTitle ],
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
    { Value: missionTitle },
    { Value: groupTitle },
    { Value: startedLearners,   Label: 'Started' },
    { Value: completedLearners, Label: 'Completed' },
    { Value: completions,       Label: 'Completions' },
    { $Type: 'UI.DataFieldForAnnotation', Target: '@UI.DataPoint#rate', Label: 'Completion Rate %' }
  ]
) {
  reportKey         @UI.Hidden;
  tutorialSlug      @UI.Hidden;
  tutorialTitle     @title: 'Tutorial'   @Analytics.Dimension;
  missionTitle      @title: 'Mission'    @Analytics.Dimension;
  groupTitle        @title: 'Group'      @Analytics.Dimension;
  startedLearners   @title: 'Started'    @Analytics.Measure @Aggregation.default: #SUM;
  completedLearners @title: 'Completed'  @Analytics.Measure @Aggregation.default: #SUM;
  completions       @title: 'Completions' @Analytics.Measure @Aggregation.default: #SUM;
  completionRatePct @title: 'Completion Rate %';
};

// Report B — Tutorial Completions (List Report). Completions over time, filterable
// by mission/group/tutorial/date.
annotate AuthorService.AuthorTutorialCompletions with @(
  Aggregation.ApplySupported: {
    Transformations: ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'],
    GroupableProperties: [ completionDay, tutorialTitle, missionTitle, groupTitle ],
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
  UI.SelectionFields: [ missionTitle, groupTitle, tutorialTitle, completionDate ],
  UI.LineItem: [
    { Value: completionDate },
    { Value: tutorialTitle },
    { Value: missionTitle },
    { Value: groupTitle },
    { Value: completionCount, Label: 'Completions' }
  ]
) {
  reportKey       @UI.Hidden;
  recordId        @UI.Hidden;
  tutorialSlug    @UI.Hidden;
  tutorialTitle   @title: 'Tutorial'        @Analytics.Dimension;
  missionTitle    @title: 'Mission'         @Analytics.Dimension;
  groupTitle      @title: 'Group'           @Analytics.Dimension;
  completionDate  @title: 'Completion Date' @Analytics.Dimension;
  completionDay   @title: 'Completion Day'  @Analytics.Dimension;
  completionCount @title: 'Completions'     @Analytics.Measure @Aggregation.default: #SUM;
};
