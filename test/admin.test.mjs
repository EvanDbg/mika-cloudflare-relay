import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { transform } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

// This module contains only exported asset strings, so it needs no Worker runtime.
const source = await readFile(new URL('../src/admin.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const { ADMIN_HTML, ADMIN_JS } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);

const ORIGIN = 'https://mika.example.test';
const TEST_KEY = 'test-admin-secret-for-ui-check-only-000000';
const TEST_CODE = 'AbCd0123_EfGh456';

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message || 'UI did not settle');
    await delay(10);
  }
}

function fixture(t, initialStatus = {}) {
  const calls = [];
  const copied = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(ADMIN_HTML, {
    url: ORIGIN + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const window = dom.window;
  const document = window.document;
  const element = id => document.getElementById(id);
  const status = {
    paired: false,
    online: false,
    gateway: ORIGIN,
    mcpUrl: ORIGIN + '/mcp',
    protocol: 'mika-relay.v2',
    version: '0.1.0',
    pairingExpiresAt: null,
    ...initialStatus,
  };
  let holdStatus = false;
  let releaseStatus = null;

  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async value => { copied.push(value); } },
  });

  // Intentionally ignore AbortSignal here: a response that was already in flight
  // may still settle after lock. The UI must reject it by session generation too.
  window.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.ok(['/admin/status', '/admin/pair', '/admin/revoke'].includes(url));
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    if (options.headers.Authorization !== 'Bearer ' + TEST_KEY) {
      return new Response('{}', { status: 401 });
    }
    if (url === '/admin/status') {
      if (holdStatus) await new Promise(resolve => { releaseStatus = resolve; });
      return Response.json(status);
    }
    assert.equal(options.method, 'POST');
    assert.equal(options.body, '{}');
    if (url === '/admin/pair') {
      status.pairingExpiresAt = Date.now() + 300_000;
      return Response.json({
        code: TEST_CODE,
        expiresAt: status.pairingExpiresAt,
        gateway: ORIGIN,
        mcpUrl: ORIGIN + '/mcp',
      });
    }
    status.paired = false;
    status.online = false;
    status.pairingExpiresAt = null;
    return Response.json({ ok: true });
  };

  // JSDOM versions without modal dialog methods still exercise the confirmation
  // handler. Native focus trapping and visual layout need a real-browser check.
  const dialog = element('revoke-dialog');
  if (typeof dialog.showModal !== 'function') dialog.showModal = function () { this.open = true; };
  if (typeof dialog.close !== 'function') dialog.close = function () { this.open = false; };

  t.after(async () => {
    window.dispatchEvent(new window.Event('pagehide'));
    if (releaseStatus) releaseStatus();
    await nextTurn();
    window.close();
    assert.deepEqual(errors, [], 'No browser-script errors');
  });
  window.eval(ADMIN_JS);

  return {
    window, document, element, status, calls, copied,
    click: id => element(id).click(),
    login: async (key = TEST_KEY) => {
      element('owner-key').value = key;
      element('unlock-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(() => !element('unlock-button').disabled, 'Login did not settle');
    },
    pair: async () => {
      element('pair-button').click();
      await waitFor(
        () => !element('code-panel').hidden && !element('pair-button').disabled,
        'Pairing code was not shown',
      );
    },
    holdNextStatus: () => { holdStatus = true; },
    statusIsPending: () => releaseStatus !== null,
    releaseStatus: () => { holdStatus = false; releaseStatus?.(); releaseStatus = null; },
  };
}

test('admin authentication is explicit and does not persist the key', async t => {
  const f = fixture(t);
  assert.equal(f.calls.length, 0, 'Opening the page must not call management APIs');
  assert.equal(f.element('gateway-address').textContent, ORIGIN);
  assert.equal(f.element('status-panel').hidden, true);

  await f.login('invalid-test-key');
  assert.equal(f.element('auth-panel').hidden, false);
  assert.equal(f.element('status-panel').hidden, true);
  assert.equal(f.element('owner-key').value, '', 'Failed authentication clears the input');

  await f.login();
  assert.equal(f.element('auth-panel').hidden, true);
  assert.equal(f.element('owner-key').value, '', 'Successful authentication clears the input');
  assert.equal(f.calls.at(-1).options.headers.Authorization, 'Bearer ' + TEST_KEY);
  assert.equal(f.window.localStorage.length + f.window.sessionStorage.length, 0);
  assert.equal(f.window.ownerKey, undefined, 'The key is not a global variable');
});

test('pairing countdown, copying, and expiry stay local without polling', async t => {
  const f = fixture(t);
  await f.login();
  await f.pair();
  const count = f.calls.length;
  const countdown = f.element('code-countdown').textContent;
  assert.equal(f.element('pairing-code').textContent, TEST_CODE);
  await waitFor(() => f.element('code-countdown').textContent !== countdown, 'Countdown did not update');
  assert.equal(f.calls.length, count, 'A countdown tick must not request server status');

  f.click('copy-code');
  await waitFor(() => f.copied.length === 1, 'Copy did not complete');
  assert.equal(f.copied[0], TEST_CODE);

  f.window.Date.now = () => Date.now() + 301_000;
  f.click('copy-code');
  assert.equal(f.element('pairing-code').textContent, '', 'Expired code is removed');
  assert.equal(f.element('code-panel').hidden, true);
  assert.match(f.element('pair-hint').textContent, /已过期/);
  assert.equal(f.copied.length, 1, 'An expired code is not copied');
  assert.equal(f.calls.length, count);
});

test('status values render as text instead of executable HTML', async t => {
  const payload = '<img src=x onerror="window.bad=true">';
  const f = fixture(t, { version: payload });
  await f.login();
  assert.equal(f.element('gateway-version').textContent, payload);
  assert.equal(f.element('gateway-version').children.length, 0);
  assert.equal(f.window.bad, undefined);
});

test('revocation sends one request only after the user confirms', async t => {
  const f = fixture(t, { paired: true, online: true });
  await f.login();
  assert.equal(f.element('phone-badge').textContent, '在线');
  f.click('revoke-button');
  assert.equal(f.element('revoke-dialog').open, true);
  f.click('cancel-revoke');
  assert.equal(f.element('revoke-dialog').open, false);
  assert.equal(f.calls.filter(call => call.url === '/admin/revoke').length, 0);

  f.click('revoke-button');
  f.click('confirm-revoke');
  await waitFor(() => !f.element('pair-panel').hidden, 'Revocation did not update the UI');
  assert.equal(f.calls.filter(call => call.url === '/admin/revoke').length, 1);
  assert.equal(f.element('phone-badge').textContent, '未配对');
  assert.equal(f.element('pairing-code').textContent, '');
});

test('locking clears sensitive state and ignores an aborted request arriving late', async t => {
  const f = fixture(t);
  await f.login();
  await f.pair();
  f.holdNextStatus();
  f.click('refresh-button');
  await waitFor(f.statusIsPending, 'Refresh was not held');
  const pendingRequest = f.calls.at(-1);

  f.click('lock-button');
  assert.equal(pendingRequest.options.signal.aborted, true);
  f.releaseStatus();
  await nextTurn();
  await nextTurn();

  assert.equal(f.element('status-panel').hidden, true);
  assert.equal(f.element('auth-panel').hidden, false);
  assert.equal(f.element('pairing-code').textContent, '');
  assert.equal(f.element('owner-key').value, '');
  assert.equal(f.element('gateway-version').textContent, '—');
  assert.equal(f.element('notice').textContent, '管理页已锁定。');
  assert.equal(f.window.localStorage.length + f.window.sessionStorage.length, 0);
});
