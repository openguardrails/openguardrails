export default {
  async fetch(request) {
    const url = new URL(request.url);
    // Canonical host: 301 any www.openguardrails.com/* to the apex, preserving path + query
    if (url.hostname === 'www.openguardrails.com') {
      url.hostname = 'openguardrails.com';
      return Response.redirect(url.toString(), 301);
    }
    // Normalize /platform -> /platform/ so the SPA loads correctly
    if (url.pathname === '/platform') {
      url.pathname = '/platform/';
      return Response.redirect(url.toString(), 301);
    }
    // Transparent same-origin reverse proxy to the origin (served via api.openguardrails.com vhost)
    url.hostname = 'api.openguardrails.com';
    return fetch(new Request(url, request));
  }
}
