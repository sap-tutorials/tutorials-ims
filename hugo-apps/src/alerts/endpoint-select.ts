export function selectEndpoint(authenticated: boolean): string {
  return authenticated ? '/api/alerts/me' : '/api/alerts';
}
