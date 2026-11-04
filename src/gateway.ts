/* SPDX-License-Identifier: Apache-2.0
 * Shared ingress configuration for the Worker and its single-phone object.
 */

export const GATEWAY_VERSION = '0.1.1';

// An intersection stays valid when an optional override is later added to
// Wrangler and generated Env then declares that binding as required.
export type GatewayEnv = Env & { GATEWAY_ORIGIN?: string };

type GatewayOrigin =
  | { ok: true; origin: string }
  | { ok: false; status: 421 | 503; error: 'invalid_gateway_origin' | 'gateway_not_configured' };

/** A copied example, an empty binding, or whitespace cannot enable the gateway. */
export function ownerKeyConfigured(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 32;
}

function allowedProtocol(url: URL): boolean {
  return url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

function configuredOrigin(value: string): string | null {
  try {
    // Empty query/fragment markers are also outside an origin. Do not silently
    // turn a path, credential-bearing URL or malformed pasted value into one.
    if (/[?#\\\x00-\x20\x7f]/.test(value)) return null;
    const url = new URL(value);
    if (!allowedProtocol(url) || url.username || url.password || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

/**
 * Request.url is the authority supplied by the trusted Cloudflare ingress and
 * is forwarded unchanged to the DO. Host, Forwarded, and X-Forwarded-* headers
 * never select an origin. No request can pin an origin in shared state.
 */
export function resolveGatewayOrigin(requestURL: string, configured: unknown): GatewayOrigin {
  let required: string | undefined;
  if (configured !== undefined && configured !== '') {
    if (typeof configured !== 'string') return { ok: false, status: 503, error: 'gateway_not_configured' };
    const value = configured.trim();
    if (value) {
      const parsed = configuredOrigin(value);
      if (!parsed) return { ok: false, status: 503, error: 'gateway_not_configured' };
      required = parsed;
    }
  }

  try {
    const url = new URL(requestURL);
    if (!allowedProtocol(url) || url.username || url.password || (required !== undefined && url.origin !== required)) {
      return { ok: false, status: 421, error: 'invalid_gateway_origin' };
    }
    return { ok: true, origin: required ?? url.origin };
  } catch {
    return { ok: false, status: 421, error: 'invalid_gateway_origin' };
  }
}
