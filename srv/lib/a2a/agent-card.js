// Pure Agent Card builder (A2A protocol). Served at /.well-known/agent-card.json.
// No I/O — baseUrl/tokenUrl/enabled are injected by the caller in server.js.
export const SKILL_IDS = ['tutorial-chat', 'search-tutorials', 'user-progress', 'knowledge-graph', 'tutorial-steps'];

const SKILLS = [
  { id: 'tutorial-chat', name: 'Ask about SAP tutorials',
    description: 'Conversational Q&A over SAP developer tutorials, missions, and learning paths. Runs the full agentic loop (search, knowledge graph, progress).',
    tags: ['chat', 'tutorials', 'learning', 'rag'],
    examples: ['How do I get started with CAP?', 'What should I learn after the HANA Cloud tutorial?'] },
  { id: 'search-tutorials', name: 'Search tutorials',
    description: 'Semantic/keyword search over the SAP tutorial catalog.',
    tags: ['search', 'tutorials'],
    examples: ['Find tutorials about Fiori elements', 'Search for ABAP RAP tutorials'] },
  { id: 'user-progress', name: 'Get my learning progress',
    description: "The signed-in developer's tutorial/mission progress. Requires the caller to forward the end-user's identity token; returns empty results otherwise.",
    tags: ['progress', 'personal'],
    examples: ['Which tutorials have I completed?', 'Where did I leave off?'] },
  { id: 'knowledge-graph', name: 'Explore the learning graph',
    description: 'Concept expansion and learning-path reasoning over the tutorial knowledge graph.',
    tags: ['knowledge-graph', 'paths', 'concepts'],
    examples: ['Show a learning path to RAP', 'What concepts relate to CAP?'] },
  { id: 'tutorial-steps', name: 'Fetch relevant tutorial steps',
    description: 'Return the tutorial step content most relevant to a question so a central agent can quote exact instructions.',
    tags: ['content', 'steps'],
    examples: ['How do I define a CDS entity in the getting-started tutorial?'] },
];

export function buildAgentCard({ baseUrl, tokenUrl, enabled = true }) {
  return {
    protocolVersion: '0.3.0',
    name: 'SAP Tutorials Learning Agent',
    description: 'Answers questions about SAP developer tutorials, missions, and learning paths; searches the tutorial catalog; reasons over the tutorial knowledge graph; and reports a signed-in developer\'s progress.',
    url: `${baseUrl}/a2a`,
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    provider: { organization: 'SAP Tutorials (developers.sap.com)', url: 'https://developers.sap.com' },
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    securitySchemes: {
      xsuaa: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: tokenUrl || '', scopes: { 'Tutorial.MCP': 'MCP/A2A protocol access — authenticated tutorial reads/writes' } } } },
    },
    security: [{ xsuaa: ['Tutorial.MCP'] }],
    skills: SKILLS,
    documentationUrl: `${baseUrl}/.well-known/a2a-instructions.md`,
    metadata: { available: enabled },
  };
}
