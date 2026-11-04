/* SPDX-License-Identifier: Apache-2.0
 * Black-box integration tests for the Mika v0.1.35 mika-relay.v2 wire contract.
 * The phone below is a protocol peer, not an Android device or a model agent.
 * Contract sources: vendor/mika/{tools__relay__gateway.go,
 * core__src__main__kotlin__com__wangzan101__mika__core__remote__RelayClient.kt,
 * core__src__main__kotlin__com__wangzan101__mika__core__remote__RelayGateway.kt}.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import WebSocket from 'ws';

const ORIGIN = 'https://relay.test';
const OWNER_KEY = 'integration-test-owner-key-at-least-32-characters';
const PHONE_ACCESS = 'independent-phone-access-token';
const PROTOCOL = 'mika-relay.v2';
const MAX_BODY = 1_048_576;
const MAX_FRAME = 2 * MAX_BODY;
const SCRIPT = fileURLToPath(new URL('../dist/worker.js', import.meta.url));
const WIRE_FIELDS = new Set(['type', 'id', 'method', 'path', 'query', 'headers', 'body', 'status', 'client']);
const REQUEST_HEADERS = new Set(['authorization', 'origin', 'x-mika-client', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id', 'last-event-id']);

async function deadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class Phone {
  constructor(socket, { native = false } = {}) {
    this.socket = socket;
    this.native = native;
    this.queue = [];
    this.waiters = [];
    this.received = [];
    this.closedEvent = null;
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        this.closedEvent = { code: event.code, reason: event.reason };
        resolve(this.closedEvent);
      });
    });
    if (native) {
      // Miniflare 5 can deliver/acknowledge CLOSE but delay TCP FIN and its
      // response.webSocket "close" event until disposal. OkHttp's onClosing
      // runs on the control frame, before TCP FIN, so observe that exact event.
      // This deliberately uses ws's private receiver and depends on the pinned
      // ws version in package-lock.json; fail visibly if that interface changes.
      assert.ok(socket._receiver?.once, 'The pinned ws receiver must expose control-frame events');
      this.closeControl = new Promise((resolve) => {
        socket._receiver.once('conclude', (code, reason) => resolve({ code, reason: reason.toString() }));
      });
    }
    socket.addEventListener('message', (event) => {
      this.received.push(event.data);
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(event.data);
      } else {
        this.queue.push(event.data);
      }
    });
    // Install listeners before accepting so the first forwarded frame cannot race them.
    if (!native) socket.accept();
  }

  async next(milliseconds = 3_000) {
    const raw = this.queue.length ? this.queue.shift() : await new Promise((resolve, reject) => {
      const waiter = { resolve, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Timed out waiting for a relay frame'));
      }, milliseconds);
      this.waiters.push(waiter);
    });
    assert.equal(typeof raw, 'string', 'Mika accepts text WebSocket messages only');
    return JSON.parse(raw);
  }

  sendRaw(value) { this.socket.send(value); }
  send(value) { this.sendRaw(JSON.stringify(value)); }

  respond(request, { status = 200, body = '', headers = {} } = {}) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const response = { type: 'response', id: request.id, status };
    if (bytes.length) response.body = bytes.toString('base64');
    if (Object.keys(headers).length) response.headers = headers;
    this.send(response);
  }

  close(code = 1000, reason = 'test completed') {
    try { this.socket.close(code, reason); } catch { /* already closed */ }
  }

  waitForClose() { return deadline(this.closed, 3_000, 'Relay did not close the phone connection'); }
  waitForCloseControl() {
    assert.ok(this.native, 'Control-frame observation requires a native ws peer');
    return deadline(this.closeControl, 3_000, 'Relay did not send a WebSocket CLOSE control frame');
  }

  dispose() {
    if (this.native) this.socket.terminate();
    else this.close();
  }

  async assertQuiet(milliseconds = 60) {
    const count = this.received.length;
    assert.equal(this.queue.length, 0, 'Unexpected queued frame (possible replay)');
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    assert.equal(this.received.length, count, 'Unexpected frame (possible replay)');
  }
}

