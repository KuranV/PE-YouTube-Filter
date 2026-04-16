/*
 * PE YouTube Filter — content script
 */

(() => {
  'use strict';

  const CARD_SELECTORS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-reel-item-renderer',
    'ytd-playlist-video-renderer',
    'ytd-channel-renderer',
    'yt-lockup-view-model'
  ];
  const CARD_SELECTOR_LIST = CARD_SELECTORS.join(',');
  const PROCESSED_ATTR = 'data-pe-processed';
  const MATCH_ATTR = 'data-pe-match';
  const DEBOUNCE_MS = 200;

  const state = {
    mode: 'hide',
    byId: new Map(),
    byNameLower: new Map(),
    filteredOnPage: 0,
    lastBadgeChannels: new Set(),
    whitelist: new Set(),       // channelId or channelName.toLowerCase()
    matchedEntries: new Map(),  // channelKey → { channelName, owner }
  };

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadChannelList(list) {
    state.byId.clear();
    state.byNameLower.clear();
    const channels = Array.isArray(list) ? list : (list && list.channels) || [];
    for (const entry of channels) {
      if (entry.channelId) state.byId.set(entry.channelId, entry);
      if (entry.channelName) state.byNameLower.set(entry.channelName.toLowerCase(), entry);
    }
  }

  function extractChannelIdFromHref(href) {
    if (!href) return null;
    const m = href.match(/\/channel\/(UC[\w-]{20,})/);
    return m ? m[1] : null;
  }

  function readCardChannels(card) {
    const results = [];
    const seenIds = new Set();
    const seenNames = new Set();

    const anchors = card.querySelectorAll('a[href*="/channel/"]');
    for (const a of anchors) {
      const id = extractChannelIdFromHref(a.getAttribute('href'));
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        results.push({ channelId: id, channelName: null });
      }
    }

    const nameEls = card.querySelectorAll(
      '#channel-name yt-formatted-string, #channel-name a, ' +
      'ytd-channel-name a, ytd-channel-name yt-formatted-string, ' +
      '#text-container yt-formatted-string#text, #text.ytd-channel-name'
    );
    for (const el of nameEls) {
      const name = el.textContent.trim();
      if (name && !seenNames.has(name.toLowerCase())) {
        seenNames.add(name.toLowerCase());
        results.push({ channelId: null, channelName: name });
      }
    }

    if (card.tagName && card.tagName.toLowerCase() === 'ytd-channel-renderer') {
      const titleEl = card.querySelector('#title, #channel-title, yt-formatted-string#title');
      if (titleEl) {
        const name = titleEl.textContent.trim();
        if (name && !seenNames.has(name.toLowerCase())) {
          seenNames.add(name.toLowerCase());
          results.push({ channelId: null, channelName: name });
        }
      }
    }

    if (card.tagName && card.tagName.toLowerCase() === 'yt-lockup-view-model') {
      const avatarEl = card.querySelector('[aria-label^="Go to channel "]');
      if (avatarEl) {
        const label = avatarEl.getAttribute('aria-label');
        const name = label.replace(/^Go to channel\s+/, '').trim();
        if (name && !seenNames.has(name.toLowerCase())) {
          seenNames.add(name.toLowerCase());
          results.push({ channelId: null, channelName: name });
        }
      }
      const handleLinks = card.querySelectorAll('a[href^="/@"]');
      for (const a of handleLinks) {
        const name = a.textContent.trim();
        if (name && !seenNames.has(name.toLowerCase())) {
          seenNames.add(name.toLowerCase());
          results.push({ channelId: null, channelName: name });
        }
      }
    }

    return results;
  }

  function findMatch(channelId, channelName) {
    // Skip whitelisted channels
    if (channelId && state.whitelist.has(channelId)) return null;
    if (channelName && state.whitelist.has(channelName.toLowerCase())) return null;

    if (channelId && state.byId.has(channelId)) return state.byId.get(channelId);
    if (channelName) {
      const entry = state.byNameLower.get(channelName.toLowerCase());
      if (entry) return entry;
    }
    return null;
  }

  function findAnyMatch(card) {
    const refs = readCardChannels(card);
    if (refs.length === 0) return { ready: false, entry: null };
    for (const ref of refs) {
      const entry = findMatch(ref.channelId, ref.channelName);
      if (entry) return { ready: true, entry };
    }
    return { ready: true, entry: null };
  }

  function applyHide(card) {
    card.style.display = 'none';
    card.setAttribute(MATCH_ATTR, 'hide');
  }

  function applyLabel(card, entry) {
    card.style.display = '';
    let badge = card.querySelector('.pe-filter-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'pe-filter-badge';
      const thumb = card.querySelector('ytd-thumbnail, #thumbnail') || card;
      const hostStyle = getComputedStyle(thumb);
      if (hostStyle.position === 'static') thumb.style.position = 'relative';
      thumb.appendChild(badge);
    }
    badge.textContent = `Owned by ${entry.owner}`;
    badge.title = `Ownership type: ${entry.ownershipType || 'unknown'}`;
    card.setAttribute(MATCH_ATTR, 'label');
  }

  function clearMatch(card) {
    card.style.display = '';
    const badge = card.querySelector('.pe-filter-badge');
    if (badge) badge.remove();
    card.removeAttribute(MATCH_ATTR);
  }

  function processCard(card) {
    if (state.mode === 'off') {
      if (card.hasAttribute(MATCH_ATTR)) clearMatch(card);
      card.setAttribute(PROCESSED_ATTR, 'true');
      return false;
    }

    const { ready, entry } = findAnyMatch(card);
    if (!ready) return false;

    card.setAttribute(PROCESSED_ATTR, 'true');

    if (!entry) {
      if (card.hasAttribute(MATCH_ATTR)) clearMatch(card);
      return false;
    }

    const channelKey = entry.channelId || entry.channelName.toLowerCase();
    state.matchedEntries.set(channelKey, { channelName: entry.channelName, owner: entry.owner });

    if (state.mode === 'hide') applyHide(card);
    else if (state.mode === 'label') applyLabel(card, entry);
    return true;
  }

  function scan(forceReprocess = false) {
    const cards = document.querySelectorAll(CARD_SELECTOR_LIST);
    let matched = 0;
    for (const card of cards) {
      if (forceReprocess) card.removeAttribute(PROCESSED_ATTR);
      if (card.getAttribute(PROCESSED_ATTR) === 'true') {
        if (card.hasAttribute(MATCH_ATTR) && state.mode !== 'off') matched++;
        continue;
      }
      if (processCard(card)) matched++;
    }
    if (matched !== state.filteredOnPage) {
      state.filteredOnPage = matched;
      broadcastCount();
    }
  }

  function reprocessAll() {
    state.matchedEntries.clear();
    const cards = document.querySelectorAll(CARD_SELECTOR_LIST);
    for (const card of cards) {
      card.removeAttribute(PROCESSED_ATTR);
      if (card.hasAttribute(MATCH_ATTR)) clearMatch(card);
    }
    state.filteredOnPage = 0;
    scan(true);
  }

  function broadcastCount() {
    try {
      browser.runtime.sendMessage({
        type: 'pe:filtered-count',
        count: state.filteredOnPage,
        channels: [...state.matchedEntries.values()],
      }).catch(() => {});
    } catch (_) {}
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan(false);
    }, DEBOUNCE_MS);
  }

  const observer = new MutationObserver(() => scheduleScan());

  function startObserver() {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── WHITELIST ────────────────────────────────────────────────────────────────

  async function addToWhitelist(channelKey) {
    state.whitelist.add(channelKey);
    const { whitelist = [] } = await browser.storage.local.get('whitelist');
    if (!whitelist.includes(channelKey)) whitelist.push(channelKey);
    await browser.storage.local.set({ whitelist });
    removeChannelPageUI();
    reprocessAll();
  }

  async function removeFromWhitelist(channelKey) {
    state.whitelist.delete(channelKey);
    const { whitelist = [] } = await browser.storage.local.get('whitelist');
    await browser.storage.local.set({ whitelist: whitelist.filter(k => k !== channelKey) });
    reprocessAll();
    checkChannelPage();
  }

  // ── CHANNEL PAGE ─────────────────────────────────────────────────────────────

  function isChannelPage() {
    return /^\/(channel\/UC|@|c\/|user\/)/.test(location.pathname);
  }

  function extractPageChannelId() {
    const m = location.pathname.match(/\/channel\/(UC[\w-]{20,})/);
    return m ? m[1] : null;
  }

  function extractPageChannelName() {
    const selectors = [
      '#channel-name yt-formatted-string',
      'ytd-channel-name yt-formatted-string',
      '#page-header yt-dynamic-text-view-model',
      'h1.ytd-channel-name',
      '#channel-title-container #text',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return null;
  }

  let channelPageEl = null;

  function removeChannelPageUI() {
    if (channelPageEl) { channelPageEl.remove(); channelPageEl = null; }
  }

  function showChannelPageOverlay(entry, channelKey) {
    removeChannelPageUI();
    const el = document.createElement('div');
    el.className = 'pe-channel-page-overlay';
    el.innerHTML = `
      <div class="pe-channel-page-panel">
        <span class="pe-channel-page-badge">Private Equity Owned</span>
        <h2>${escapeHtml(entry.channelName)}</h2>
        <p>This channel is owned or managed by <strong>${escapeHtml(entry.owner)}</strong>.</p>
        ${entry.ownershipType && entry.ownershipType !== 'unknown'
          ? `<p>Ownership type: <strong>${escapeHtml(entry.ownershipType)}</strong></p>` : ''}
        <div class="pe-channel-page-actions">
          <button id="pe-page-back">← Go back</button>
          <button id="pe-page-show">Show anyway</button>
        </div>
        ${entry.source
          ? `<p class="pe-channel-page-source">Source: <a href="${escapeHtml(entry.source)}" target="_blank" rel="noopener noreferrer">reference</a></p>` : ''}
      </div>
    `;
    el.querySelector('#pe-page-back').addEventListener('click', () => history.back());
    el.querySelector('#pe-page-show').addEventListener('click', () => addToWhitelist(channelKey));
    document.body.appendChild(el);
    channelPageEl = el;
  }

  function showChannelPageBanner(entry, channelKey) {
    removeChannelPageUI();
    const el = document.createElement('div');
    el.className = 'pe-channel-page-banner';
    el.innerHTML = `
      <div class="pe-channel-page-banner-text">
        <strong>${escapeHtml(entry.channelName)}</strong> is owned by
        <strong>${escapeHtml(entry.owner)}</strong>.
        ${entry.source
          ? `<a href="${escapeHtml(entry.source)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}
      </div>
      <button class="pe-banner-btn pe-banner-btn--ignore" id="pe-banner-ignore">Ignore this channel</button>
      <button class="pe-banner-btn" id="pe-banner-dismiss">✕</button>
    `;
    el.querySelector('#pe-banner-ignore').addEventListener('click', () => addToWhitelist(channelKey));
    el.querySelector('#pe-banner-dismiss').addEventListener('click', () => removeChannelPageUI());
    document.body.prepend(el);
    channelPageEl = el;
  }

  async function checkChannelPage() {
    if (state.mode === 'off') { removeChannelPageUI(); return; }
    if (!isChannelPage()) { removeChannelPageUI(); return; }

    // Fast path: channel ID is in the URL
    const pageId = extractPageChannelId();
    if (pageId) {
      const entry = findMatch(pageId, null);
      if (entry) {
        if (state.mode === 'hide') showChannelPageOverlay(entry, pageId);
        else showChannelPageBanner(entry, pageId);
      } else {
        removeChannelPageUI();
      }
      return;
    }

    // Slow path: @handle or /c/ URL — wait for the DOM to render the channel name
    for (const delay of [300, 800, 1500]) {
      await new Promise(r => setTimeout(r, delay));
      const name = extractPageChannelName();
      if (!name) continue;
      const entry = findMatch(null, name);
      if (entry) {
        const channelKey = name.toLowerCase();
        if (state.mode === 'hide') showChannelPageOverlay(entry, channelKey);
        else showChannelPageBanner(entry, channelKey);
      } else {
        removeChannelPageUI();
      }
      return;
    }
    removeChannelPageUI();
  }

  // ── NAVIGATION & OBSERVER ────────────────────────────────────────────────────

  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => {
      reprocessAll();
      checkChannelPage();
    }, 300);
  });

  // ── MESSAGE HANDLER ──────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'pe:set-mode':
        state.mode = msg.mode;
        reprocessAll();
        checkChannelPage();
        sendResponse({ ok: true, count: state.filteredOnPage, channels: [...state.matchedEntries.values()] });
        return true;
      case 'pe:channels-updated':
        loadChannelList(msg.list);
        reprocessAll();
        checkChannelPage();
        sendResponse({ ok: true });
        return true;
      case 'pe:get-count':
        sendResponse({
          count: state.filteredOnPage,
          channels: [...state.matchedEntries.values()],
        });
        return true;
      case 'pe:context-report':
        sendResponse({ ok: true });
        return true;
      case 'pe:whitelist-add':
        addToWhitelist(msg.channelKey).then(() => sendResponse({ ok: true }));
        return true;
      case 'pe:whitelist-remove':
        removeFromWhitelist(msg.channelKey).then(() => sendResponse({ ok: true }));
        return true;
    }
  });

  // ── INIT ─────────────────────────────────────────────────────────────────────

  async function init() {
    try {
      const stored = await browser.storage.local.get(['mode', 'channelList', 'whitelist']);
      state.mode = stored.mode || 'hide';
      if (stored.whitelist) {
        for (const key of stored.whitelist) state.whitelist.add(key);
      }
      if (stored.channelList) {
        loadChannelList(stored.channelList);
      } else {
        const resp = await browser.runtime.sendMessage({ type: 'pe:request-channels' });
        if (resp && resp.list) loadChannelList(resp.list);
      }
    } catch (err) {
      console.warn('[PE Filter] init error', err);
    }
    startObserver();
    scan(true);
    checkChannelPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
