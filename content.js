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
    'ytd-channel-renderer'        // <-- NEW: search results for channels
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
    lastBadgeChannels: new Set()
  };

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

  /**
   * Returns ALL channel references on a card — videos can have multiple
   * creators (collabs) and any one of them being on the block list should
   * match the whole card.
   *
   * Returns an array of { channelId, channelName } objects. Either field
   * may be null, but at least one will be set per entry.
   */
  function readCardChannels(card) {
    const results = [];
    const seenIds = new Set();
    const seenNames = new Set();

    // Collect every channel ID on the card.
    const anchors = card.querySelectorAll('a[href*="/channel/"]');
    for (const a of anchors) {
      const id = extractChannelIdFromHref(a.getAttribute('href'));
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        results.push({ channelId: id, channelName: null });
      }
    }

    // Collect every channel-name element on the card. ytd-channel-name is
    // repeated once per creator on collab videos, and ytd-channel-renderer
    // (search results) uses a slightly different structure.
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

    // For ytd-channel-renderer (search result channel cards), the title
    // sits in #title or #channel-title.
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

    return results;
  }

  function findMatch(channelId, channelName) {
    if (channelId && state.byId.has(channelId)) return state.byId.get(channelId);
    if (channelName) {
      const entry = state.byNameLower.get(channelName.toLowerCase());
      if (entry) return entry;
    }
    return null;
  }

  /**
   * Check every channel reference on the card and return the first match
   * we find, or null.
   */
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
    // If the card hasn't rendered any channel info yet, don't mark it
    // processed — the observer should revisit when YouTube fills it in.
    if (!ready) return false;

    card.setAttribute(PROCESSED_ATTR, 'true');

    if (!entry) {
      if (card.hasAttribute(MATCH_ATTR)) clearMatch(card);
      return false;
    }

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
        count: state.filteredOnPage
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

  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => reprocessAll(), 300);
  });

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'pe:set-mode':
        state.mode = msg.mode;
        reprocessAll();
        sendResponse({ ok: true, count: state.filteredOnPage });
        return true;
      case 'pe:channels-updated':
        loadChannelList(msg.list);
        reprocessAll();
        sendResponse({ ok: true });
        return true;
      case 'pe:get-count':
        sendResponse({ count: state.filteredOnPage });
        return true;
      case 'pe:context-report':
        sendResponse({ ok: true });
        return true;
    }
  });

  async function init() {
    try {
      const stored = await browser.storage.local.get(['mode', 'channelList']);
      state.mode = stored.mode || 'hide';
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
