/* SPDX-License-Identifier: Apache-2.0
 * Explicit opt-in live gateway smoke test. Refuses an already paired gateway.
 * Reads deployment credentials from a private file, never from argv values.
 * No real Android phone, model call, or phone action is used by this test.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';

const PHASES = new Set([
  'arguments', 'read_configuration', 'parse_configuration', 'proxy_configuration',
  'public_health', 'management_page_and_csp', 'administrator_auth_required', 'require_unpaired_gateway',
  'create_pairing_code', 'apk_pairing_contract', 'websocket_subprotocol', 'phone_response',
  'native_websocket_ping_pong', 'http_to_phone_to_http', 'same_socket_after_12_seconds_idle',
  'revoke_closes_live_websocket', 'old_device_token_rejected', 'offline_error_without_queue',
  'ready_for_user_pairing', 'cleanup', 'write_report',
]);
const SAFE_CATEGORIES = new Set([
  'configuration_required', 'configuration_read_failed', 'invalid_configuration', 'invalid_gateway_origin',
  'invalid_owner_key', 'invalid_proxy_configuration', 'gateway_already_paired', 'response_too_large',
  'http_timeout', 'websocket_timeout', 'report_write_failed',
]);
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EPROTO',
  'ERR_INVALID_PROTOCOL', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

class LiveFailure extends Error {
  constructor(category) { super(category); this.category = category; }
}

/** Never serialize error.message, stack, actual/expected, request objects, or input-derived phases. */
export function safeDiagnostic(error, phase) {
  let category = 'unexpected_error';
  if (error instanceof LiveFailure && SAFE_CATEGORIES.has(error.category)) category = error.category;
  else if (error?.code === 'ERR_ASSERTION') category = 'assertion_failed';
  else if (TRANSPORT_CODES.has(error?.code)) category = 'transport_error';
  else if (error instanceof SyntaxError) category = 'invalid_json';
  return { phase: PHASES.has(phase) ? phase : 'unknown_phase', category };
}

