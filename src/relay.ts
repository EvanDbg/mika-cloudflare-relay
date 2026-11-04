// SPDX-License-Identifier: Apache-2.0
// Cloudflare port of the Mika relay protocol. Upstream: wangzan101/Mika,
// commit 6661b9e99a9a8f372c93845f5f9572de0711f239 (v0.1.35),
// tools/relay/gateway.go and core/.../remote/RelayClient.kt.
// See vendor/mika/LICENSE and the repository NOTICE for attribution.

import { DurableObject } from "cloudflare:workers";
import { GATEWAY_VERSION, ownerKeyConfigured, resolveGatewayOrigin, type GatewayEnv } from "./gateway";

const PROTOCOL = "mika-relay.v2";
const MAX_BODY = 1_048_576;
const MAX_FRAME = 2 * MAX_BODY;
const MAX_HEADERS = 8_192;
const MAX_PENDING = 8;
const PAIR_LIFETIME = 5 * 60_000;
const DEVICE_TAG = "mika-device";
const encoder = new TextEncoder();

const REQUEST_HEADERS = new Set([
  "authorization", "origin", "x-mika-client", "content-type", "accept",
  "mcp-protocol-version", "mcp-method", "mcp-name", "mcp-session-id", "last-event-id",
]);
const RESPONSE_HEADERS = new Set([
  "content-type", "allow", "retry-after", "www-authenticate", "mcp-protocol-version",
]);
const FRAME_FIELDS = new Set([
  "type", "id", "method", "path", "query", "headers", "body", "status", "client",
]);

type StateRow = {
  device_hash: string;
  pair_hash: string;
  pair_expires_at: number;
  generation: number;
};
type DeviceAttachment = { version: 1; generation: number };
type Connection = { socket: WebSocket; generation: number };
type Pending = {
  generation: number;
  path: string;
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  abort: () => void;
};
type PhoneResponse = {
  id: string;
  status: number;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
};

class RequestFailure extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/**
 * One owner / one phone. Only identity hashes, connection generations, pairing
 * expiry and rate-limit counters are durable. Tasks and phone access tokens are
 * never stored, queued, replayed, or inspected for authentication by the relay.
 */
export class MikaRelay extends DurableObject<GatewayEnv> {
  private readonly sql: SqlStorage;
  private readonly timeout: number;
  private ownerHash: Promise<string> | undefined;
  private current: Connection | undefined;
  private readingBodies = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    super(ctx, env);
    const timeout = Number(this.env.RELAY_TIMEOUT_MS ?? "65000");
    this.timeout = Number.isFinite(timeout) && timeout >= 1 && timeout <= 65_000 ? timeout : 65_000;
    this.sql = this.ctx.storage.sql;

