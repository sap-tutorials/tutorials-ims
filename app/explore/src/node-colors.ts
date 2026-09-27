import type { NodeType, PredicateType } from './types'

export const NODE_COLORS: Record<NodeType, string> = {
  tutorial:           '#0a6ed1',
  concept:            '#107e3e',
  mission:            '#df6e0c',
  product:            '#a100c2',
  group:              '#8c8c8c',
  category:           '#666666',
  tag:                '#888888',
  'learning-journey': '#c25e00',
  'blog-post':        '#5b738b',
  'discovery-mission':'#e9730c',
  video:              '#bb0000',
  'api-doc':          '#0070f2',
  sample:             '#6a6d70',
  'help-doc':         '#7858a8',
  'community-event':  '#049f9a',
  'devtoberfest-session': '#e97800',
}

export const EDGE_COLORS: Record<PredicateType, string> = {
  teaches:         '#999999',
  requires:        '#999999',
  relatedTo:       '#999999',
  extends:         '#999999',
  partOf:          '#999999',
  taggedWith:      '#999999',
  aboutProduct:    '#999999',
  inCategory:      '#999999',
  coCompletedWith: '#cccccc',
  presents:        '#e97800',
  aboutTutorial:   '#e97800',
}

export function colorForNodeType(t: NodeType): string {
  return NODE_COLORS[t] ?? '#8c8c8c'
}

export function edgeColorForPredicate(p: PredicateType): string {
  return EDGE_COLORS[p] ?? '#999999'
}