async function fixture(t, fixtureOptions = {}) {
  const { timeoutMs = 5_000, persist = false, requestOrigin = ORIGIN } = fixtureOptions;
  const expectedOrigin = new URL(requestOrigin).origin;
  const configuredOrigin = Object.hasOwn(fixtureOptions, 'gatewayOrigin') ? fixtureOptions.gatewayOrigin : ORIGIN;
  const ownerKey = Object.hasOwn(fixtureOptions, 'ownerKey') ? fixtureOptions.ownerKey : OWNER_KEY;
  const options = {
    name: 'mika-relay-test',
    modules: true,
    scriptPath: SCRIPT,
    compatibilityDate: '2026-11-03',
    compatibilityFlags: ['nodejs_compat'],
    cf: false,
    bindings: {
      ...(ownerKey !== undefined ? { OWNER_KEY: ownerKey } : {}),
      ...(configuredOrigin !== undefined ? { GATEWAY_ORIGIN: configuredOrigin } : {}),
      RELAY_TIMEOUT_MS: String(timeoutMs),
    },
    durableObjects: { RELAY: { className: 'MikaRelay', useSQLite: true } },
    ...(persist ? { resourcePersistencePath: persist } : {}),
    telemetry: { enabled: false },
  };
  // Use Miniflare 5's official adapter for the classic Worker binding options.
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const phones = [];
  let disposed = false;
  const f = {
    mf,
    origin: expectedOrigin,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const phone of phones) phone.dispose();
      await mf.dispose();
    },
    request(path, options = {}) {
      const { token, json, ip = '198.51.100.7', ...init } = options;
      const headers = new Headers(options.headers);
      if (ip !== null && !headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', ip);
      if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
      if (Object.hasOwn(options, 'json')) {
        headers.set('Content-Type', 'application/json');
        init.body = JSON.stringify(json);
      }
      const pending = mf.dispatchFetch(new URL(path, requestOrigin), { ...init, headers });
      // A failed assertion can dispose the runtime before an in-flight request finishes.
      // Attach a rejection observer without changing the promise the test awaits.
      pending.catch(() => {});
      return pending;
    },
    owner(path, options = {}) { return f.request(path, { token: ownerKey ?? OWNER_KEY, ...options }); },
    async status() { return jsonResponse(await f.owner('/admin/status'), 200); },
    async mint() {
      const before = Date.now();
      const result = await jsonResponse(await f.owner('/admin/pair', { method: 'POST', json: {} }), 200);
      assert.match(result.code, /^[A-Za-z0-9_-]{8,64}$/, 'Code must be acceptable to RelayGateway.pair');
      assert.equal(typeof result.expiresAt, 'number');
      assert.ok(result.expiresAt > before && result.expiresAt <= Date.now() + 6 * 60_000, 'Pairing code has a short, absolute millisecond expiry');
      assert.equal(result.gateway, expectedOrigin);
      assert.equal(result.mcpUrl, `${expectedOrigin}/mcp`);
      return result;
    },
    async redeem(code) {
      const response = await f.request('/pair', { method: 'POST', json: { code } });
      const result = await jsonResponse(response, 200);
      // kotlinx.serialization's default Json rejects additional PairResponse fields.
      assert.deepEqual(Object.keys(result).sort(), ['deviceToken', 'mcpUrl']);
      assert.match(result.deviceToken, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(result.mcpUrl, `${expectedOrigin}/mcp`);
      assert.notEqual(result.deviceToken, OWNER_KEY);
      assert.notEqual(result.deviceToken, PHONE_ACCESS);
      return result;
    },
    async pair() {
      const invitation = await f.mint();
      return { ...await f.redeem(invitation.code), code: invitation.code };
    },
    async connect(deviceToken, { protocol = PROTOCOL, headers = {}, native = false } = {}) {
      if (native) {
        const local = new URL('/device', await mf.ready);
        local.protocol = local.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(local, protocol.split(',').map((value) => value.trim()), {
          headers: {
            Authorization: `Bearer ${deviceToken}`,
            'CF-Connecting-IP': '198.51.100.7',
            // This is Miniflare's own transport envelope, also set internally by
            // dispatchFetch. The production Worker has no test-only header path.
            'MF-Original-URL': `${expectedOrigin}/device`,
            ...headers,
          },
        });
        try {
          await deadline(once(socket, 'open'), 3_000, 'Native phone did not upgrade');
        } catch (error) {
          socket.terminate();
          throw error;
        }
        assert.equal(socket.protocol, PROTOCOL);
        const phone = new Phone(socket, { native: true });
        phones.push(phone);
        return phone;
      }
      const response = await f.request('/device', {
        token: deviceToken,
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocol, ...headers },
      });
      assert.equal(response.status, 101, 'Phone must upgrade successfully');
      assert.equal(response.headers.get('Sec-WebSocket-Protocol'), PROTOCOL, 'APK checks the selected subprotocol exactly');
      assert.ok(response.webSocket, 'Upgrade must preserve the WebSocket through the entry Worker');
      const phone = new Phone(response.webSocket);
      phones.push(phone);
      return phone;
    },
  };
  t.after(() => f.dispose());
  await mf.ready;
  return f;
}