    // All initialization is synchronous. No network I/O or pending HTTP wait
    // belongs inside blockConcurrencyWhile(). SQLite operations are atomic here.
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS relay_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          device_hash TEXT NOT NULL DEFAULT '',
          pair_hash TEXT NOT NULL DEFAULT '',
          pair_expires_at INTEGER NOT NULL DEFAULT 0,
          generation INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO relay_state (id) VALUES (1);
        CREATE TABLE IF NOT EXISTS rate_limits (
          key TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits (expires_at);
      `);
    });

    // Hibernation preserves sockets and their attachments, not JS fields.
    // Generation is also persisted so a revoked or replaced socket cannot be
    // selected on wake-up, even while its close handshake is unfinished.
    const state = this.state();
    for (const socket of this.ctx.getWebSockets(DEVICE_TAG)) {
      const attachment = attachmentOf(socket);
      if (state.device_hash && attachment?.generation === state.generation &&
          socket.readyState === WebSocket.OPEN && !this.current) {
        this.current = { socket, generation: attachment.generation };
      } else {
        closeSocket(socket, state.device_hash ? 1001 : 1008, "Connection no longer active");
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (!ownerKeyConfigured(this.env.OWNER_KEY)) return failure(503, "gateway_not_configured");
    const gateway = resolveGatewayOrigin(request.url, this.env.GATEWAY_ORIGIN);
    if (!gateway.ok) return failure(gateway.status, gateway.error);
    const url = new URL(request.url);
    // A request-local value is essential: another alias may enter this same
    // object while authentication/body reading awaits. Never mutate an origin
    // field or persist the origin of an unauthenticated first request.
    const origin = gateway.origin;

    let path: string;
    try {
      // Go's URL.Path is decoded while URL.RawQuery is preserved separately.
      path = decodeURIComponent(url.pathname);
    } catch {
      return failure(400, "invalid_path");
    }
    try {
      if (path === "/admin/status" || path === "/admin/pair" || path === "/admin/revoke") {
        return await this.admin(request, path, origin);
      }
      if (path === "/pair") return await this.pair(request, origin);
      if (path === "/device") return await this.device(request);
      if (relayPath(path)) return await this.proxy(request, path, url.search.slice(1));
      return failure(404, "not_found");
    } catch (error) {
      if (error instanceof RequestFailure) {
        return relayPath(path) ? proxyFailure(path, error.status, error.code) : failure(error.status, error.code);
      }
      // Never log exception messages, URLs, request bodies or credentials.
      console.error(JSON.stringify({ event: "relay_handler_failed", route: routeKind(path) }));
      return relayPath(path) ? proxyFailure(path, 500, "relay_unavailable") : failure(500, "relay_unavailable");
    }
  }

  private state(): StateRow {
    return this.sql.exec<StateRow>(
      "SELECT device_hash, pair_hash, pair_expires_at, generation FROM relay_state WHERE id = 1",
    ).one();
  }

  private limited(request: Request, category: string, maximum: number): boolean {
    const now = Date.now();
    const key = `${category}:${clientIdentity(request)}`;
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM rate_limits WHERE expires_at <= ?", now);
      const existing = this.sql.exec<{ count: number; expires_at: number }>(
        "SELECT count, expires_at FROM rate_limits WHERE key = ?", key,
      ).toArray()[0];
      if (existing) {
        this.sql.exec("UPDATE rate_limits SET count = count + 1 WHERE key = ?", key);
        return existing.count >= maximum;
      }
      const rows = this.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM rate_limits").one().total;
      if (rows >= 1_024) return true;
      this.sql.exec("INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)", key, now + 60_000);
      return false;
    });
  }

  private async admin(request: Request, path: string, origin: string): Promise<Response> {
    if (request.headers.has("origin") && request.headers.get("origin") !== origin) {
      return failure(403, "access_denied");
    }
    if (this.limited(request, "admin", 60)) return failure(429, "rate_limited", { "Retry-After": "60" });
    const presented = bearer(request);
    if (!ownerKeyConfigured(this.env.OWNER_KEY)) return failure(503, "owner_key_unavailable");
    this.ownerHash ??= digest(this.env.OWNER_KEY);
    const [actual, expected] = await Promise.all([digest(presented), this.ownerHash]);
    if (!presented || !sameHash(actual, expected)) {
      return failure(401, "invalid_owner_key", { "WWW-Authenticate": "Bearer" });
    }
    if (path === "/admin/status") {
      if (request.method !== "GET") return failure(405, "method_not_allowed", { Allow: "GET" });
      const state = this.state();
      return json({
        paired: Boolean(state.device_hash),
        online: Boolean(this.connection()),
        gateway: origin,
        mcpUrl: `${origin}/mcp`,
        protocol: PROTOCOL,
        version: GATEWAY_VERSION,
        pairingExpiresAt: state.pair_hash && state.pair_expires_at > Date.now() ? state.pair_expires_at : null,
      });
    }
    if (request.method !== "POST") return failure(405, "method_not_allowed", { Allow: "POST" });
    if (path === "/admin/revoke") {
      this.revoke();
      return json({ ok: true });
    }

    const code = secret(12); // 16 URL-safe characters, matching the upstream UI.
    const codeHash = await digest(code);
    const expiresAt = Date.now() + PAIR_LIFETIME;
    const created = this.ctx.storage.transactionSync(() => {
      if (this.state().device_hash) return false;
      this.sql.exec("UPDATE relay_state SET pair_hash = ?, pair_expires_at = ? WHERE id = 1", codeHash, expiresAt);
      return true;
    });
    if (!created) return failure(409, "already_paired");
    return json({ code, expiresAt, gateway: origin, mcpUrl: `${origin}/mcp` });
  }

  private async pair(request: Request, origin: string): Promise<Response> {
    if (request.method !== "POST") return failure(405, "method_not_allowed", { Allow: "POST" });
    if (request.headers.has("origin") || this.limited(request, "pair", 5)) return failure(403, "access_denied");
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readBody(request, 16_384)));
    } catch (error) {
      if (error instanceof RequestFailure && error.code !== "body_too_large") throw error;
      return failure(400, "invalid_request");
    }
    if (!isRecord(input) || Object.keys(input).length !== 1 || typeof input.code !== "string" ||
        input.code.length < 8 || input.code.length > 64) return failure(400, "invalid_request");
    const deviceToken = secret();
    const [codeHash, deviceHash] = await Promise.all([digest(input.code), digest(deviceToken)]);
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.state();
      if (state.pair_expires_at <= Date.now() || !sameHash(codeHash, state.pair_hash)) return "invalid";
      if (state.device_hash) return "paired";
      this.sql.exec(`UPDATE relay_state SET device_hash = ?, pair_hash = '', pair_expires_at = 0,
        generation = generation + 1 WHERE id = 1`, deviceHash);
      return "ok";
    });
    if (result === "invalid") return failure(403, "invalid_pairing_code");
    if (result === "paired") return failure(409, "pairing_unavailable");
    // Kotlin uses strict JSON parsing. Do not add device IDs or other fields.
    return json({ deviceToken, mcpUrl: `${origin}/mcp` });
  }

  private async device(request: Request): Promise<Response> {
    if (request.headers.has("origin")) return failure(401, "invalid_device_token");
    const token = bearer(request);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return failure(401, "invalid_device_token");
    const tokenHash = await digest(token);
    if (!sameHash(tokenHash, this.state().device_hash)) return failure(401, "invalid_device_token");
    if (request.method === "DELETE") {
      if (!this.revoke(tokenHash)) return failure(401, "invalid_device_token");
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET") return failure(405, "method_not_allowed", { Allow: "GET, DELETE" });
    if (this.limited(request, "device", 60)) return failure(429, "rate_limited", { "Retry-After": "60" });
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()) ?? [];
    if (!protocols.includes(PROTOCOL)) return failure(426, "update_phone_and_gateway");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return failure(400, "invalid_websocket_request");

    // No await between credential recheck, generation update and replacement.
    // The persisted generation uniquely names a connection, not just a token.
    const generation = this.ctx.storage.transactionSync(() => {
      if (!sameHash(tokenHash, this.state().device_hash)) return null;
      return this.sql.exec<{ generation: number }>(
        "UPDATE relay_state SET generation = generation + 1 WHERE id = 1 RETURNING generation",
      ).one().generation;
    });
    if (generation === null) return failure(401, "invalid_device_token");
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [DEVICE_TAG]);
    server.serializeAttachment({ version: 1, generation } satisfies DeviceAttachment);
    const previous = this.current;
    this.current = { socket: server, generation };
    if (previous) this.disconnect(previous, 1001, "Replaced by new connection");
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": PROTOCOL },
    });
  }

  private revoke(expectedHash?: string): boolean {
    const revoked = this.ctx.storage.transactionSync(() => {
      if (expectedHash && !sameHash(expectedHash, this.state().device_hash)) return false;
      this.sql.exec(`UPDATE relay_state SET device_hash = '', pair_hash = '', pair_expires_at = 0,
        generation = generation + 1 WHERE id = 1`);
      return true;
    });
    if (!revoked) return false;
    if (this.current) this.disconnect(this.current, 1008, "Device revoked");
    for (const socket of this.ctx.getWebSockets(DEVICE_TAG)) closeSocket(socket, 1008, "Device revoked");
    return true;
  }

  private connection(): Connection | undefined {
    const current = this.current;
    if (!current) return undefined;
    const state = this.state();
    if (!state.device_hash || current.generation !== state.generation || current.socket.readyState !== WebSocket.OPEN) {
      this.disconnect(current, 1001, "Connection unavailable");
      return undefined;
    }
    return current;
  }

  private async proxy(request: Request, path: string, query: string): Promise<Response> {
    if (this.limited(request, "relay", 240)) return proxyFailure(path, 429, "rate_limited", { "Retry-After": "60" });
    if (!["GET", "POST", "DELETE"].includes(request.method)) {
      return proxyFailure(path, 405, "method_not_allowed", { Allow: "GET, POST, DELETE" });
    }
    if (encoder.encode(query).byteLength > 8_192) return proxyFailure(path, 414, "query_too_large");
    if (/[#\r\n]/.test(query)) return proxyFailure(path, 400, "invalid_query");
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase();
      if (REQUEST_HEADERS.has(lower)) headers[lower] = value;
    }
    if (!validHeaders(headers)) return proxyFailure(path, 400, "invalid_headers");
    // Bound body readers as well as dispatched calls: otherwise concurrent
    // unauthenticated 1 MiB uploads could exhaust a Worker before the WS cap.
    if (this.pending.size + this.readingBodies >= MAX_PENDING) return proxyFailure(path, 429, "device_busy");
    let body: Uint8Array<ArrayBuffer>;
    this.readingBodies++;
    try {
      body = await readBody(request, MAX_BODY);
    } finally {
      this.readingBodies--;
    }
    const connection = this.connection();
    if (!connection) return proxyFailure(path, 503, "device_offline");
    if (this.pending.size >= MAX_PENDING) return proxyFailure(path, 429, "device_busy");
    if (request.signal.aborted) return proxyFailure(path, 504, "delivery_unknown");
    const id = secret();
    const frame = JSON.stringify({
      type: "request", id, method: request.method, path, query, headers,
      body: base64(body), client: clientIdentity(request),
    });
    if (encoder.encode(frame).byteLength > MAX_FRAME) return proxyFailure(path, 414, "request_too_large");

    // Only this in-flight request keeps the object awake. Native WS ping/pong is
    // handled by Cloudflare, with no interval or application-level ping frame.
    return new Promise<Response>((resolve) => {
      const cancel = () => {
        if (!this.pending.has(id)) return;
        this.finish(id, proxyFailure(path, 504, "delivery_unknown"));
        if (this.current?.generation === connection.generation && connection.socket.readyState === WebSocket.OPEN) {
          try {
            connection.socket.send(JSON.stringify({ type: "cancel", id }));
          } catch {
            this.disconnect(connection, 1011, "Connection unavailable");
          }
        }
      };
      const timer = setTimeout(cancel, this.timeout);
      this.pending.set(id, {
        generation: connection.generation, path, resolve, timer,
        signal: request.signal, abort: cancel,
      });
      request.signal.addEventListener("abort", cancel, { once: true });
      try {
        connection.socket.send(frame);
      } catch {
        this.disconnect(connection, 1011, "Connection unavailable");
      }
    });
  }

  private finish(id: string, response: Response): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(response);
  }

  private disconnect(connection: Connection, code: number, reason: string): void {
    if (this.current?.generation === connection.generation) this.current = undefined;
    for (const [id, pending] of this.pending) {
      if (pending.generation === connection.generation) this.finish(id, proxyFailure(pending.path, 502, "delivery_unknown"));
    }
    closeSocket(connection.socket, code, reason);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = attachmentOf(socket);
    const current = this.connection();
    if (!current || attachment?.generation !== current.generation) {
      closeSocket(socket, 1001, "Connection no longer active");
      return;
    }
    const response = parseResponse(message);
    if (!response) {
      this.disconnect(current, 1008, "Invalid relay message");
      return;
    }
    const pending = this.pending.get(response.id);
    // Late replies to a cancelled wait are harmless, but can never match a new
    // connection: IDs are random and the persisted generation must also match.
    if (!pending || pending.generation !== current.generation) return;
    this.finish(response.id, new Response(response.body.byteLength ? response.body : null, {
      status: response.status,
      headers: response.headers,
    }));
  }

  webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    const attachment = attachmentOf(socket);
    if (attachment && this.current?.generation === attachment.generation) {
      this.disconnect(this.current, 1000, "Connection closed");
    } else {
      closeSocket(socket, 1000, "Connection closed");
    }
  }

  webSocketError(socket: WebSocket, _error: unknown): void {
    const attachment = attachmentOf(socket);
    if (attachment && this.current?.generation === attachment.generation) {
      this.disconnect(this.current, 1011, "Connection unavailable");
    } else {
      closeSocket(socket, 1011, "Connection unavailable");
    }
  }
}

function attachmentOf(socket: WebSocket): DeviceAttachment | undefined {
  try {
    const value: unknown = socket.deserializeAttachment();
    if (isRecord(value) && value.version === 1 && typeof value.generation === "number" &&
        Number.isSafeInteger(value.generation) && value.generation > 0) {
      return { version: 1, generation: value.generation };
    }
  } catch { /* A malformed attachment is never an authenticated connection. */ }
  return undefined;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try { socket.close(code, reason); } catch { /* Already closed. */ }
}

function parseResponse(message: string | ArrayBuffer): PhoneResponse | undefined {
  try {
    if (typeof message !== "string" || message.length > MAX_FRAME || encoder.encode(message).byteLength > MAX_FRAME) return;
    const frame: unknown = JSON.parse(message);
    if (!isRecord(frame) || Object.keys(frame).some((key) => !FRAME_FIELDS.has(key)) || frame.type !== "response" ||
        typeof frame.id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(frame.id) ||
        typeof frame.status !== "number" || !Number.isInteger(frame.status) || frame.status < 200 || frame.status > 599) return;
    for (const field of ["method", "path", "query", "client"]) {
      if (frame[field] !== undefined && frame[field] !== "") return;
    }
    const sourceHeaders = frame.headers ?? {};
    if (!isRecord(sourceHeaders) || !validHeaders(sourceHeaders)) return;
    const body = decodeBase64(frame.body === undefined ? "" : frame.body);
    if (!body || ([204, 205, 304].includes(frame.status) && body.byteLength !== 0)) return;
    const headers = new Headers();
    const seen = new Set<string>();
    for (const [name, value] of Object.entries(sourceHeaders)) {
      const lower = name.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      // Match Go's response allowlist, including dropping Set-Cookie, CORS and
      // transport headers. Even ignored headers must pass syntax/size checks.
      if (RESPONSE_HEADERS.has(lower) && typeof value === "string") headers.set(lower, value);
    }
    return { id: frame.id, status: frame.status, headers, body };
  } catch { return; }
}

function validHeaders(headers: Record<string, unknown>): boolean {
  const entries = Object.entries(headers);
  if (entries.length > 16) return false;
  let total = 0;
  for (const [name, value] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== "string" ||
        /[\x00-\x08\x0A-\x1F\x7F]/.test(value)) return false;
    total += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
    if (total > MAX_HEADERS) return false;
  }
  return true;
}

async function readBody(request: Request, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    throw new RequestFailure(413, "body_too_large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 20_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) throw new RequestFailure(408, "request_timeout");
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        void reader.cancel().catch(() => undefined);
        throw new RequestFailure(413, "body_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestFailure) throw error;
    throw new RequestFailure(400, "invalid_request");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function decodeBase64(value: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(MAX_BODY / 3) || value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return;
  const binary = atob(value);
  if (binary.length > MAX_BODY || btoa(binary) !== value) return;
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result;
}

function secret(bytes = 32): string {
  return base64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function digest(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameHash(candidate: string, expected: string): boolean {
  return expected.length === 64 && candidate.length === 64 &&
    crypto.subtle.timingSafeEqual(encoder.encode(candidate), encoder.encode(expected));
}

function bearer(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  if (value.length > MAX_HEADERS || value.slice(0, 7).toLowerCase() !== "bearer ") return "";
  return value.slice(7).trim();
}

/** Only the Cloudflare ingress identity is used, never caller-supplied XFF. */
function clientIdentity(request: Request): string {
  const value = request.headers.get("cf-connecting-ip") ?? "";
  const ipv4 = parseIPv4(value);
  if (ipv4) return ipv4.join(".");
  if (!value.includes(":") || value.length > 64 || !/^[0-9a-fA-F:.]+$/.test(value)) return "";
  let ipv6 = value;
  if (ipv6.includes(".")) {
    const split = ipv6.lastIndexOf(":");
    const tail = parseIPv4(ipv6.slice(split + 1));
    if (!tail) return "";
    ipv6 = `${ipv6.slice(0, split)}:${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`;
  }
  const halves = ipv6.split("::");
  if (halves.length > 2) return "";
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return "";
  const missing = 8 - left.length - right.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) return "";
  const groups = [...left.map((part) => parseInt(part, 16)), ...Array<number>(missing).fill(0), ...right.map((part) => parseInt(part, 16))];
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  // Group a subscriber's IPv6 addresses by /64, matching the Go gateway.
  const prefix = [...groups.slice(0, 4), 0, 0, 0, 0];
  let bestStart = 0;
  let bestLength = 0;
  for (let i = 0; i < prefix.length;) {
    if (prefix[i] !== 0) { i++; continue; }
    const start = i;
    while (i < prefix.length && prefix[i] === 0) i++;
    if (i - start > bestLength) { bestStart = start; bestLength = i - start; }
  }
  const before = prefix.slice(0, bestStart).map((part) => part.toString(16)).join(":");
  const after = prefix.slice(bestStart + bestLength).map((part) => part.toString(16)).join(":");
  return `${before}::${after}/64`;
}

function parseIPv4(value: string): number[] | undefined {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 255)) return;
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function relayPath(path: string): boolean {
  return path === "/mcp" || path === "/api/v1" || path.startsWith("/api/v1/");
}

function routeKind(path: string): string {
  return path.startsWith("/api/v1") ? "api" : path.startsWith("/admin/") ? "admin" : path === "/device" ? "device" : path === "/pair" ? "pair" : "mcp";
}

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(status: number, code: string, extra?: HeadersInit): Response {
  return json({ error: code }, status, extra);
}

function proxyFailure(path: string, status: number, code: string, extra?: HeadersInit): Response {
  return path === "/mcp" ? failure(status, code, extra) : json({ error: { code, message: code } }, status, extra);
}
