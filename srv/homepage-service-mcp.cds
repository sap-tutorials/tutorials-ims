using from './homepage-service';

// Phase 2 (#1105) — authenticated recommendation MCP tools on HomepageService.
// Persona-weighted recommendations from HomepageForYouCandidates (shared pool).
// Doc-comments become MCP tool descriptions.
extend service HomepageService {

  /** Return persona-weighted recommended tutorials for the signed-in user.
      Results are drawn from the HomepageForYouCandidates shared pool, ranked
      by the user's role/deployment/cloud persona (same logic as the homepage
      forYou band). Returns an empty array for users with no matching persona.
      @param limit  Max results, [1, 20]. Default 10. */
  @(requires: 'authenticated-user')
  function get_my_recommended_tutorials(limit: Integer) returns array of {
    slug        : String;
    title       : String;
    description : String;
  };

  /** Return persona-weighted recommended missions for the signed-in user.
      Same persona-weighting as get_my_recommended_tutorials but filtered to
      kind='mission' entries from HomepageForYouCandidates.
      @param limit  Max results, [1, 10]. Default 5. */
  @(requires: 'authenticated-user')
  function get_my_recommended_missions(limit: Integer) returns array of {
    slug        : String;
    title       : String;
    description : String;
  };
}