async function jsonResponse(response, expectedStatus) {
  const body = await response.text();
  assert.equal(response.status, expectedStatus, `Unexpected HTTP status; response: ${body.slice(0, 400)}`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  return JSON.parse(body);
}

async function relayError(response, expectedStatus, expectedCode, api = true) {
  const body = await jsonResponse(response, expectedStatus);
  if (api) {
    assert.equal(body.error?.code, expectedCode);
    assert.equal(typeof body.error?.message, 'string');
  } else {
    assert.equal(body.error, expectedCode);
  }
}

function checkRequest(frame) {
  assert.equal(frame.type, 'request');
  assert.match(frame.id, /^[A-Za-z0-9_-]{16,64}$/);
  for (const key of Object.keys(frame)) assert.ok(WIRE_FIELDS.has(key), `APK rejects unknown RelayFrame key ${key}`);
  assert.ok(['GET', 'POST', 'DELETE'].includes(frame.method));
  assert.ok(frame.path === '/mcp' || frame.path === '/api/v1' || frame.path.startsWith('/api/v1/'));
  assert.equal(frame.status ?? 0, 0);
  assert.match(frame.client ?? '', /^[0-9A-Fa-f.:/]{0,64}$/);
  assert.equal(typeof (frame.query ?? ''), 'string');
  assert.ok(!/[#\r\n]/.test(frame.query ?? ''));
  assert.ok(Buffer.byteLength(frame.query ?? '') <= 8192);
  for (const [key, value] of Object.entries(frame.headers ?? {})) {
    assert.ok(REQUEST_HEADERS.has(key), `APK rejects header ${key}`);
    assert.equal(typeof value, 'string');
    assert.ok(!/[\r\n]/.test(value));
  }
  const encoded = frame.body ?? '';
  assert.equal(typeof encoded, 'string');
  const bytes = Buffer.from(encoded, 'base64');
  assert.equal(bytes.toString('base64'), encoded, 'Wire body must use canonical standard Base64');
  assert.ok(bytes.length <= MAX_BODY);
  return bytes;
}

test('pairing is strict-JSON compatible, single-use, and cannot replace a paired phone', async (t) => {
  const f = await fixture(t);
  const initial = await f.status();
  assert.equal(initial.paired, false);
  assert.equal(initial.online, false);
  assert.equal(initial.gateway, ORIGIN);
  assert.equal(initial.mcpUrl, `${ORIGIN}/mcp`);
  assert.equal(initial.protocol, PROTOCOL);
  assert.equal(typeof initial.version, 'string');
  assert.ok(initial.pairingExpiresAt === null || initial.pairingExpiresAt === 0);

  const old = await f.mint();
  const current = await f.mint();
  assert.notEqual(current.code, old.code);
  assert.equal((await f.request('/pair', { method: 'POST', json: { code: old.code } })).status, 403);
  await f.redeem(current.code);
  assert.equal((await f.request('/pair', { method: 'POST', json: { code: current.code } })).status, 403);
  assert.equal((await f.owner('/admin/pair', { method: 'POST', json: {} })).status, 409);
  const paired = await f.status();
  assert.equal(paired.paired, true);
  assert.equal(paired.online, false);
  assert.ok(paired.pairingExpiresAt === null || paired.pairingExpiresAt === 0);
  assert.ok(!JSON.stringify(paired).includes(current.code));
});

test('concurrent redemptions of one code create exactly one device credential', async (t) => {
  const f = await fixture(t);
  const { code } = await f.mint();
  const responses = await Promise.all([
    f.request('/pair', { method: 'POST', json: { code } }),
    f.request('/pair', { method: 'POST', json: { code } }),
  ]);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  const denied = responses.find((response) => response.status !== 200);
  assert.ok([403, 409].includes(denied.status));
  const issued = await jsonResponse(responses.find((response) => response.status === 200), 200);
  assert.match(issued.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  await f.connect(issued.deviceToken);
});

test('management and device credentials stay separate and browser guards fail closed', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/admin/status')).status, 401);
  assert.equal((await f.owner('/admin/status', { token: 'wrong-owner-key' })).status, 401);
  assert.equal((await f.owner('/admin/pair', { method: 'POST', json: {}, headers: { Origin: 'https://other.example' } })).status, 403);
  const invitation = await jsonResponse(await f.owner('/admin/pair', { method: 'POST', json: {}, headers: { Origin: ORIGIN } }), 200);
  for (const origin of [ORIGIN, 'https://other.example']) {
    assert.equal((await f.request('/pair', { method: 'POST', json: { code: invitation.code }, headers: { Origin: origin } })).status, 403);
  }
  const { deviceToken } = await f.redeem(invitation.code);
  assert.equal((await f.owner('/admin/status', { token: deviceToken })).status, 401);
  for (const token of [undefined, OWNER_KEY, PHONE_ACCESS]) {
    assert.equal((await f.request('/device', { token, headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PROTOCOL } })).status, 401);
  }
  for (const origin of [ORIGIN, 'https://other.example']) {
    assert.equal((await f.request('/device', { token: deviceToken, headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PROTOCOL, Origin: origin } })).status, 401);
  }
  await f.connect(deviceToken);
});

test('WebSocket protocol version is rejected before upgrade and negotiated exactly', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  for (const protocol of [undefined, 'mika-relay.v1', 'mika-relay.v20']) {
    const headers = { Upgrade: 'websocket' };
    if (protocol !== undefined) headers['Sec-WebSocket-Protocol'] = protocol;
    const response = await f.request('/device', { token: deviceToken, headers });
    assert.equal(response.status, 426);
    assert.equal(response.webSocket, null);
  }
  assert.equal((await f.request('/device', { token: deviceToken, headers: { 'Sec-WebSocket-Protocol': PROTOCOL } })).status, 400);
  await f.connect(deviceToken, { protocol: `unrelated,${PROTOCOL}` });
  assert.equal((await f.status()).online, true);
});

