(function () {
  'use strict';

  // ── Read org_id from the script tag that loaded this file ──────────────────
  const script = document.currentScript ||
    Array.from(document.querySelectorAll('script[data-org-id]')).pop();
  const ORG_ID   = script && script.getAttribute('data-org-id');
  const API_BASE = 'https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/widget_inbound';

  if (!ORG_ID) {
    console.warn('[GSC Widget] Missing data-org-id on <script> tag. Widget not loaded.');
    return;
  }

  // ── Session + history persistence ─────────────────────────────────────────
  var SESSION_KEY = 'gsc_s_' + ORG_ID;
  var HISTORY_KEY = 'gsc_h_' + ORG_ID;

  var sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    try {
      sessionId = crypto.randomUUID();
    } catch (e) {
      sessionId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  var history = [];
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) {}

  // ── Inject styles ──────────────────────────────────────────────────────────
  var css = document.createElement('style');
  css.textContent = [
    '#gsc-bubble{position:fixed;bottom:24px;right:24px;z-index:2147483647;',
    'width:56px;height:56px;border-radius:50%;',
    'background:linear-gradient(135deg,#6366f1,#4f46e5);',
    'box-shadow:0 4px 20px rgba(99,102,241,.55);',
    'cursor:pointer;border:none;display:flex;align-items:center;justify-content:center;',
    'transition:transform .2s,box-shadow .2s;}',
    '#gsc-bubble:hover{transform:scale(1.1);box-shadow:0 6px 28px rgba(99,102,241,.7);}',
    '#gsc-bubble svg{width:26px;height:26px;fill:#fff;pointer-events:none;}',
    '#gsc-badge{position:absolute;top:-3px;right:-3px;width:18px;height:18px;',
    'background:#ef4444;border-radius:50%;border:2px solid #0f172a;',
    'font-size:10px;font-weight:700;color:#fff;display:none;',
    'align-items:center;justify-content:center;}',

    '#gsc-panel{position:fixed;bottom:96px;right:24px;z-index:2147483646;',
    'width:360px;max-width:calc(100vw - 32px);',
    'height:520px;max-height:calc(100dvh - 120px);',
    'background:#0f172a;border:1px solid rgba(255,255,255,.1);border-radius:18px;',
    'overflow:hidden;display:flex;flex-direction:column;',
    'box-shadow:0 24px 64px rgba(0,0,0,.55);',
    'transform:scale(.95) translateY(10px);opacity:0;pointer-events:none;',
    'transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s;}',
    '#gsc-panel.gsc-open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}',

    '#gsc-head{background:linear-gradient(135deg,#1e293b,#0f172a);',
    'border-bottom:1px solid rgba(255,255,255,.07);',
    'padding:13px 15px;display:flex;align-items:center;gap:10px;flex-shrink:0;}',
    '#gsc-av{width:36px;height:36px;border-radius:50%;flex-shrink:0;',
    'background:linear-gradient(135deg,#6366f1,#8b5cf6);',
    'display:flex;align-items:center;justify-content:center;',
    'font-size:14px;font-weight:700;color:#fff;font-family:inherit;}',
    '#gsc-info{flex:1;min-width:0;}',
    '#gsc-name{color:#fff;font-weight:700;font-size:13.5px;line-height:1.3;',
    'font-family:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#gsc-status{color:#22c55e;font-size:11px;display:flex;align-items:center;gap:4px;',
    'font-family:inherit;}',
    '#gsc-status::before{content:"";width:6px;height:6px;background:#22c55e;',
    'border-radius:50%;display:inline-block;}',
    '#gsc-close{background:none;border:none;cursor:pointer;color:#64748b;',
    'padding:4px;border-radius:6px;line-height:0;transition:color .15s,background .15s;}',
    '#gsc-close:hover{color:#fff;background:rgba(255,255,255,.1);}',
    '#gsc-close svg{width:18px;height:18px;fill:currentColor;display:block;}',

    '#gsc-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;',
    'scrollbar-width:thin;scrollbar-color:#334155 transparent;}',
    '#gsc-msgs::-webkit-scrollbar{width:4px;}',
    '#gsc-msgs::-webkit-scrollbar-thumb{background:#334155;border-radius:4px;}',

    '.gsc-m{display:flex;flex-direction:column;max-width:84%;}',
    '.gsc-m.ai{align-self:flex-start;}',
    '.gsc-m.usr{align-self:flex-end;}',
    '.gsc-b{padding:9px 13px;border-radius:14px;font-size:13px;line-height:1.5;',
    'word-break:break-word;font-family:inherit;}',
    '.gsc-m.ai .gsc-b{background:#1e293b;color:#e2e8f0;border-bottom-left-radius:4px;}',
    '.gsc-m.usr .gsc-b{background:#4f46e5;color:#fff;border-bottom-right-radius:4px;}',
    '.gsc-t{font-size:10px;color:#475569;margin-top:3px;padding:0 3px;}',
    '.gsc-m.usr .gsc-t{align-self:flex-end;}',

    '.gsc-dots{display:flex;gap:4px;align-items:center;padding:6px 0;}',
    '.gsc-dots span{width:7px;height:7px;background:#64748b;border-radius:50%;',
    'animation:gsc-bop 1.2s infinite;}',
    '.gsc-dots span:nth-child(2){animation-delay:.2s;}',
    '.gsc-dots span:nth-child(3){animation-delay:.4s;}',
    '@keyframes gsc-bop{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-6px);}}',

    '#gsc-foot{border-top:1px solid rgba(255,255,255,.07);',
    'padding:11px;display:flex;gap:8px;align-items:flex-end;background:#0f172a;flex-shrink:0;}',
    '#gsc-input{flex:1;background:#1e293b;border:1px solid rgba(255,255,255,.1);',
    'border-radius:10px;padding:9px 12px;color:#fff;font-size:13px;',
    'resize:none;outline:none;max-height:90px;font-family:inherit;line-height:1.5;',
    'transition:border-color .15s;}',
    '#gsc-input:focus{border-color:#6366f1;box-shadow:0 0 0 2px rgba(99,102,241,.2);}',
    '#gsc-input::placeholder{color:#64748b;}',
    '#gsc-send{width:38px;height:38px;border-radius:10px;background:#4f46e5;',
    'border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;',
    'transition:background .15s;flex-shrink:0;}',
    '#gsc-send:hover:not(:disabled){background:#6366f1;}',
    '#gsc-send:disabled{background:#334155;cursor:not-allowed;}',
    '#gsc-send svg{width:18px;height:18px;fill:#fff;}',
    '#gsc-pw{text-align:center;padding:5px;font-size:10px;color:#334155;',
    'font-family:inherit;background:#0f172a;flex-shrink:0;}',
    '#gsc-pw a{color:#475569;text-decoration:none;}',
    '#gsc-pw a:hover{color:#6366f1;}',
  ].join('');
  document.head.appendChild(css);

  // ── Build DOM ──────────────────────────────────────────────────────────────
  var bubble = document.createElement('button');
  bubble.id = 'gsc-bubble';
  bubble.setAttribute('aria-label', 'Open chat assistant');
  bubble.setAttribute('aria-haspopup', 'dialog');
  bubble.setAttribute('aria-expanded', 'false');
  bubble.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>' +
    '<div id="gsc-badge"></div>';

  var panel = document.createElement('div');
  panel.id   = 'gsc-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Chat assistant');
  panel.innerHTML =
    '<div id="gsc-head">' +
      '<div id="gsc-av">AI</div>' +
      '<div id="gsc-info"><div id="gsc-name">AI Assistant</div><div id="gsc-status">Online</div></div>' +
      '<button id="gsc-close" aria-label="Close chat"><svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>' +
    '</div>' +
    '<div id="gsc-msgs"></div>' +
    '<div id="gsc-foot">' +
      '<textarea id="gsc-input" placeholder="Type your message..." rows="1"></textarea>' +
      '<button id="gsc-send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>' +
    '</div>' +
    '<div id="gsc-pw">Powered by <a href="https://www.getsalescloser.com" target="_blank" rel="noopener noreferrer">GetSalesCloser</a></div>';

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  // ── Helpers ────────────────────────────────────────────────────────────────
  var agentInitial = 'AI';
  var agentName    = 'AI Assistant';

  function ftime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/\n/g, '<br>');
  }

  function addMsg(role, text) {
    var msgs = document.getElementById('gsc-msgs');
    var div  = document.createElement('div');
    div.className = 'gsc-m ' + role;
    div.innerHTML = '<div class="gsc-b">' + esc(text) + '</div><div class="gsc-t">' + ftime() + '</div>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function showDots() {
    var msgs = document.getElementById('gsc-msgs');
    var div  = document.createElement('div');
    div.id = 'gsc-typing';
    div.className = 'gsc-m ai';
    div.innerHTML = '<div class="gsc-b"><div class="gsc-dots"><span></span><span></span><span></span></div></div>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function hideDots() { var el = document.getElementById('gsc-typing'); if (el) el.remove(); }

  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) {}
  }

  function updateAgentUI(name) {
    if (!name) return;
    agentName    = name;
    agentInitial = name.charAt(0).toUpperCase();
    document.getElementById('gsc-av').textContent   = agentInitial;
    document.getElementById('gsc-name').textContent = name;
  }

  // ── Fetch agent meta (name) without AI call ────────────────────────────────
  fetch(API_BASE + '?action=meta&org_id=' + encodeURIComponent(ORG_ID))
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d.agent_name) updateAgentUI(d.agent_name); })
    .catch(function () {});

  // ── Send ───────────────────────────────────────────────────────────────────
  var isBusy = false;

  function send(text, hidden) {
    if (isBusy || !text.trim()) return;
    isBusy = true;

    var inputEl = document.getElementById('gsc-input');
    var sendBtn = document.getElementById('gsc-send');
    sendBtn.disabled = true;
    inputEl.disabled = true;

    if (!hidden) {
      addMsg('usr', text);
      history.push({ role: 'user', content: text });
      saveHistory();
    }

    showDots();

    fetch(API_BASE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id:     ORG_ID,
        session_id: sessionId,
        message:    text,
        history:    hidden ? [] : history.slice(0, -1),
      }),
    })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      hideDots();
      var reply = d.reply || 'Sorry, something went wrong. Please try again.';
      addMsg('ai', reply);
      if (d.agent_name) updateAgentUI(d.agent_name);
      history.push({ role: 'assistant', content: reply });
      saveHistory();
    })
    .catch(function () {
      hideDots();
      addMsg('ai', 'Connection issue. Please try again shortly.');
    })
    .finally(function () {
      isBusy = false;
      sendBtn.disabled = false;
      inputEl.disabled = false;
      if (!hidden) inputEl.focus();
    });
  }

  // ── Open / Close ───────────────────────────────────────────────────────────
  var isOpen = false;

  function open() {
    isOpen = true;
    panel.classList.add('gsc-open');
    bubble.setAttribute('aria-expanded', 'true');

    // Render persisted history
    if (history.length > 0 && document.getElementById('gsc-msgs').children.length === 0) {
      history.forEach(function (m) { addMsg(m.role === 'user' ? 'usr' : 'ai', m.content); });
    }

    // AI greeting on first ever open
    if (history.length === 0) {
      send('Hello', true);
    } else {
      document.getElementById('gsc-input').focus();
    }
  }

  function close() {
    isOpen = false;
    panel.classList.remove('gsc-open');
    bubble.setAttribute('aria-expanded', 'false');
  }

  bubble.addEventListener('click', function () { isOpen ? close() : open(); });
  document.getElementById('gsc-close').addEventListener('click', close);

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) close();
  });

  // ── Input listeners ────────────────────────────────────────────────────────
  var inputEl = document.getElementById('gsc-input');
  var sendBtn = document.getElementById('gsc-send');

  function doSend() {
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    send(text, false);
  }

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

  inputEl.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 90) + 'px';
  });

  sendBtn.addEventListener('click', doSend);

})();
