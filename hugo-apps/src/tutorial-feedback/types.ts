export type RatingScale = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | null;

export interface FeedbackSubmission {
  tutorialSlug: string;
  ratingUseCase: RatingScale;
  ratingRelevance: RatingScale;
  ratingDuration: RatingScale;
  ratingStructure: RatingScale;
  ratingInteresting: RatingScale;
  ratingVisuals: RatingScale;
  npsScore: RatingScale;
  comment: string;
  wasAuthenticated: boolean;
  honeypot: string;
}