test('task HTTP bytes, opaque phone token, and approved metadata round-trip unchanged', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const phone = await f.connect(deviceToken);
  const payload = Buffer.from('{"goal":"查看电池 👋","id":"测试"}\n');
  const request = f.request('/api/v1/tasks?source=remote%20test&label=%E6%B5%8B%E8%AF%95', {
    method: 'POST', token: PHONE_ACCESS, body: payload,
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json', 'X-Mika-Client': 'integration-client',
      'Mcp-Protocol-Version': '2025-11-25', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'mika_run_task',
      'Mcp-Session-Id': 'opaque-session', 'Last-Event-Id': 'opaque-event',
      Cookie: 'secret-cookie=never-forward', 'Proxy-Authorization': 'Basic must-not-forward',
      'X-Forwarded-For': '127.0.0.1', 'X-Not-Allowed': 'drop-me',
    },
  });
  const frame = await phone.next();
  assert.ok(checkRequest(frame).equals(payload));
  assert.equal(frame.method, 'POST');
  assert.equal(frame.path, '/api/v1/tasks');
  assert.equal(frame.query, 'source=remote%20test&label=%E6%B5%8B%E8%AF%95');
  assert.equal(frame.client, '198.51.100.7');
  assert.deepEqual(frame.headers, {
    authorization: `Bearer ${PHONE_ACCESS}`, 'content-type': 'application/json', accept: 'application/json',
    'x-mika-client': 'integration-client', 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/call',
    'mcp-name': 'mika_run_task', 'mcp-session-id': 'opaque-session', 'last-event-id': 'opaque-event',
  });
  const result = '{"task_id":"t1","status":"queued"}';
  phone.respond(frame, {
    status: 201, body: result,
    headers: { 'Content-Type': 'application/json', 'Mcp-Protocol-Version': '2025-11-25', 'Set-Cookie': 'must-not-leak', Location: 'https://other.example', 'X-Internal': 'must-not-leak' },
  });
  const response = await request;
  assert.equal(response.status, 201);
  assert.equal(await response.text(), result);
  assert.equal(response.headers.get('mcp-protocol-version'), '2025-11-25');
  for (const name of ['set-cookie', 'location', 'x-internal']) assert.equal(response.headers.get(name), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('MCP preserves phone authorization decisions and Origin rather than authenticating the phone token at the relay', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const phone = await f.connect(deviceToken);
  for (const token of [undefined, PHONE_ACCESS, deviceToken, OWNER_KEY]) {
    const pending = f.request('/mcp', { method: 'POST', token, json: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { Origin: 'https://browser.example' } });
    const frame = await phone.next();
    checkRequest(frame);
    assert.equal(frame.headers.authorization, token === undefined ? undefined : `Bearer ${token}`);
    assert.equal(frame.headers.origin, 'https://browser.example');
    phone.respond(frame, { status: 403, body: '{"error":"phone_origin_denied"}', headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer', 'retry-after': '30', allow: 'POST' } });
    const response = await pending;
    assert.equal(response.status, 403);
    assert.equal(await response.text(), '{"error":"phone_origin_denied"}');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal(response.headers.get('retry-after'), '30');
    assert.equal(response.headers.get('allow'), 'POST');
  }
});

test('GET, POST, and DELETE preserve raw queries and support bodyless HTTP responses', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const phone = await f.connect(deviceToken);
  for (const method of ['GET', 'POST', 'DELETE']) {
    const pending = f.request('/api/v1/tasks?limit=2&literal=%2f%2F+%20', { method, token: PHONE_ACCESS });
    const frame = await phone.next();
    assert.equal(checkRequest(frame).length, 0);
    assert.equal(frame.method, method);
    assert.equal(frame.query, 'limit=2&literal=%2f%2F+%20');
    phone.respond(frame, { status: 204 });
    const response = await pending;
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  }
});

test('untrusted forwarding headers never invent a privileged phone caller', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const phone = await f.connect(deviceToken);
  // Miniflare supplies its loopback transport address for an absent/empty CF
  // header. An invalid non-empty identity exercises the relay's empty fallback.
  const pending = f.request('/api/v1', { ip: 'not-an-ip', headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' } });
  const frame = await phone.next();
  checkRequest(frame);
  assert.equal(frame.client ?? '', '');
  assert.equal(frame.headers?.['x-forwarded-for'], undefined);
  assert.equal(frame.headers?.['x-real-ip'], undefined);
  phone.respond(frame, { status: 200 });
  assert.equal((await pending).status, 200);
});

test('offline calls fail immediately and are not queued for a subsequent phone connection', async (t) => {
  const f = await fixture(t);
  await relayError(await f.request('/api/v1/tasks', { method: 'POST', json: { goal: 'never queue this' } }), 503, 'device_offline');
  const { deviceToken } = await f.pair();
  await relayError(await f.request('/mcp', { method: 'POST', json: {} }), 503, 'device_offline', false);
  const phone = await f.connect(deviceToken);
  await phone.assertQuiet();
  const pending = f.request('/api/v1/tasks', { method: 'POST', json: { goal: 'new request only' } });
  const frame = await phone.next();
  assert.equal(checkRequest(frame).toString(), '{"goal":"new request only"}');
  phone.respond(frame, { status: 202 });
  assert.equal((await pending).status, 202);
});

test('timeout sends cancellation, reports unknown delivery, ignores late replies, and does not replay', async (t) => {
  const f = await fixture(t, { timeoutMs: 200 });
  const { deviceToken } = await f.pair();
  const phone = await f.connect(deviceToken);
  const pending = f.request('/api/v1/tasks', { method: 'POST', json: { goal: 'a timed-out command' } });
  const frame = await phone.next();
  checkRequest(frame);
  const cancel = await phone.next();
  assert.deepEqual(cancel, { type: 'cancel', id: frame.id });
  await relayError(await pending, 504, 'delivery_unknown');
  phone.respond(frame, { status: 201, body: '{"task_id":"already-created"}' });
  const following = f.request('/api/v1/tasks/already-created');
  const next = await phone.next();
  checkRequest(next);
  assert.notEqual(next.id, frame.id);
  assert.equal(next.path, '/api/v1/tasks/already-created');
  phone.respond(next, { body: '{"status":"done"}', headers: { 'content-type': 'application/json' } });
  assert.equal(await (await following).text(), '{"status":"done"}');
  await phone.assertQuiet();
});

test('disconnect after delivery returns 502 and reconnect never replays the interrupted call', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const first = await f.connect(deviceToken);
  const pending = f.request('/api/v1/tasks', { method: 'POST', json: { goal: 'could already be running' } });
  const sent = await first.next();
  checkRequest(sent);
  first.close(1001, 'network changed');
  await first.waitForClose();
  await relayError(await pending, 502, 'delivery_unknown');
  const second = await f.connect(deviceToken);
  await second.assertQuiet();
  const following = f.request('/api/v1/tasks');
  const next = await second.next();
  assert.notEqual(next.id, sent.id);
  assert.equal(next.method, 'GET');
  second.respond(next, { body: '{"tasks":[]}' });
  assert.equal((await following).status, 200);
});

test('a replacement socket retires the old one without letting its close affect the new connection', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const first = await f.connect(deviceToken, { native: true });
  const pending = f.request('/mcp', { method: 'POST', json: { id: 'interrupted' } });
  const old = await first.next();
  const second = await f.connect(deviceToken);
  const closed = await first.waitForCloseControl();
  assert.equal(closed.code, 1001, 'Replacement must not tell the APK its credential is revoked');
  await relayError(await pending, 502, 'delivery_unknown', false);
  assert.equal((await f.status()).online, true);
  second.respond(old, { body: 'late stale result' });
  const following = f.request('/mcp', { method: 'POST', json: { id: 'new' } });
  const current = await second.next();
  assert.notEqual(current.id, old.id);
  second.respond(current, { body: 'new connection result' });
  assert.equal(await (await following).text(), 'new connection result');
  await first.assertQuiet();
});

