// srv/knowledge-graph-service-mcp.cds
// Phase 3 (#1106) — KG deep-dive MCP tools. Anonymous (@requires:'any' inherited
// from KnowledgeGraphService). Doc-comments become MCP tool descriptions.
using from './knowledge-graph-service';

extend service KnowledgeGraphService {

  /** Concept overlap between two tutorials — the concepts BOTH teach. Answers
      "what do these two tutorials have in common?". Anonymous; published KG
      content is public.
      @param slug_a  First tutorial slug (lowercase canonical).
      @param slug_b  Second tutorial slug (lowercase canonical). */
  function kg_shared_concepts(slug_a: String, slug_b: String) returns array of {
    conceptSlug : String;
    name        : String;
  };

  /** Fuller graph neighborhood for a tutorial: prerequisites, what-to-learn-next,
      shared concepts, and concepts it teaches. PageRank-blended when enabled;
      each entry flags whether the node is graph-isolated. Anonymous.
      @param slug   Tutorial slug (lowercase canonical).
      @param depth  Max entries per arm, [1, 50]. Default 10. */
  function kg_neighborhood(slug: String, depth: Integer) returns {
    prerequisites   : array of { slug: String; title: String; score: Double; isolated: Boolean };
    whatToLearnNext : array of { slug: String; title: String; score: Double; isolated: Boolean };
    sharedConcepts  : array of { slug: String; title: String; score: Double; isolated: Boolean };
    teaches         : array of { slug: String; title: String; score: Double; isolated: Boolean };
  };

  /** Free-text search across knowledge-graph concepts and the tutorials that
      teach them. Returns ranked concept and tutorial matches. Bridges on-demand
      concept extraction when that feature is enabled. Anonymous.
      @param query         Free-text search terms.
      @param maxConcepts   Max concept results, [1, 25]. Default 25.
      @param maxTutorials  Max tutorial results, [1, 25]. Default 10. */
  function kg_search_concepts(query: String, maxConcepts: Integer, maxTutorials: Integer) returns {
    concepts  : array of { slug: String; name: String; score: Double };
    tutorials : array of { slug: String; title: String; score: Double };
  };
}
