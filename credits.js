// credits.js — Shared credit wallet UI for all dashboard and service pages
// Provides: initCreditWallet(sb, orgId), showTopupModal(tokenKey)
// Requires: Supabase JS client already loaded, auth.js already run.

(function(window) {
  'use strict';

  const SUPABASE_URL = 'https://klbwigcvrdfeeeeotehu.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtsYndpZ2N2cmRmZWVlZW90ZWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NDA4MDgsImV4cCI6MjA4NDExNjgwOH0.gdqggXxOsl0CO0ctKfCWYzVuMrmP6TXSiYftTXDC4v8';

  const CREDIT_CONFIG = {
    voice_min:  { label: 'Voice Minutes',    icon: 'fa-microphone',    color: 'purple', unit: 'min',  min_qty: 100,   step: 100,   price_label: '$0.20/min',  unit_price: 0.20 },
    sms_msg:    { label: 'SMS Credits',      icon: 'fa-comment-sms',   color: 'indigo', unit: 'msgs', min_qty: 2000,  step: 1000,  price_label: '$0.01/msg',  unit_price: 0.01 },
    ai_credit:  { label: 'AI Credits',       icon: 'fa-brain',         color: 'emerald',unit: 'creds',min_qty: 90000, step: 90000, price_label: '$0.01/30 credits', unit_price: null, ai_bundle: true },
    wa_msg:     { label: 'WhatsApp Credits', icon: 'fa-whatsapp',      color: 'green',  unit: 'msgs', min_qty: 2000,  step: 1000,  price_label: '$0.01/msg',  unit_price: 0.01 },
  };

  const LOW_THRESHOLDS = { voice_min: 10, sms_msg: 100, ai_credit: 5000, wa_msg: 100 };

  function computeAmount(token_key, qty) {
    if (token_key === 'ai_credit') return Math.round((qty / 30) * 0.01 * 100) / 100;
    return Math.round(qty * CREDIT_CONFIG[token_key].unit_price * 100) / 100;
  }

  // ----- Modal injection -----
  function injectModal() {
    if (document.getElementById('credit-topup-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'credit-topup-modal';
    modal.className = 'hidden fixed inset-0 bg-black/70 backdrop-blur-sm z-[80] flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <div class="flex items-center justify-between mb-5">
          <h3 class="text-white font-bold text-lg flex items-center gap-2">
            <i id="ctm-icon" class="fa text-indigo-400"></i>
            <span id="ctm-title">Buy Credits</span>
          </h3>
          <button onclick="window.Credits.closeModal()" class="text-slate-500 hover:text-white text-xl transition">&times;</button>
        </div>

        <!-- Credit type tabs (hidden when pre-selected) -->
        <div id="ctm-tabs" class="hidden grid grid-cols-4 gap-1 mb-5 bg-slate-800 rounded-xl p-1">
          <button onclick="window.Credits._selectType('voice_min')" id="ctm-tab-voice_min" class="ctm-tab text-xs font-bold py-2 rounded-lg transition">Voice</button>
          <button onclick="window.Credits._selectType('sms_msg')"   id="ctm-tab-sms_msg"   class="ctm-tab text-xs font-bold py-2 rounded-lg transition">SMS</button>
          <button onclick="window.Credits._selectType('ai_credit')" id="ctm-tab-ai_credit" class="ctm-tab text-xs font-bold py-2 rounded-lg transition">AI</button>
          <button onclick="window.Credits._selectType('wa_msg')"    id="ctm-tab-wa_msg"    class="ctm-tab text-xs font-bold py-2 rounded-lg transition">WhatsApp</button>
        </div>

        <!-- Pricing info -->
        <div class="bg-slate-800/60 rounded-xl p-4 mb-5">
          <div class="flex justify-between text-sm mb-1">
            <span class="text-slate-400">Rate</span>
            <span id="ctm-rate" class="text-white font-bold"></span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-400">Minimum purchase</span>
            <span id="ctm-min" class="text-white font-bold"></span>
          </div>
        </div>

        <!-- Quantity selector -->
        <div class="mb-5">
          <label class="block text-xs text-slate-400 mb-2 font-bold uppercase tracking-wider">Quantity</label>
          <input id="ctm-qty" type="number" class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-4 py-3 text-lg font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
            oninput="window.Credits._updatePreview()">
          <p id="ctm-qty-err" class="hidden text-xs text-red-400 mt-1"></p>
        </div>

        <!-- Price preview -->
        <div class="bg-slate-800/40 border border-slate-700 rounded-xl px-4 py-3 mb-5 flex justify-between items-center">
          <span class="text-slate-400 text-sm">Total</span>
          <span id="ctm-total" class="text-white font-bold text-xl">$0.00</span>
        </div>

        <button id="ctm-pay-btn" onclick="window.Credits._proceed()" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3.5 rounded-xl transition text-sm">
          Proceed to Payment
        </button>
        <p class="text-center text-xs text-slate-500 mt-3">Credits are added instantly after payment. Never expire.</p>
      </div>`;
    document.body.appendChild(modal);
  }

  // ----- Alert banner injection -----
  function injectBanner() {
    if (document.getElementById('credit-low-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'credit-low-banner';
    banner.className = 'hidden fixed top-0 left-0 right-0 z-[90]';
    banner.innerHTML = `
      <div class="bg-red-900/90 border-b border-red-700/50 px-6 py-2 flex items-center gap-3 text-sm shadow-lg">
        <i class="fa fa-triangle-exclamation text-red-400"></i>
        <span id="credit-low-banner-text" class="text-red-300 font-medium flex-1"></span>
        <button onclick="window.Credits.showTopupModal(window.Credits._lowKey)" class="bg-red-600 hover:bg-red-500 text-white font-bold px-3 py-1 rounded-lg text-xs transition">Buy Now</button>
        <button onclick="document.getElementById('credit-low-banner').classList.add('hidden')" class="text-red-400 hover:text-white text-lg leading-none">&times;</button>
      </div>`;
    document.body.appendChild(banner);
  }

  // ----- State -----
  let _sb = null;
  let _orgId = null;
  let _currentTokenKey = 'sms_msg';
  let _wallets = {};
  let _preselected = false;
  let _walletContainerId = null;
  let _primaryTokenKey = null;
  window.Credits = window.Credits || {};
  window.Credits._lowKey = 'sms_msg';

  // Re-fetch wallets and re-render on page focus (prevents stale data after tab switch or payment return)
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && _sb && _orgId) { refresh(); }
  });

  // ----- Public API -----

  async function initCreditWallet(sb, orgId, opts) {
    _sb = sb;
    _orgId = orgId;
    opts = opts || {};
    if (opts.walletContainerId) _walletContainerId = opts.walletContainerId;
    if (opts.primaryTokenKey) _primaryTokenKey = opts.primaryTokenKey;
    injectModal();
    injectBanner();

    const { data: walletRows } = await sb
      .from('credit_wallets')
      .select('token_key, available_balance')
      .eq('org_id', orgId);

    _wallets = {};
    (walletRows || []).forEach(function(w) { _wallets[w.token_key] = Number(w.available_balance); });

    // Render wallet cards if a container is provided
    if (_walletContainerId) _renderWalletCards(_walletContainerId);

    // Show low-balance banner for the most critical low balance
    _checkBanners(_primaryTokenKey);

    // If user just returned from a successful credit purchase, do an extra refresh
    // to ensure we show post-fulfillment balance (webhook may have completed just after page load)
    try {
      if (sessionStorage.getItem('credits_wallet_refresh') === '1') {
        sessionStorage.removeItem('credits_wallet_refresh');
        setTimeout(refresh, 2000); // 2s delay — gives fulfill-paid-order time to complete
      }
    } catch(e) {}
  }

  // Re-fetch wallet balances from DB and re-render. Safe to call anytime.
  async function refresh() {
    if (!_sb || !_orgId) return;
    try {
      const { data: walletRows } = await _sb
        .from('credit_wallets')
        .select('token_key, available_balance')
        .eq('org_id', _orgId);
      _wallets = {};
      (walletRows || []).forEach(function(w) { _wallets[w.token_key] = Number(w.available_balance); });
      if (_walletContainerId) _renderWalletCards(_walletContainerId);
      _checkBanners(_primaryTokenKey);
    } catch (e) {
      console.warn('[Credits.refresh] error:', e);
    }
  }

  function showTopupModal(tokenKey, allowSwitch) {
    _preselected = !allowSwitch;
    _currentTokenKey = tokenKey || 'sms_msg';
    window.Credits._lowKey = _currentTokenKey;

    const modal = document.getElementById('credit-topup-modal');
    if (!modal) { injectModal(); }

    // Show/hide tabs
    const tabs = document.getElementById('ctm-tabs');
    if (tabs) tabs.classList.toggle('hidden', _preselected);

    _selectType(_currentTokenKey);
    modal.classList.remove('hidden');
  }

  function closeModal() {
    const modal = document.getElementById('credit-topup-modal');
    if (modal) modal.classList.add('hidden');
  }

  // ----- Internal helpers -----

  function _selectType(tokenKey) {
    _currentTokenKey = tokenKey;
    const cfg = CREDIT_CONFIG[tokenKey];
    if (!cfg) return;

    // Update modal header
    const icon = document.getElementById('ctm-icon');
    const title = document.getElementById('ctm-title');
    if (icon) { icon.className = `fa ${cfg.icon} text-${cfg.color}-400`; }
    if (title) title.textContent = 'Buy ' + cfg.label;

    // Update rate/min info
    const rateEl = document.getElementById('ctm-rate');
    const minEl = document.getElementById('ctm-min');
    if (rateEl) rateEl.textContent = cfg.price_label;
    if (minEl) minEl.textContent = cfg.min_qty.toLocaleString() + ' ' + cfg.unit + ' ($' + computeAmount(tokenKey, cfg.min_qty).toFixed(2) + ')';

    // Set qty input defaults
    const qtyInput = document.getElementById('ctm-qty');
    if (qtyInput) {
      qtyInput.min = cfg.min_qty;
      qtyInput.step = cfg.step;
      qtyInput.value = cfg.min_qty;
    }

    // Update tab highlighting
    ['voice_min','sms_msg','ai_credit','wa_msg'].forEach(function(k) {
      const tab = document.getElementById('ctm-tab-' + k);
      if (!tab) return;
      if (k === tokenKey) {
        tab.className = 'ctm-tab text-xs font-bold py-2 rounded-lg transition bg-indigo-600 text-white';
      } else {
        tab.className = 'ctm-tab text-xs font-bold py-2 rounded-lg transition text-slate-400 hover:text-white';
      }
    });

    _updatePreview();
  }

  function _updatePreview() {
    const qtyInput = document.getElementById('ctm-qty');
    const totalEl = document.getElementById('ctm-total');
    const errEl = document.getElementById('ctm-qty-err');
    if (!qtyInput || !totalEl) return;

    const qty = parseInt(qtyInput.value, 10);
    const cfg = CREDIT_CONFIG[_currentTokenKey];
    if (!cfg) return;

    if (isNaN(qty) || qty < cfg.min_qty) {
      if (errEl) { errEl.textContent = 'Minimum: ' + cfg.min_qty.toLocaleString() + ' ' + cfg.unit; errEl.classList.remove('hidden'); }
      totalEl.textContent = '$0.00';
      return;
    }
    if (errEl) errEl.classList.add('hidden');
    const amount = computeAmount(_currentTokenKey, qty);
    totalEl.textContent = '$' + amount.toFixed(2);
  }

  async function _proceed() {
    const qtyInput = document.getElementById('ctm-qty');
    const errEl = document.getElementById('ctm-qty-err');
    const btn = document.getElementById('ctm-pay-btn');
    if (!qtyInput) return;

    const qty = parseInt(qtyInput.value, 10);
    const cfg = CREDIT_CONFIG[_currentTokenKey];
    if (isNaN(qty) || qty < cfg.min_qty) {
      if (errEl) { errEl.textContent = 'Minimum: ' + cfg.min_qty.toLocaleString() + ' ' + cfg.unit; errEl.classList.remove('hidden'); }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Creating order...'; }

    try {
      const { data: result, error: fnErr } = await _sb.functions.invoke('create-credit-topup-order', {
        body: { token_key: _currentTokenKey, quantity: qty },
      });

      if (fnErr) throw new Error(fnErr.message || String(fnErr));
      if (!result || !result.intent_id) {
        const errMsg = result?.error
          ? (typeof result.error === 'string' ? result.error : result.error.message || JSON.stringify(result.error))
          : result?.message || 'Failed to create order';
        throw new Error(errMsg);
      }

      window.location.href = 'payment.html?intent_id=' + result.intent_id;
    } catch (err) {
      if (errEl) { errEl.textContent = 'Error: ' + err.message; errEl.classList.remove('hidden'); }
      if (btn) { btn.disabled = false; btn.textContent = 'Proceed to Payment'; }
    }
  }

  function _checkBanners(primaryTokenKey) {
    const banner = document.getElementById('credit-low-banner');
    const bannerText = document.getElementById('credit-low-banner-text');
    if (!banner || !bannerText) return;

    // Check primary token key first, then all others
    const checkOrder = primaryTokenKey
      ? [primaryTokenKey, ...Object.keys(LOW_THRESHOLDS).filter(function(k) { return k !== primaryTokenKey; })]
      : Object.keys(LOW_THRESHOLDS);

    for (const key of checkOrder) {
      const balance = _wallets[key];
      const threshold = LOW_THRESHOLDS[key];
      if (balance !== undefined && balance < threshold) {
        const cfg = CREDIT_CONFIG[key];
        window.Credits._lowKey = key;
        bannerText.textContent = 'Low ' + cfg.label + ' — only ' + Number(balance).toLocaleString() + ' remaining. Top up to avoid service interruption.';
        banner.classList.remove('hidden');
        return;
      }
    }
  }

  function _renderWalletCards(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const keys = ['voice_min', 'sms_msg', 'ai_credit', 'wa_msg'];
    container.innerHTML = keys.map(function(key) {
      const cfg = CREDIT_CONFIG[key];
      const balance = _wallets[key] !== undefined ? Number(_wallets[key]) : 0;
      const isLow = balance < LOW_THRESHOLDS[key];
      return `
        <div class="bg-slate-800/60 border ${isLow ? 'border-red-700/50' : 'border-white/10'} rounded-xl p-4">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <i class="fa ${cfg.icon} text-${cfg.color}-400 text-sm"></i>
              <span class="text-slate-400 text-xs font-bold uppercase tracking-wider">${cfg.label}</span>
            </div>
            <button onclick="window.Credits.showTopupModal('${key}')"
              class="text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-2 py-1 rounded-lg transition">
              + Buy
            </button>
          </div>
          <p class="${isLow ? 'text-red-400' : 'text-white'} text-xl font-bold">${balance.toLocaleString()}</p>
          <p class="text-[10px] text-slate-500 mt-0.5">${cfg.unit} available${isLow ? ' — running low' : ''}</p>
        </div>`;
    }).join('');
  }

  // Expose public API
  window.Credits.initCreditWallet = initCreditWallet;
  window.Credits.refresh = refresh;
  window.Credits.showTopupModal = showTopupModal;
  window.Credits.closeModal = closeModal;
  window.Credits._selectType = _selectType;
  window.Credits._updatePreview = _updatePreview;
  window.Credits._proceed = _proceed;

})(window);