test('eight in-flight calls are independently correlated; the ninth is rejected and released capacity is reusable', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const phone = await f.connect(deviceToken);
  const requests = [];
  const frames = [];
  for (let index = 0; index < 8; index++) {
    requests.push(f.request(`/api/v1/tasks/task-${index}`));
    frames.push(await phone.next());
  }
  assert.equal(new Set(frames.map((frame) => frame.id)).size, 8);
  await relayError(await f.request('/api/v1/tasks/overflow'), 429, 'device_busy');
  for (let index = frames.length - 1; index >= 0; index--) phone.respond(frames[index], { status: 202, body: `result-${index}` });
  const replies = await Promise.all(requests);
  for (let index = 0; index < replies.length; index++) {
    assert.equal(replies[index].status, 202);
    assert.equal(await replies[index].text(), `result-${index}`);
  }
  const following = f.request('/api/v1/tasks/after-capacity-released');
  const next = await phone.next();
  assert.equal(next.path, '/api/v1/tasks/after-capacity-released');
  phone.respond(next, { status: 204 });
  assert.equal((await following).status, 204);
});

test('owner revocation closes the active tunnel and an old token cannot remove its replacement', async (t) => {
  const f = await fixture(t);
  const firstPair = await f.pair();
  const phone = await f.connect(firstPair.deviceToken, { native: true });
  const pending = f.request('/api/v1/tasks', { method: 'POST', json: { goal: 'pending at revocation' } });
  await phone.next();
  assert.deepEqual(await jsonResponse(await f.owner('/admin/revoke', { method: 'POST', json: {} }), 200), { ok: true });
  assert.equal((await phone.waitForCloseControl()).code, 1008);
  await relayError(await pending, 502, 'delivery_unknown');
  const unpaired = await f.status();
  assert.equal(unpaired.paired, false);
  assert.equal(unpaired.online, false);
  await relayError(await f.request('/api/v1'), 503, 'device_offline');
  assert.equal((await f.request('/device', { token: firstPair.deviceToken, headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PROTOCOL } })).status, 401);
  const replacement = await f.pair();
  assert.notEqual(replacement.deviceToken, firstPair.deviceToken);
  assert.equal((await f.request('/device', { method: 'DELETE', token: firstPair.deviceToken })).status, 401);
  assert.equal((await f.status()).paired, true);
  const second = await f.connect(replacement.deviceToken);
  const current = f.request('/api/v1');
  second.respond(await second.next(), { status: 204 });
  assert.equal((await current).status, 204);
  await phone.assertQuiet();
});

test('the APK DELETE /device operation revokes its token and leaves no reusable pairing code', async (t) => {
  const f = await fixture(t);
  const pairing = await f.pair();
  const phone = await f.connect(pairing.deviceToken, { native: true });
  const response = await f.request('/device', { method: 'DELETE', token: pairing.deviceToken });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal((await phone.waitForCloseControl()).code, 1008);
  assert.equal((await f.request('/device', { method: 'DELETE', token: pairing.deviceToken })).status, 401);
  assert.equal((await f.request('/pair', { method: 'POST', json: { code: pairing.code } })).status, 403);
  assert.equal((await f.status()).paired, false);
  await relayError(await f.request('/api/v1/tasks'), 503, 'device_offline');
  await phone.assertQuiet();
});

test('method, query, body, and approved-header limits reject before forwarding; inclusive boundaries work', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const phone = await f.connect(deviceToken);
  for (const method of ['PUT', 'PATCH', 'OPTIONS']) {
    const response = await f.request('/api/v1/tasks', { method });
    assert.equal(response.headers.get('allow'), 'GET, POST, DELETE');
    await relayError(response, 405, 'method_not_allowed');
  }
  await relayError(await f.request(`/api/v1/tasks?${'q'.repeat(8193)}`), 414, 'query_too_large');
  await relayError(await f.request('/api/v1/tasks', { method: 'POST', body: Buffer.alloc(MAX_BODY + 1) }), 413, 'body_too_large');
  await relayError(await f.request('/api/v1', { headers: { Accept: 'a'.repeat(8192) } }), 400, 'invalid_headers');
  await phone.assertQuiet();

  const bytes = Buffer.alloc(MAX_BODY, 0xfb);
  const pending = f.request(`/api/v1/tasks?${'q'.repeat(8192)}`, { method: 'POST', body: bytes });
  const frame = await phone.next();
  assert.equal(frame.query.length, 8192);
  assert.ok(checkRequest(frame).equals(bytes));
  assert.ok(frame.body.includes('+') || frame.body.includes('/'), 'Fixture must distinguish standard Base64 from base64url');
  phone.respond(frame, { body: bytes, headers: { 'content-type': 'application/octet-stream' } });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes));

  const headerBoundary = f.request('/api/v1', { headers: { Accept: 'a'.repeat(8192 - 'accept'.length) } });
  const next = await phone.next();
  assert.equal(next.headers.accept.length + 'accept'.length, 8192);
  phone.respond(next, { status: 204 });
  assert.equal((await headerBoundary).status, 204);
});

