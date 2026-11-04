/** Self-contained pairing management UI. All active assets are served from this origin. */
export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="no-referrer">
  <title>Mika 远程网关</title>
  <link rel="stylesheet" href="/assets/admin.css">
  <script src="/assets/admin.js" defer></script>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Mika 远程网关首页"><span class="brand-mark" aria-hidden="true">m</span><span>Mika<span class="brand-caption">远程网关</span></span></a>
      <div class="session-tools">
        <span id="session-label" class="session-label">管理页已锁定</span>
        <button id="refresh-button" class="button button-quiet button-small" type="button" hidden>刷新状态</button>
        <button id="lock-button" class="button button-quiet button-small" type="button" hidden>锁定</button>
      </div>
    </header>

    <main>
      <section class="intro" aria-labelledby="page-title">
        <p class="eyebrow">MIKA · REMOTE ACCESS</p>
        <h1 id="page-title">Mika 远程网关</h1>
        <p class="intro-copy">配对你的安卓手机，<br class="mobile-break">让 Mika 接收远程任务。</p>
      </section>

      <div id="notice" class="notice" role="status" aria-live="polite" aria-atomic="true" hidden></div>
      <noscript><p class="notice" data-tone="error">请开启 JavaScript 后使用配对管理页。</p></noscript>

      <div class="dashboard-grid">
        <div class="main-column">
          <section id="auth-panel" class="card auth-card" aria-labelledby="auth-heading">
            <div class="section-heading"><span class="section-number" aria-hidden="true">01</span><div><p class="eyebrow">管理员访问</p><h2 id="auth-heading">打开连接管理</h2></div></div>
            <p class="section-copy">使用部署时设置的管理员密钥，查看手机状态或管理配对。</p>
            <form id="unlock-form" method="post" action="/admin">
              <label for="owner-key">管理员密钥</label>
              <div class="secret-input">
                <input id="owner-key" type="password" required maxlength="512" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="输入管理员密钥" aria-describedby="secret-note">
                <button id="toggle-key" class="reveal-button" type="button" aria-label="显示管理员密钥" aria-pressed="false">显示</button>
              </div>
              <p id="secret-note" class="field-note">密钥仅保存在本页内存中。刷新或锁定页面后，需要重新输入。</p>
              <button id="unlock-button" class="button button-primary button-wide" type="submit" disabled>验证并打开</button>
            </form>
          </section>

          <section id="status-panel" class="card" aria-labelledby="status-heading" hidden>
            <div class="card-heading"><h2 id="status-heading">手机连接</h2><span id="phone-badge" class="status-badge" data-state="idle">等待状态</span></div>
            <div class="connection-summary">
              <span id="connection-indicator" class="connection-indicator" data-state="idle" aria-hidden="true"><span class="phone-outline"></span></span>
              <div><h3 id="connection-title">正在读取</h3><p id="connection-description" class="section-copy"></p></div>
            </div>
            <dl class="metadata"><div><dt>网关版本</dt><dd id="gateway-version">—</dd></div><div><dt>连接协议</dt><dd id="gateway-protocol">—</dd></div></dl>
            <p id="updated-at" class="updated-at"></p>
          </section>

          <section id="pair-panel" class="card" aria-labelledby="pair-heading" hidden>
            <div class="section-heading"><span class="section-number" aria-hidden="true">02</span><div><p class="eyebrow">一次性配对</p><h2 id="pair-heading">连接一部手机</h2></div></div>
            <p id="pair-hint" class="section-copy">生成配对码后，在 Mika 中输入。配对码 5 分钟有效，只能使用一次。</p>
            <div id="code-panel" class="pairing-code-panel" hidden>
              <div class="code-label-row"><span>手机配对码</span><span id="code-countdown" class="countdown" aria-live="off"></span></div>
              <output id="pairing-code" class="pairing-code" aria-label="手机配对码"></output>
              <button id="copy-code" class="button button-tonal button-small" type="button">复制配对码</button>
            </div>
            <button id="pair-button" class="button button-primary button-wide" type="button">生成配对码</button>
            <p class="field-note">手机配对完成后，点页面上方的「刷新状态」查看连接结果。</p>
          </section>

          <section id="revoke-panel" class="card revoke-card" aria-labelledby="revoke-heading" hidden>
            <div><h2 id="revoke-heading">管理已配对手机</h2><p class="section-copy">换手机或停止这部手机的远程连接时，可以解除配对。</p></div>
            <button id="revoke-button" class="button button-danger-outline" type="button">解除手机配对</button>
          </section>
        </div>

        <aside class="side-column" aria-label="连接地址和手机设置">
          <section class="card address-card" aria-labelledby="address-heading">
            <div class="card-heading"><h2 id="address-heading">连接地址</h2><span class="subtle-tag">HTTPS</span></div>
            <div class="address-item"><label for="gateway-address">网关地址 <span>填写到手机</span></label><div class="address-value-row"><output id="gateway-address" class="address-value"></output><button id="copy-gateway" class="copy-button" type="button" aria-label="复制网关地址">复制</button></div></div>
            <div class="address-item"><label for="mcp-address">MCP 地址 <span>填写到客户端</span></label><div class="address-value-row"><output id="mcp-address" class="address-value"></output><button id="copy-mcp" class="copy-button" type="button" aria-label="复制 MCP 地址">复制</button></div></div>
            <p class="address-note">客户端使用的是<strong>手机访问令牌</strong>，与此页的管理员密钥不同。</p>
          </section>

          <section class="card guide-card" aria-labelledby="guide-heading">
            <h2 id="guide-heading">在手机上完成连接</h2>
            <ol class="steps">
              <li><span class="step-number" aria-hidden="true">1</span><div><strong>进入远程设置</strong><p>Mika → 设置 → 连接电脑 → 远程</p></div></li>
              <li><span class="step-number" aria-hidden="true">2</span><div><strong>填写地址和配对码</strong><p>手机填写上方的网关根地址，然后输入本页生成的配对码。</p></div></li>
              <li><span class="step-number" aria-hidden="true">3</span><div><strong>允许远程访问</strong><p>完成配对后，打开「允许远程访问」，并允许 Mika 在后台运行。</p></div></li>
            </ol>
            <div class="guide-footer">此页用于配对与连接管理。任务通过 MCP 或 CLI 客户端发起。</div>
          </section>
        </aside>
      </div>
    </main>

    <footer class="footer"><span>Mika 远程网关</span><span>一个网关 · 一部手机</span></footer>
  </div>

  <dialog id="revoke-dialog" class="confirm-dialog" aria-labelledby="revoke-dialog-title" aria-describedby="revoke-dialog-description">
    <h2 id="revoke-dialog-title">解除当前手机配对？</h2>
    <p id="revoke-dialog-description">这会立即断开手机连接。要恢复访问，需要在手机上重新配对。</p>
    <div class="dialog-actions"><button id="cancel-revoke" class="button button-quiet" type="button" autofocus>保留配对</button><button id="confirm-revoke" class="button button-danger" type="button">确认解除</button></div>
  </dialog>
