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

  /** Fetch the full article body of one SAP Developer News item by URL.
      Complements get_recent_news (which returns only title/link/summary):
      given a news item's `link`, this server-fetches the article and returns
      its readable text plus metadata. Only SAP news hosts are permitted
      (news.sap.com, community.sap.com, blogs.sap.com); other hosts are rejected.
      @param url  The article link from get_recent_news (must be an SAP news host). */
  @(requires: 'any')
  function get_news_detail(url: String) returns {
    title       : String;
    url         : String;
    publishedAt : Timestamp;
    summary     : String;
    content     : String;
    fetchedAt   : Timestamp;
  };
}