test('a valid response at the frame byte limit succeeds and one byte above disconnects safely', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const phone = await f.connect(deviceToken);
  const first = f.request('/api/v1');
  const frame = await phone.next();
  const compact = JSON.stringify({ type: 'response', id: frame.id, status: 200, body: 'APv//g==' });
  phone.sendRaw(compact + ' '.repeat(MAX_FRAME - Buffer.byteLength(compact)));
  const response = await first;
  assert.equal(response.status, 200);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(Buffer.from([0, 251, 255, 254])));
  const second = f.request('/api/v1');
  const current = await phone.next();
  const oversized = JSON.stringify({ type: 'response', id: current.id, status: 200 });
  phone.sendRaw(oversized + ' '.repeat(MAX_FRAME + 1 - Buffer.byteLength(oversized)));
  await phone.waitForClose();
  await relayError(await second, 502, 'delivery_unknown');
});

test('malformed phone frames never turn into a successful caller response', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const cases = [
    ['binary frame', (id) => Buffer.from(JSON.stringify({ type: 'response', id, status: 200 }))],
    ['invalid JSON', () => '{'],
    ['JSON null', () => 'null'],
    ['wrong frame type', (id) => JSON.stringify({ type: 'request', id, status: 200 })],
    ['missing request id', () => JSON.stringify({ type: 'response', status: 200 })],
    ['informational status', (id) => JSON.stringify({ type: 'response', id, status: 199 })],
    ['out-of-range status', (id) => JSON.stringify({ type: 'response', id, status: 600 })],
    ['non-integer status', (id) => JSON.stringify({ type: 'response', id, status: 200.5 })],
    ['invalid Base64', (id) => JSON.stringify({ type: 'response', id, status: 200, body: '!not-base64!' })],
    ['oversized decoded body', (id) => JSON.stringify({ type: 'response', id, status: 200, body: Buffer.alloc(MAX_BODY + 1).toString('base64') })],
    ['response header injection', (id) => JSON.stringify({ type: 'response', id, status: 200, headers: { 'content-type': 'text/plain\r\nSet-Cookie: injected=1' } })],
    ['too many response headers', (id) => JSON.stringify({ type: 'response', id, status: 200, headers: Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`x-${n}`, 'v'])) })],
    ['oversized response headers', (id) => JSON.stringify({ type: 'response', id, status: 200, headers: { 'x-padding': 'x'.repeat(8192) } })],
  ];
  for (const [name, badFrame] of cases) {
    await t.test(name, async () => {
      const phone = await f.connect(deviceToken);
      const pending = f.request('/api/v1/tasks');
      const frame = await phone.next();
      phone.sendRaw(badFrame(frame.id));
      assert.equal((await phone.waitForClose()).code, 1008);
      await relayError(await pending, 502, 'delivery_unknown');
    });
  }
  // A protocol error closes a connection; it must not erase the pairing itself.
  const recovered = await f.connect(deviceToken);
  const pending = f.request('/api/v1');
  recovered.respond(await recovered.next(), { status: 204 });
  assert.equal((await pending).status, 204);
});

test('unknown and duplicate response ids cannot satisfy another in-flight HTTP call', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const phone = await f.connect(deviceToken);
  const first = f.request('/api/v1/tasks/one');
  const old = await phone.next();
  phone.respond(old, { body: 'first' });
  assert.equal(await (await first).text(), 'first');
  const second = f.request('/api/v1/tasks/two');
  const current = await phone.next();
  phone.respond({ id: 'unknown_request_123456' }, { body: 'unknown' });
  phone.respond(old, { body: 'duplicate old response' });
  phone.respond(current, { body: 'second' });
  assert.equal(await (await second).text(), 'second');
});

test('gateway-origin checks, unknown routes, and public health stay outside phone control', async (t) => {
  const f = await fixture(t);
  const health = await jsonResponse(await f.request('/healthz'), 200);
  assert.equal(health.status, 'ok');
  assert.equal(health.version, '0.1.1');
  assert.equal(health.protocol, PROTOCOL);
  assert.equal((await f.owner('https://wrong.example/admin/status')).status, 421);
  for (const path of ['/api/v10/tasks', '/mcp/extra', '/authorize', '/token', '/.well-known/oauth-authorization-server']) {
    assert.equal((await f.request(path)).status, 404);
  }
});