</body>
</html>`;

export const ADMIN_CSS = String.raw`
:root{color-scheme:light;--page:#f3f6f4;--surface:#fff;--ink:#183b33;--body:#3f5852;--muted:#70827c;--line:#dfe8e3;--accent:#167961;--accent-hover:#10634f;--tint:#eaf5ef;--tint-strong:#dceee4;--danger:#ae3e3e;--danger-tint:#fff3f0;--shadow:0 7px 24px rgba(24,59,51,.035);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-synthesis:none}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--page);color:var(--body);font-size:15px;line-height:1.65;-webkit-font-smoothing:antialiased}
button,input{font:inherit}
button{cursor:pointer;-webkit-tap-highlight-color:transparent}
button:disabled{cursor:default;opacity:.52}
button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #77b9a3;outline-offset:3px}
button,a,input{touch-action:manipulation}
h1,h2,h3,p{margin:0}
h1,h2,h3{color:var(--ink)}
h1{font-size:clamp(29px,4.5vw,40px);font-weight:720;letter-spacing:-.04em;line-height:1.25}
h2{font-size:18px;font-weight:650;letter-spacing:-.02em;line-height:1.4}
h3{font-size:19px;line-height:1.4;font-weight:650}
.shell{width:min(1080px,100%);margin:0 auto;padding:0 32px}
.topbar{min-height:92px;display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:11px;color:var(--ink);text-decoration:none;font-size:20px;font-weight:720;line-height:1.2}
.brand-mark{display:grid;place-items:center;width:39px;height:39px;border-radius:13px;background:var(--accent);color:#fff;font-size:32px;font-weight:760;line-height:1;padding-bottom:7px;letter-spacing:-.06em}
.brand-caption{display:block;color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.04em;margin-top:3px}
.session-tools{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.session-label{color:var(--muted);font-size:12px}
.intro{padding:43px 0 30px}
.eyebrow{font-size:10px;font-weight:700;letter-spacing:.14em;color:var(--accent);margin-bottom:8px;line-height:1.5}
.intro>.eyebrow{margin-bottom:13px;letter-spacing:.19em}
.intro-copy{font-size:16px;color:var(--muted);margin-top:12px}
.mobile-break{display:none}
.dashboard-grid{display:grid;grid-template-columns:minmax(0,1.16fr) minmax(0,1fr);align-items:start;gap:22px}
.main-column,.side-column{display:grid;gap:20px;min-width:0}
.card{padding:28px;border:1px solid var(--line);background:var(--surface);border-radius:20px;box-shadow:var(--shadow);min-width:0}
.auth-card{padding-top:30px}
.section-heading{display:flex;gap:13px;align-items:center;margin-bottom:17px}
.section-heading .eyebrow{margin-bottom:3px;font-size:9px;letter-spacing:.12em}
.section-number{width:38px;height:38px;flex:0 0 auto;display:grid;place-items:center;border:1px solid var(--line);border-radius:12px;color:var(--accent);font-size:12px;font-weight:650;font-variant-numeric:tabular-nums;background:var(--page)}
.section-copy{font-size:14px;line-height:1.75;color:var(--muted)}
.auth-card form{margin-top:25px}
label{display:block;font-size:13px;font-weight:600;color:var(--ink)}
.secret-input{position:relative;margin-top:9px}
.secret-input input{width:100%;min-height:50px;padding:12px 65px 12px 15px;border:1px solid var(--line);border-radius:11px;background:var(--page);color:var(--ink);font-size:16px;line-height:1.5}
.secret-input input::placeholder{color:var(--muted);font-size:14px}
.reveal-button{position:absolute;right:4px;top:4px;height:42px;min-width:54px;border:0;border-radius:8px;color:var(--accent);background:transparent;font-size:12px;font-weight:600}
.reveal-button:hover{background:var(--tint)}
.field-note{font-size:12px;color:var(--muted);margin:10px 0 18px;line-height:1.75}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:10px 18px;gap:8px;border:1px solid transparent;border-radius:11px;font-size:14px;font-weight:600;line-height:1.5;text-align:center;transition:background .15s,border-color .15s}
.button-primary{background:var(--accent);color:#fff}
.button-primary:hover:not(:disabled){background:var(--accent-hover)}
.button-wide{width:100%}
.button-quiet{border-color:var(--line);background:var(--surface);color:var(--body)}
.button-quiet:hover:not(:disabled){background:var(--tint)}
.button-small{min-height:38px;padding:7px 12px;font-size:12px;border-radius:9px}
.button-tonal{background:var(--tint-strong);color:var(--accent)}
.button-tonal:hover:not(:disabled){background:var(--line)}
.button-danger-outline{color:var(--danger);border-color:var(--line);background:var(--surface)}
.button-danger-outline:hover:not(:disabled){background:var(--danger-tint);border-color:var(--danger)}
.button-danger{color:#fff;background:var(--danger)}
.card-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:24px}
.subtle-tag{font-size:10px;font-weight:600;letter-spacing:.06em;background:var(--page);padding:3px 7px;border-radius:6px;color:var(--muted)}
.address-item+.address-item{margin-top:22px}
.address-item label{display:flex;justify-content:space-between;gap:10px}
.address-item label span{font-size:11px;font-weight:400;color:var(--muted)}
.address-value-row{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:11px;background:var(--page);padding:11px 9px 11px 13px;margin-top:8px;min-height:53px}
.address-value{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-width:0;font-size:11.5px;line-height:1.65;overflow-wrap:anywhere;user-select:all;color:var(--body)}
.copy-button{flex:0 0 auto;margin-left:auto;padding:7px;border:0;border-radius:7px;min-height:34px;min-width:41px;background:transparent;color:var(--accent);font-size:12px;font-weight:600}
.copy-button:hover{background:var(--tint-strong)}
.address-note{font-size:12px;line-height:1.8;color:var(--muted);margin-top:18px}
.address-note strong{font-weight:600;color:var(--body)}
.guide-card h2{font-size:16px}
.steps{padding:0;margin:25px 0 0;list-style:none;display:grid;gap:23px}
.steps li{display:flex;gap:12px}
.step-number{flex:0 0 auto;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--tint);color:var(--accent);font-size:11px;font-weight:700;margin-top:1px}
.steps strong{display:block;color:var(--ink);font-size:13px;font-weight:600;margin-bottom:4px}
.steps p{font-size:12px;color:var(--muted);line-height:1.8}
.guide-footer{font-size:11px;color:var(--muted);border-top:1px solid var(--line);margin-top:24px;padding-top:17px;line-height:1.8}
.status-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;background:var(--page);color:var(--muted);font-size:11px;white-space:nowrap}
.status-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.status-badge[data-state="online"]{color:var(--accent);background:var(--tint)}
.status-badge[data-state="offline"]{color:#a06a1d;background:#fff6e5}
.connection-summary{display:flex;gap:17px;align-items:center;margin:4px 0 26px}
.connection-summary .section-copy{font-size:12px;margin-top:8px}
.connection-indicator{display:grid;place-items:center;flex:0 0 auto;width:61px;height:69px;border-radius:17px;background:var(--page);color:var(--muted)}
.connection-indicator[data-state="online"]{background:var(--tint);color:var(--accent)}
.phone-outline{display:block;width:23px;height:36px;border:2px solid currentColor;border-radius:6px;position:relative}
.phone-outline::after{content:"";width:7px;height:2px;border-radius:2px;position:absolute;left:6px;bottom:3px;background:currentColor}
.metadata{display:flex;gap:24px;flex-wrap:wrap;padding:17px 0 0;margin:0;border-top:1px solid var(--line)}
.metadata div{min-width:0}
.metadata dt{font-size:10px;color:var(--muted);margin-bottom:4px}
.metadata dd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--body);margin:0;overflow-wrap:anywhere}
.updated-at{font-size:10px;color:var(--muted);margin-top:17px}
.pairing-code-panel{border:1px solid var(--tint-strong);border-radius:14px;background:var(--tint);padding:18px;margin:20px 0 16px}
.code-label-row{display:flex;justify-content:space-between;align-items:center;gap:10px;color:var(--accent);font-size:11px}
.countdown{font-variant-numeric:tabular-nums;white-space:nowrap}
.pairing-code{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:clamp(19px,2.1vw,24px);font-weight:600;letter-spacing:.065em;color:var(--ink);margin:13px 0 15px;line-height:1.5;overflow-wrap:anywhere;user-select:all}
#pair-panel>.button{margin-top:18px}
#pair-panel>.field-note{margin-bottom:0}
.revoke-card{display:grid;gap:20px}
.revoke-card h2{font-size:16px;margin-bottom:8px}
.revoke-card .section-copy{font-size:12px}
.revoke-card .button{justify-self:start;min-height:42px;font-size:12px}
.notice{border:1px solid var(--line);background:var(--surface);color:var(--body);border-radius:12px;padding:13px 17px;font-size:13px;line-height:1.75;margin:0 0 20px;overflow-wrap:anywhere}
.notice[data-tone="success"]{border-color:var(--tint-strong);color:var(--accent);background:var(--tint)}
.notice[data-tone="error"]{border-color:#e7c4bc;color:var(--danger);background:var(--danger-tint)}
.footer{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:var(--muted);margin:35px 0 27px;padding-top:22px;border-top:1px solid var(--line)}
.confirm-dialog{max-width:calc(100% - 40px);width:410px;padding:28px;background:var(--surface);color:var(--body);border:1px solid var(--line);border-radius:20px;box-shadow:0 20px 80px rgba(0,0,0,.18)}
.confirm-dialog::backdrop{background:rgba(15,35,30,.4);backdrop-filter:blur(3px)}
.confirm-dialog h2{font-size:20px;margin-bottom:12px}
.confirm-dialog p{font-size:14px;color:var(--muted);line-height:1.8}
.dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:25px}
.clipboard-helper{position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none}
@media(max-width:760px){.shell{max-width:590px;padding:0 22px}.topbar{min-height:78px;gap:12px}.intro{padding:33px 0 25px}.dashboard-grid{grid-template-columns:minmax(0,1fr);gap:20px}.card{padding:25px}.main-column,.side-column{gap:18px}.session-label{font-size:11px}.session-tools{gap:7px}.session-tools .button-small{min-height:40px;padding:7px 10px}.pairing-code{font-size:24px}.intro-copy{font-size:15px}.footer{margin-top:30px}}
@media(max-width:430px){.shell{padding:0 17px}.brand{font-size:18px;gap:9px}.brand-mark{width:35px;height:35px;border-radius:12px;font-size:29px}.brand-caption{font-size:10px}.session-label[data-unlocked="true"]{display:none}.card{padding:23px 21px;border-radius:17px}.intro{padding-top:29px}.intro-copy{font-size:14px}.mobile-break{display:block}.address-value{font-size:11px}.pairing-code-panel{padding:15px}.pairing-code{font-size:21px;letter-spacing:.04em}.section-copy{font-size:13px}.connection-summary{gap:13px}.connection-summary h3{font-size:17px}.connection-indicator{width:51px;height:61px}.dialog-actions .button{flex:1;padding-left:10px;padding-right:10px}.footer{font-size:10px}}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--page:#12211d;--surface:#1b2c26;--ink:#e5f1ea;--body:#c0d2c8;--muted:#91a79a;--line:#30473b;--accent:#8ed6b2;--accent-hover:#ace7c8;--tint:#233e30;--tint-strong:#31513d;--danger:#f1a59c;--danger-tint:#3b2926;--shadow:0 7px 24px rgba(0,0,0,.06)}.button-primary,.brand-mark{color:#123525}.button-danger{color:#3a1612}.status-badge[data-state="offline"]{color:#ebc17e;background:#3b3525}.notice[data-tone="error"]{border-color:#6b463f}.confirm-dialog::backdrop{background:rgba(0,0,0,.58)}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export const ADMIN_JS = String.raw`(function () {
  'use strict';

  const byId = function (id) { return document.getElementById(id); };
  const ui = {
    form: byId('unlock-form'), key: byId('owner-key'), unlock: byId('unlock-button'),
    toggleKey: byId('toggle-key'), auth: byId('auth-panel'), status: byId('status-panel'),
    pair: byId('pair-panel'), revoke: byId('revoke-panel'), pairButton: byId('pair-button'),
    refresh: byId('refresh-button'), lock: byId('lock-button'), session: byId('session-label'),
    notice: byId('notice'), badge: byId('phone-badge'), indicator: byId('connection-indicator'),
    title: byId('connection-title'), description: byId('connection-description'),
    version: byId('gateway-version'), protocol: byId('gateway-protocol'), updated: byId('updated-at'),
    gateway: byId('gateway-address'), mcp: byId('mcp-address'), pairHint: byId('pair-hint'),
    codePanel: byId('code-panel'), code: byId('pairing-code'), countdown: byId('code-countdown'),
    copyCode: byId('copy-code'), dialog: byId('revoke-dialog'), revokeButton: byId('revoke-button')
  };

  let ownerKey = '';
  let authenticated = false;
  let busy = false;
  let generation = 0;
  let status = null;
  let pairingCode = '';
  let pairingExpiresAt = 0;
  let countdownTimer = null;
  const requests = new Set();
  const defaultHint = '生成配对码后，在 Mika 中输入。配对码 5 分钟有效，只能使用一次。';

  function notify(message, tone) {
    ui.notice.textContent = message;
    ui.notice.dataset.tone = tone || 'info';
    ui.notice.hidden = !message;
  }

  function syncButtons() {
    ui.unlock.disabled = busy;
    ui.unlock.textContent = busy && !authenticated ? '正在验证…' : '验证并打开';
    ui.refresh.disabled = busy || !authenticated;
    ui.pairButton.disabled = busy || !authenticated || Boolean(status && status.paired);
    ui.revokeButton.disabled = busy || !authenticated || !status || !status.paired;
    ui.copyCode.disabled = !pairingCode || pairingExpiresAt <= Date.now();
    ui.form.setAttribute('aria-busy', String(busy && !authenticated));
  }

  function setBusy(value) { busy = value; syncButtons(); }

  function stopCountdown() {
    if (countdownTimer !== null) clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function clearCode() {
    stopCountdown();
    pairingCode = '';
    pairingExpiresAt = 0;
    ui.code.textContent = '';
    ui.countdown.textContent = '';
    ui.codePanel.hidden = true;
    ui.copyCode.disabled = true;
    ui.pairButton.textContent = '生成配对码';
    ui.pairHint.textContent = defaultHint;
  }

  function updateCountdown() {
    const remaining = Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1000));
    if (!remaining) {
      const hadCode = Boolean(pairingCode);
      clearCode();
      if (hadCode) ui.pairHint.textContent = '配对码已过期，请重新生成。';
      return;
    }
    ui.countdown.textContent = '剩余 ' + String(Math.floor(remaining / 60)).padStart(2, '0') + ':' + String(remaining % 60).padStart(2, '0');
    ui.copyCode.disabled = !pairingCode;
  }

  function startCountdown() {
    stopCountdown();
    updateCountdown();
    if (pairingCode && !document.hidden) countdownTimer = setInterval(updateCountdown, 1000);
  }

  function displayAddresses(gateway, mcpUrl) {
    ui.gateway.textContent = gateway;
    ui.mcp.textContent = mcpUrl;
  }

  function lockPage(options) {
    const focus = !options || options.focus !== false;
    generation += 1;
    ownerKey = '';
    authenticated = false;
    busy = false;
    status = null;
    requests.forEach(function (controller) { controller.abort(); });
    requests.clear();
    clearCode();
    ui.key.value = '';
    ui.key.type = 'password';
    ui.toggleKey.textContent = '显示';
    ui.toggleKey.setAttribute('aria-label', '显示管理员密钥');
    ui.toggleKey.setAttribute('aria-pressed', 'false');
    ui.auth.hidden = false;
    ui.status.hidden = true;
    ui.pair.hidden = true;
    ui.revoke.hidden = true;
    ui.refresh.hidden = true;
    ui.lock.hidden = true;
    ui.session.textContent = '管理页已锁定';
    ui.session.dataset.unlocked = 'false';
    ui.title.textContent = '';
    ui.description.textContent = '';
    ui.version.textContent = '—';
    ui.protocol.textContent = '—';
    ui.updated.textContent = '';
    ui.badge.textContent = '等待状态';
    ui.badge.dataset.state = 'idle';
    ui.indicator.dataset.state = 'idle';
    if (ui.dialog.open) ui.dialog.close();
    displayAddresses(location.origin, location.origin + '/mcp');
    syncButtons();
    if (focus) ui.key.focus();
  }

  function verifyStatus(data) {
    if (!data || typeof data.paired !== 'boolean' || typeof data.online !== 'boolean' ||
        typeof data.gateway !== 'string' || typeof data.mcpUrl !== 'string' ||
        typeof data.protocol !== 'string' || typeof data.version !== 'string' ||
        !(data.pairingExpiresAt === null || Number.isFinite(data.pairingExpiresAt))) {
      throw new Error('invalid_response');
    }
    return data;
  }

  function renderStatus(data) {
    status = verifyStatus(data);
    authenticated = true;
    ui.key.value = '';
    ui.auth.hidden = true;
    ui.status.hidden = false;
    ui.pair.hidden = data.paired;
    ui.revoke.hidden = !data.paired;
    ui.refresh.hidden = false;
    ui.lock.hidden = false;
    ui.session.textContent = '管理页已打开';
    ui.session.dataset.unlocked = 'true';
    displayAddresses(data.gateway, data.mcpUrl);
    ui.version.textContent = data.version;
    ui.protocol.textContent = data.protocol;
    ui.updated.textContent = '最近更新 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const state = data.paired ? (data.online ? 'online' : 'offline') : 'idle';
    ui.badge.dataset.state = state;
    ui.indicator.dataset.state = state;
    ui.badge.textContent = data.paired ? (data.online ? '在线' : '离线') : '未配对';
    ui.title.textContent = data.paired ? (data.online ? '手机已连接' : '等待手机上线') : '还没有配对手机';
    ui.description.textContent = data.paired ? (data.online ? '连接已建立，可以通过 MCP 或 CLI 给 Mika 派任务。' : '在 Mika 中打开「允许远程访问」，并确认手机可以联网。') : '生成一次性配对码，在手机上完成连接。';
    if (data.paired) {
      clearCode();
    } else if (pairingCode && data.pairingExpiresAt !== pairingExpiresAt) {
      clearCode();
    }
    if (!data.paired && !pairingCode && data.pairingExpiresAt > Date.now()) {
      ui.pairHint.textContent = '已有尚未使用的配对码。重新生成后，之前的配对码会失效。';
      ui.pairButton.textContent = '重新生成配对码';
    } else if (!data.paired && !pairingCode) {
      ui.pairHint.textContent = defaultHint;
      ui.pairButton.textContent = '生成配对码';
    }
    syncButtons();
  }

  async function api(path, method, session) {
    const controller = new AbortController();
    requests.add(controller);
    let timedOut = false;
    const timeout = setTimeout(function () { timedOut = true; controller.abort(); }, 15000);
    try {
      const headers = { 'Authorization': 'Bearer ' + ownerKey, 'Accept': 'application/json' };
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      const response = await fetch(path, {
        method: method, headers: headers, body: method === 'POST' ? '{}' : undefined,
        cache: 'no-store', credentials: 'omit', mode: 'same-origin', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: controller.signal
      });
      if (session !== generation) throw new Error('session_ended');
      if (!response.ok) {
        const error = new Error('http_error');
        error.status = response.status;
        throw error;
      }
      const data = await response.json();
      if (session !== generation) throw new Error('session_ended');
      return data;
    } catch (error) {
      if (timedOut) throw new Error('request_timeout');
      throw error;
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
    }
  }

  function handleError(error, session) {
    if (session !== generation || error.message === 'session_ended') return;
    if (error.status === 401 || error.status === 403) {
      lockPage();
      notify('管理员密钥不正确，或已失效。请重新输入。', 'error');
    } else if (error.status === 409) {
      notify('配对状态已变化，请刷新状态后再操作。', 'error');
    } else if (error.status === 429) {
      notify('操作太频繁，请稍后再试。', 'error');
    } else if (error.message === 'request_timeout') {
      notify('请求超时。操作可能已生效，请刷新状态确认。', 'error');
    } else if (error.message === 'invalid_response' || error instanceof SyntaxError) {
      notify('网关返回了无法识别的结果，请刷新状态或联系部署者。', 'error');
    } else if (error.name !== 'AbortError') {
      notify('暂时无法连接网关。请检查网络后刷新状态；不要连续重复提交。', 'error');
    }
  }

  async function runAction(action) {
    if (busy || !authenticated) return;
    const session = generation;
    notify('');
    setBusy(true);
    try { await action(session); }
    catch (error) { handleError(error, session); }
    finally { if (session === generation) setBusy(false); }
  }

  async function copyText(value, label) {
    if (!value) return;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(value);
      notify(label + '已复制。', 'success');
    } catch (_) {
      const previous = document.activeElement;
      const helper = document.createElement('textarea');
      helper.className = 'clipboard-helper';
      helper.value = value;
      helper.readOnly = true;
      helper.setAttribute('aria-hidden', 'true');
      document.body.appendChild(helper);
      helper.select();
      helper.setSelectionRange(0, value.length);
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (_) { /* Manual copying remains available. */ }
      helper.remove();
      if (previous && typeof previous.focus === 'function') previous.focus();
      notify(copied ? label + '已复制。' : '无法自动复制，请长按或选中' + label + '后复制。', copied ? 'success' : 'info');
    }
  }

  ui.form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy) return;
    const candidate = ui.key.value.trim();
    if (!candidate) { ui.key.focus(); return; }
    generation += 1;
    const session = generation;
    ownerKey = candidate;
    notify('');
    setBusy(true);
    try {
      const data = await api('/admin/status', 'GET', session);
      renderStatus(data);
      ui.refresh.focus();
    } catch (error) {
      handleError(error, session);
      if (session === generation && !authenticated) ownerKey = '';
    } finally { if (session === generation) setBusy(false); }
  });

  ui.toggleKey.addEventListener('click', function () {
    const show = ui.key.type === 'password';
    ui.key.type = show ? 'text' : 'password';
    ui.toggleKey.textContent = show ? '隐藏' : '显示';
    ui.toggleKey.setAttribute('aria-label', show ? '隐藏管理员密钥' : '显示管理员密钥');
    ui.toggleKey.setAttribute('aria-pressed', String(show));
  });

  ui.lock.addEventListener('click', function () {
    lockPage();
    notify('管理页已锁定。', 'info');
  });

  ui.refresh.addEventListener('click', function () {
    runAction(async function (session) {
      renderStatus(await api('/admin/status', 'GET', session));
      notify('状态已更新。', 'success');
    });
  });

  ui.pairButton.addEventListener('click', function () {
    runAction(async function (session) {
      const data = await api('/admin/pair', 'POST', session);
      if (!data || typeof data.code !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(data.code) ||
          !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now() ||
          typeof data.gateway !== 'string' || typeof data.mcpUrl !== 'string') throw new Error('invalid_response');
      clearCode();
      pairingCode = data.code;
      pairingExpiresAt = data.expiresAt;
      status.pairingExpiresAt = data.expiresAt;
      displayAddresses(data.gateway, data.mcpUrl);
      ui.code.textContent = pairingCode;
      ui.codePanel.hidden = false;
      ui.pairButton.textContent = '重新生成配对码';
      ui.pairHint.textContent = '在手机上填写网关地址和下方配对码。重新生成会使当前配对码失效。';
      startCountdown();
      notify('配对码已生成，请在手机上完成配对。', 'success');
    });
  });

  ui.revokeButton.addEventListener('click', function () {
    if (!busy && authenticated && status && status.paired) ui.dialog.showModal();
  });
  byId('cancel-revoke').addEventListener('click', function () { ui.dialog.close(); });
  byId('confirm-revoke').addEventListener('click', function () {
    ui.dialog.close();
    runAction(async function (session) {
      const data = await api('/admin/revoke', 'POST', session);
      if (!data || data.ok !== true) throw new Error('invalid_response');
      clearCode();
      renderStatus(Object.assign({}, status, { paired: false, online: false, pairingExpiresAt: null }));
      notify('手机配对已解除。', 'success');
    });
  });

  byId('copy-gateway').addEventListener('click', function () { copyText(ui.gateway.textContent, '网关地址'); });
  byId('copy-mcp').addEventListener('click', function () { copyText(ui.mcp.textContent, 'MCP 地址'); });
  ui.copyCode.addEventListener('click', function () {
    updateCountdown();
    if (pairingCode) copyText(pairingCode, '配对码');
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopCountdown();
    else if (pairingCode) startCountdown();
  });
  window.addEventListener('pagehide', function () { lockPage({ focus: false }); });

  displayAddresses(location.origin, location.origin + '/mcp');
  syncButtons();
})();`;
