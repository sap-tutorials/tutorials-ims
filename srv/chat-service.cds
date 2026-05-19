@path: '/chat'
@requires: 'authenticated-user'
service ChatService {
  // No entities or actions — the streaming endpoint is a custom Express route on /chat/stream.
  // This service exists for ORD/audit registration symmetry with other services.
}