test('automatic origin supports absent and blank configuration without pinning the first visitor', async (t) => {
  for (const [name, gatewayOrigin] of [['absent', undefined], ['empty', ''], ['whitespace', ' \t ']]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, { gatewayOrigin });
      // An anonymous request on another routed alias cannot select a permanent
      // origin or prevent the owner from using the intended deployment URL.
      assert.equal((await f.request('https://first-visitor.example/admin/status')).status, 401);
      assert.equal((await f.request('https://first-visitor.example/pair', {
        method: 'POST', json: { code: 'invalid-first-code' },
      })).status, 403);
      const status = await f.status();
      assert.equal(status.gateway, ORIGIN);
      assert.equal(status.mcpUrl, `${ORIGIN}/mcp`);
      assert.equal(status.version, '0.1.1');
      assert.equal(status.paired, false);
      const { deviceToken } = await f.pair();
      const phone = await f.connect(deviceToken);
      const pending = f.request('/api/v1/tasks');
      phone.respond(await phone.next(), { body: 'automatic origin relay' });
      assert.equal(await (await pending).text(), 'automatic origin relay');
    });
  }
});

test('automatic origin ignores forged forwarding and Host headers and keeps same-origin admin checks', async (t) => {
  const f = await fixture(t, { gatewayOrigin: undefined });
  const spoofed = {
    Host: 'attacker.example',
    Forwarded: 'for=127.0.0.1;host=attacker.example;proto=http',
    'X-Forwarded-Host': 'attacker.example',
    'X-Forwarded-Proto': 'http',
    'X-Original-Host': 'attacker.example',
    'X-Original-URL': 'http://attacker.example/admin/status',
  };
  const status = await jsonResponse(await f.owner('/admin/status', { headers: spoofed }), 200);
  assert.equal(status.gateway, ORIGIN);
  assert.equal(status.mcpUrl, `${ORIGIN}/mcp`);
  assert.equal((await f.owner('/admin/status', {
    headers: { ...spoofed, Origin: 'https://attacker.example' },
  })).status, 403);
  const invitation = await jsonResponse(await f.owner('/admin/pair', {
    method: 'POST', headers: { ...spoofed, Origin: ORIGIN },
  }), 200);
  assert.equal(invitation.gateway, ORIGIN);
  assert.equal(invitation.mcpUrl, `${ORIGIN}/mcp`);
  const paired = await jsonResponse(await f.request('/pair', {
    method: 'POST', json: { code: invitation.code }, headers: spoofed,
  }), 200);
  assert.deepEqual(Object.keys(paired).sort(), ['deviceToken', 'mcpUrl']);
  assert.equal(paired.mcpUrl, `${ORIGIN}/mcp`);
});

test('concurrent aliases use request-local URLs while sharing exactly one phone object', async (t) => {
  const f = await fixture(t, { gatewayOrigin: undefined });
  const aliases = [ORIGIN, 'https://second-relay.example', 'https://third-relay.example'];
  await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const origin = aliases[index % aliases.length];
    const status = await jsonResponse(await f.owner(`${origin}/admin/status`, { headers: { Origin: origin } }), 200);
    assert.equal(status.gateway, origin, 'Another request must not overwrite this response origin while auth awaits');
    assert.equal(status.mcpUrl, `${origin}/mcp`);
    assert.equal(status.paired, false);
  }));
  assert.equal((await f.owner(`${aliases[1]}/admin/status`, { headers: { Origin: aliases[0] } })).status, 403);

  const invitation = await jsonResponse(await f.owner(`${aliases[1]}/admin/pair`, { method: 'POST' }), 200);
  assert.equal(invitation.gateway, aliases[1]);
  assert.equal(invitation.mcpUrl, `${aliases[1]}/mcp`);
  // A user can choose a different alias in the APK. The strict PairResponse
  // must match the alias used for this redemption, not the minting request.
  const paired = await jsonResponse(await f.request(`${aliases[2]}/pair`, {
    method: 'POST', json: { code: invitation.code },
  }), 200);
  assert.deepEqual(Object.keys(paired).sort(), ['deviceToken', 'mcpUrl']);
  assert.equal(paired.mcpUrl, `${aliases[2]}/mcp`);
  const phone = await f.connect(paired.deviceToken);
  const pending = f.request(`${aliases[1]}/api/v1/tasks`, {
    method: 'POST', token: PHONE_ACCESS, json: { goal: 'same phone through another alias' },
  });
  const frame = await phone.next();
  assert.equal(frame.path, '/api/v1/tasks');
  assert.equal(frame.headers.authorization, `Bearer ${PHONE_ACCESS}`);
  phone.respond(frame, { body: 'shared phone state' });
  assert.equal(await (await pending).text(), 'shared phone state');
  for (const origin of aliases) {
    const status = await jsonResponse(await f.owner(`${origin}/admin/status`), 200);
    assert.equal(status.gateway, origin);
    assert.equal(status.paired, true);
    assert.equal(status.online, true);
  }
  const ids = await f.mf.listDurableObjectIds('RELAY', 'mika-relay-test');
  assert.equal(ids.length, 1, 'Domain aliases must not fork the single-owner pairing state');
});

