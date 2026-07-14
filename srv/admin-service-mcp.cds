// srv/admin-service-mcp.cds
// Phase 3 (#1106) — admin curation MCP tools (WS2). AdminService carries
// @requires:'Admin' at service level; each action below adds its own, more
// specific @requires so CAP enforces before the @cap-js/mcp adapter dispatches.
// Auth: AdminService is @requires:'Admin' service-level; each action ANDs its own scope (KnowledgeGraph.Admin/SuperAdmin/Tutorial.Author). Callers need Admin PLUS the action scope — intended for the admin-curation tier.
// Doc-comments (first sentence ≥40 chars) become the MCP tool descriptions.
//
// @protocol is widened to expose MCP alongside OData. Object-form is REQUIRED
// so OData still mounts at /admin (see [[cap-graphql-shortcut-replaces-odata]]):
// an array form with a bare 'mcp'/'graphql' string collapses every adapter onto
// one path and OData 404s. Task 13 adds the /mcp-admin route rewrite.
using from './admin-service';
using from './knowledge-graph-service';

annotate AdminService with @protocol: [{ kind: 'odata' }, { kind: 'mcp', path: '/mcp/admin' }];

extend service AdminService {

  /** Merge a duplicate ("loser") knowledge-graph concept into a canonical one.
      All links repoint to the canonical concept and the loser is retired.
      Delegates to KnowledgeGraphService.mergeConcepts. Requires KnowledgeGraph.Admin.
      @param loser      UUID of the concept to retire.
      @param canonical  UUID of the surviving concept. */
  @(requires: 'KnowledgeGraph.Admin')
  action merge_concepts(loser: UUID, canonical: UUID) returns { merged: Boolean };

  /** Draft a mission from a Louvain-detected knowledge-graph community. The
      community's tutorials become the mission's completion path (ordered A→Z by
      title); a curator finishes and publishes the draft. Requires SuperAdmin.
      DEV-only until the #917 promotion flow reaches production.
      @param communityId  Louvain community id (integer).
      @param missionSlug   Slug for the new mission (lowercased).
      @param title         Human-readable mission title. */
  @(requires: 'SuperAdmin')
  action promote_community_to_mission(communityId: Integer, missionSlug: String, title: String) returns {
    ID    : String;
    slug  : String;
    title : String;
  };

  /** Trigger a content rebuild via the CI-validated rebuild-content.yml workflow
      (the PREFERRED content-publish path). Side-effecting: dispatches a GitHub
      workflow. With a slug, rebuilds just that tutorial (~2 min); without, a full
      rebuild (~10 min). Mode is auto-inferred from slug. Requires Tutorial.Author.
      @param slug  Optional lowercase tutorial slug for a targeted rebuild.
      @param mode  Optional 'full' | 'slug-targeted' | 'catalog-only'. */
  @(requires: 'Tutorial.Author')
  action trigger_rebuild(slug: String, mode: String) returns {
    scheduled : Boolean;
    mode      : String;
    slug      : String;
  };

  /** EMERGENCY: publish pre-rendered tutorial HTML directly to the content store,
      bypassing CI. Side-effecting and destructive — prefer trigger_rebuild, which
      is CI-validated. The html payload must be gzip-compressed + base64-encoded
      (as publish-content.ts sends). Requires SuperAdmin. Auth: CDS @requires
      enforces SuperAdmin; CONTENT_API_KEY must be configured or the call is
      rejected 503 at the app layer (no Bearer header is forwarded).
      @param slug  Lowercase tutorial slug.
      @param html  gzip+base64-encoded rendered tutorial HTML to publish. */
  @(requires: 'SuperAdmin')
  action publish_content(slug: String, html: String) returns {
    published : Boolean;
    slug      : String;
  };
}
