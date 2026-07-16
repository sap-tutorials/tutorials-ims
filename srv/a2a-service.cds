@path: '/a2a'
@requires: 'authenticated-user'
service A2aService {
  // No entities or actions — the A2A endpoint is a custom JSON-RPC Express
  // router registered in srv/server.js (see makeA2aRouter). This service
  // exists for ORD/audit registration symmetry with ChatService (#1220).
}