test('one pairing code cannot be redeemed twice through concurrent different aliases', async (t) => {
  const f = await fixture(t, { gatewayOrigin: '' });
  const { code } = await f.mint();
  const aliases = [ORIGIN, 'https://second-relay.example'];
  const responses = await Promise.all(aliases.map(async (origin) => ({
    origin,
    response: await f.request(`${origin}/pair`, { method: 'POST', json: { code } }),
  })));
  assert.equal(responses.filter(({ response }) => response.status === 200).length, 1);
  for (const { origin, response } of responses) {
    if (response.status === 200) {
      const paired = await jsonResponse(response, 200);
      assert.equal(paired.mcpUrl, `${origin}/mcp`);
      assert.match(paired.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    } else {
      assert.ok([403, 409].includes(response.status));
    }
  }
});

test('explicit origin canonicalization still rejects a different ingress despite forged host headers', async (t) => {
  const f = await fixture(t, { gatewayOrigin: 'HTTPS://RELAY.TEST:443/' });
  assert.equal((await f.status()).gateway, ORIGIN);
  await f.pair();
  const mismatch = await f.owner('https://other.example/admin/status', {
    headers: { Host: 'relay.test', Forwarded: 'host=relay.test;proto=https', 'X-Forwarded-Host': 'relay.test' },
  });
  assert.deepEqual(await jsonResponse(mismatch, 421), { error: 'invalid_gateway_origin' });
});

test('malformed explicit origins fail closed instead of silently falling back to automatic origin', async (t) => {
  const cases = [
    'not-a-url', 'http://public.example', 'https://relay.test/path',
    'https://user:pass@relay.test', 'https://relay.test/?query=1', 'https://relay.test/#fragment',
    'https://relay.test/?', 'https://relay.test/#', 'https://relay.test\\@other.example',
  ];
  for (const gatewayOrigin of cases) {
    await t.test(gatewayOrigin, async (t) => {
      const f = await fixture(t, { gatewayOrigin });
      assert.deepEqual(await jsonResponse(await f.owner('/admin/status'), 503), { error: 'gateway_not_configured' });
      assert.equal((await f.request('/healthz')).status, 503);
    });
  }
});

test('automatic origin accepts HTTPS and localhost HTTP but rejects public HTTP', async (t) => {
  const f = await fixture(t, { gatewayOrigin: undefined });
  for (const origin of ['https://relay.test', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    const status = await jsonResponse(await f.owner(`${origin}/admin/status`), 200);
    assert.equal(status.gateway, origin);
    assert.equal(status.mcpUrl, `${origin}/mcp`);
  }
  for (const origin of ['http://relay.test', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example']) {
    assert.deepEqual(await jsonResponse(await f.owner(`${origin}/admin/status`), 421), { error: 'invalid_gateway_origin' });
  }
  const local = await fixture(t, { gatewayOrigin: 'http://127.0.0.1:8787', requestOrigin: 'http://127.0.0.1:8787' });
  await local.pair();
});

test('missing, blank, short, and shipped placeholder owner keys leave all routes disabled', async (t) => {
  for (const [name, ownerKey] of [
    ['absent', undefined], ['empty', ''], ['short', 'too-short'], ['example', 'CHANGE_ME'], ['whitespace', ' '.repeat(40)],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, { gatewayOrigin: undefined, ownerKey });
      for (const path of ['/', '/healthz', '/admin/status', '/admin/pair', '/pair', '/device', '/mcp']) {
        const response = await f.request(path);
        assert.deepEqual(await jsonResponse(response, 503), { error: 'gateway_not_configured' });
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      const ids = await f.mf.listDurableObjectIds('RELAY', 'mika-relay-test');
      assert.equal(ids.length, 0, 'A disabled deployment must not initialize owner or phone state');
    });
  }
});

test('hibernation reconstructs connection metadata and keeps the existing phone socket usable', async (t) => {
  const f = await fixture(t);
  const { deviceToken } = await f.pair();
  const phone = await f.connect(deviceToken);
  const before = f.request('/api/v1/tasks/before-hibernation');
  phone.respond(await phone.next(), { status: 204 });
  assert.equal((await before).status, 204);

  // Evict only after the HTTP exchange completed: pending HTTP deliberately
  // prevents ordinary hibernation and cannot be resumed as a durable Promise.
  const ids = await f.mf.listDurableObjectIds('RELAY', 'mika-relay-test');
  assert.equal(ids.length, 1);
  await f.mf.unsafeEvictDurableObject('mika-relay-test', 'MikaRelay', { id: ids[0], webSockets: 'hibernate' });
  assert.equal(phone.closedEvent, null);
  assert.equal((await f.status()).online, true);
  const after = f.request('/api/v1/tasks/after-hibernation');
  const frame = await phone.next();
  checkRequest(frame);
  assert.equal(frame.path, '/api/v1/tasks/after-hibernation');
  phone.respond(frame, { body: 'same socket after hibernation' });
  assert.equal(await (await after).text(), 'same socket after hibernation');
  assert.equal(phone.closedEvent, null);
});

test('an unused pairing code and a redeemed device credential both survive runtime reconstruction', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mika-relay-state-test-'));
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const first = await fixture(t, { persist: directory });
  runtimes.push(first);
  const invitation = await first.mint();
  await first.dispose();

  const second = await fixture(t, { persist: directory });
  runtimes.push(second);
  const waiting = await second.status();
  assert.equal(waiting.paired, false);
  assert.equal(waiting.pairingExpiresAt, invitation.expiresAt, 'Reconstruction must not restart or erase the code lifetime');
  const pairing = await second.redeem(invitation.code);
  await second.connect(pairing.deviceToken);
  await second.dispose();

  const third = await fixture(t, { persist: directory });
  runtimes.push(third);
  const restored = await third.status();
  assert.equal(restored.paired, true);
  assert.equal(restored.online, false, 'A restarted runtime must not claim an old socket is online');
  assert.equal((await third.request('/pair', { method: 'POST', json: { code: invitation.code } })).status, 403);
  const phone = await third.connect(pairing.deviceToken);
  const pending = third.request('/api/v1');
  phone.respond(await phone.next(), { status: 204 });
  assert.equal((await pending).status, 204);
});
