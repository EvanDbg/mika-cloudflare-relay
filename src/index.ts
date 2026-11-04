/* SPDX-License-Identifier: Apache-2.0
 * Cloudflare entry point for the Mika v0.1.35 relay protocol adaptation.
 */
import { ADMIN_HTML, ADMIN_JS, ADMIN_CSS } from './admin';
import { GATEWAY_VERSION, ownerKeyConfigured, resolveGatewayOrigin, type GatewayEnv } from './gateway';
export { MikaRelay } from './relay';

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function finish(response: Response, requestId: string): Response {
  // Preserve the runtime-owned WebSocket object and negotiated subprotocol.
  if (response.status === 101) return response;
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('Content-Security-Policy', CSP);
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  result.headers.set('X-Request-Id', requestId);
  return result;
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      if (!ownerKeyConfigured(env.OWNER_KEY)) {
        return finish(Response.json({ error: 'gateway_not_configured' }, { status: 503 }), requestId);
      }
      const gateway = resolveGatewayOrigin(request.url, env.GATEWAY_ORIGIN);
      if (!gateway.ok) return finish(Response.json({ error: gateway.error }, { status: gateway.status }), requestId);
      const url = new URL(request.url);

      let asset: { value: string; type: string } | undefined;
      if (url.pathname === '/' || url.pathname === '/admin') asset = { value: ADMIN_HTML, type: 'text/html; charset=utf-8' };
      else if (url.pathname === '/assets/admin.js') asset = { value: ADMIN_JS, type: 'text/javascript; charset=utf-8' };
      else if (url.pathname === '/assets/admin.css') asset = { value: ADMIN_CSS, type: 'text/css; charset=utf-8' };
      if (asset || url.pathname === '/healthz') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return finish(new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } }), requestId);
        const body = asset?.value ?? JSON.stringify({ status: 'ok', version: GATEWAY_VERSION, protocol: 'mika-relay.v2' });
        return finish(new Response(request.method === 'HEAD' ? null : body, { headers: { 'Content-Type': asset?.type ?? 'application/json; charset=utf-8' } }), requestId);
      }

      // All configured Cloudflare routes/aliases reach the same owner and phone.
      // Do not derive this name from a host or pin it on an anonymous first hit.
      // Forward Request.url unchanged; every response uses its own ingress URL.
      const relay = env.RELAY.getByName('single-owner-phone');
      return finish(await relay.fetch(request), requestId);
    } catch {
      // Do not log URLs, query strings, bodies, headers or exception strings.
      console.error(JSON.stringify({ event: 'gateway_unhandled_error', requestId }));
      return finish(Response.json({ error: 'gateway_unavailable', requestId }, { status: 503 }), requestId);
    }
  },
} satisfies ExportedHandler<GatewayEnv>;
