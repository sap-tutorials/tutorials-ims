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
    score       : Double;
  };
}