async function bounded(promise, milliseconds, category) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new LiveFailure(category)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function runLiveSmoke(file) {
  // Reports intentionally omit the deployment origin and personal timestamps.
  const result = { protocol: 'mika-relay.v2', checks: [], phone: 'simulated', receivedRequests: 0, passed: false };
  let phase = 'arguments';
  let origin;
  let ownerKey;
  let agent;
  let deviceToken;
  let socket;
  let socketClosed;
  let listenerDiagnostic;

  function check(name) { result.checks.push({ name, passed: true }); }
  async function request(path, { method = 'GET', token, json, headers = {} } = {}) {
    const body = json === undefined ? undefined : JSON.stringify(json);
    return await new Promise((resolveRequest, reject) => {
      const req = httpsRequest(new URL(path, origin), {
        method, agent,
        headers: {
          ...headers,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      }, res => {
        const parts = [];
        let length = 0;
        res.on('data', part => {
          length += part.length;
          if (length > 2_000_000) req.destroy(new LiveFailure('response_too_large'));
          else parts.push(part);
        });
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let data; try { data = JSON.parse(text); } catch { data = null; }
          resolveRequest({ status: res.statusCode, headers: res.headers, text, data });
        });
      });
      req.setTimeout(15_000, () => req.destroy(new LiveFailure('http_timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }

  try {
    if (!file) throw new LiveFailure('configuration_required');
    phase = 'read_configuration';
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch { throw new LiveFailure('configuration_read_failed'); }
    phase = 'parse_configuration';
    let input;
    try { input = JSON.parse(text); }
    catch { throw new LiveFailure('invalid_configuration'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LiveFailure('invalid_configuration');
    let url;
    try { url = new URL(input.origin); }
    catch { throw new LiveFailure('invalid_gateway_origin'); }
    if (typeof input.origin !== 'string' || url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new LiveFailure('invalid_gateway_origin');
    if (typeof input.ownerKey !== 'string' || input.ownerKey.length < 32) throw new LiveFailure('invalid_owner_key');
    origin = url.origin;
    ownerKey = input.ownerKey;
    phase = 'proxy_configuration';
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    try { agent = proxy ? new HttpsProxyAgent(proxy) : undefined; }
    catch { throw new LiveFailure('invalid_proxy_configuration'); }

    phase = 'public_health';
    let r = await request('/healthz');
    assert.equal(r.status, 200); assert.equal(r.data.status, 'ok');
    check(phase);
    phase = 'management_page_and_csp';
    r = await request('/');
    assert.equal(r.status, 200); assert.ok(r.text.includes('Mika')); assert.ok(r.headers['content-security-policy']);
    check(phase);
    phase = 'administrator_auth_required';
    r = await request('/admin/status'); assert.equal(r.status, 401);
    check(phase);
    phase = 'require_unpaired_gateway';
    r = await request('/admin/status', { token: ownerKey });
    assert.equal(r.status, 200);
    if (r.data.paired) throw new LiveFailure('gateway_already_paired');
    phase = 'create_pairing_code';
    r = await request('/admin/pair', { method: 'POST', token: ownerKey, json: {} });
    assert.equal(r.status, 200); assert.match(r.data.code, /^[A-Za-z0-9_-]{16}$/);
    phase = 'apk_pairing_contract';
    r = await request('/pair', { method: 'POST', json: { code: r.data.code } });
    assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.data).sort(), ['deviceToken', 'mcpUrl']);
    assert.match(r.data.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    deviceToken = r.data.deviceToken;
    assert.equal(r.data.mcpUrl, origin + '/mcp');
    check(phase);
    phase = 'websocket_subprotocol';
    socket = new WebSocket(origin.replace(/^https:/, 'wss:') + '/device', 'mika-relay.v2', {
      agent, headers: { Authorization: `Bearer ${deviceToken}` }, handshakeTimeout: 15_000,
    });
    socketClosed = new Promise(resolveClose => socket.once('close', code => resolveClose(code)));
    socket.on('error', error => { listenerDiagnostic ??= safeDiagnostic(error, phase); });
    await bounded(new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject); }), 15_000, 'websocket_timeout');
    assert.equal(socket.protocol, 'mika-relay.v2');
    socket.on('message', (raw, binary) => {
      try {
        assert.equal(binary, false);
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'cancel') return;
        assert.equal(frame.type, 'request');
        assert.match(frame.id, /^[A-Za-z0-9_-]{16,64}$/);
        assert.equal(frame.headers.authorization, 'Bearer simulated-phone-access-token');
        result.receivedRequests++;
        socket.send(JSON.stringify({ type: 'response', id: frame.id, status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ ok: true, peer: 'simulated-phone', method: frame.method, path: frame.path })).toString('base64') }));
      } catch (error) {
        listenerDiagnostic ??= safeDiagnostic(error, 'phone_response');
        socket.close(1000, 'test failed');
      }
    });
    check(phase);
    phase = 'native_websocket_ping_pong';
    const pong = new Promise(resolvePong => socket.once('pong', resolvePong));
    socket.ping('mika-smoke');
    await bounded(pong, 5_000, 'websocket_timeout');
    check(phase);
    phase = 'http_to_phone_to_http';
    r = await request('/api/v1/tasks', { method: 'POST', token: 'simulated-phone-access-token', json: { goal: 'simulation only' } });
    assert.equal(r.status, 200); assert.equal(r.data.peer, 'simulated-phone'); assert.equal(r.data.path, '/api/v1/tasks');
    check(phase);
    phase = 'same_socket_after_12_seconds_idle';
    // No business traffic during this interval; physical eviction is platform controlled.
    await new Promise(resolveIdle => setTimeout(resolveIdle, 12_000));
    r = await request('/mcp', { method: 'POST', token: 'simulated-phone-access-token', json: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    assert.equal(r.status, 200); assert.equal(r.data.path, '/mcp'); assert.equal(result.receivedRequests, 2);
    check(phase);
    phase = 'revoke_closes_live_websocket';
    r = await request('/device', { method: 'DELETE', token: deviceToken }); assert.equal(r.status, 204);
    const closeCode = await bounded(socketClosed, 8_000, 'websocket_timeout');
    assert.equal(closeCode, 1008);
    result.checks.push({ name: phase, passed: true, closeCode: 1008 });
    phase = 'old_device_token_rejected';
    r = await request('/device', { method: 'DELETE', token: deviceToken }); assert.equal(r.status, 401);
    check(phase);
    deviceToken = undefined;
    phase = 'offline_error_without_queue';
    r = await request('/api/v1/tasks', { token: 'simulated-phone-access-token' });
    assert.equal(r.status, 503); assert.equal(r.data.error.code, 'device_offline');
    check(phase);
    phase = 'ready_for_user_pairing';
    r = await request('/admin/status', { token: ownerKey });
    assert.equal(r.data.paired, false); assert.equal(r.data.online, false);
    check(phase);
    if (listenerDiagnostic) result.error = listenerDiagnostic;
    else result.passed = true;
  } catch (error) {
    // AssertionError can embed a pairing code, device token, Authorization
    // value, or response body in its message. Report only closed-set metadata.
    result.error = listenerDiagnostic ?? safeDiagnostic(error, phase);
  } finally {
    if (deviceToken) {
      try { const cleanup = await request('/device', { method: 'DELETE', token: deviceToken }); result.cleanupStatus = cleanup.status; }
      catch (error) { result.cleanupError = safeDiagnostic(error, 'cleanup'); }
    }
    socket?.terminate();
    try {
      await mkdir('test-results', { recursive: true });
      await writeFile('test-results/live-validation.json', JSON.stringify(result, null, 2));
    } catch {
      result.passed = false;
      result.reportError = safeDiagnostic(new LiveFailure('report_write_failed'), 'write_report');
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runLiveSmoke(process.argv[2]);
  process.exitCode = result.passed ? 0 : 1;
}
