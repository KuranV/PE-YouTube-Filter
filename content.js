/*
 * PE YouTube Filter — content script
 *
 * Runs on all youtube.com pages. Scans rendered video cards, matches against
 * the cached channel list, and either hides them or tags them with a badge
 * depending on the user's selected mode.
 */

(() => {
  'use strict';

  const CARD_SELECTORS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-reel-item-renderer',
    'ytd-playlist-video-renderer'
  ];
  const CARD_SELECTOR_LIST = CARD_SELECTORS.join(',');
  const PROCESSED_ATTR = 'data-pe-processed';
  const MATCH_ATTR = 'data-pe-match';
  const DEBOUNCE_MS = 200;

  // Runtime state — mirrors the channel list and user prefs from storage.
  // We rebuild the lookup maps whenever the list reloads.
  const state = {
    mode: 'hide',            // 'hide' | 'label' | 'off'
    byId: new Map(),         // channelId -> channel entry
    byNameLower: new Map(),  // lowercased channelName -> channel entry
    filteredOnPage: 0,
    lastBadgeChannels: new Set() // track which cards we've badged to support toggling
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

  /**
   * Extracts a YouTube channel ID from any link. YouTube uses several URL
   * shapes: /channel/UC..., /@handle, /c/custom, /user/foo. Only /channel/
   * gives us the raw UC... id. For the rest we return null and fall back to
   * name matching.
   */
  function extractChannelIdFromHref(href) {
    if (!href) return null;
    const m = href.match(/\/channel\/(UC[\w-]{20,})/);
    return m ? m[1] : null;
  }

  /**
   * Given a card root element, finds the channel-link anchor and returns
   * { channelId, channelName, anchor }. Either field may be null.
   */
  function readCardChannel(card) {
    // Prefer a direct anchor with /channel/ in href (gives us the ID)
    const idAnchor = card.querySelector('a[href*="/channel/"]');
    let channelId = null;
    let anchor = idAnchor;
    if (idAnchor) channelId = extractChannelIdFromHref(idAnchor.getAttribute('href'));

    // Name lookup — the spec's selector #channel-name yt-formatted-string
    // works across all four card types. We also accept a text alternative.
    let nameEl = card.querySelector('#channel-name yt-formatted-string, #channel-name a');
    if (!nameEl) nameEl = card.querySelector('ytd-channel-name a, ytd-channel-name yt-formatted-string');
    const channelName = nameEl ? nameEl.textContent.trim() : null;

    // If we didn't get an ID from /channel/, try any channel-related anchor
    // (in case one is there with a UC id we missed on first pass).
    if (!channelId) {
      const anchors = card.querySelectorAll('a[href]');
      for (const a of anchors) {
        const id = extractChannelIdFromHref(a.getAttribute('href'));
        if (id) { channelId = id; if (!anchor) anchor = a; break; }
      }
    }

    return { channelId, channelName, anchor };
  }

  function findMatch(channelId, channelName) {
    if (channelId && state.byId.has(channelId)) return state.byId.get(channelId);
    if (channelName) {
      const entry = state.byNameLower.get(channelName.toLowerCase());
      if (entry) return entry;
    }
    return null;
  }

  function applyHide(card) {
    card.style.display = 'none';
    card.setAttribute(MATCH_ATTR, 'hide');
  }

  function applyLabel(card, entry) {
    card.style.display = '';
    // Avoid double-badging
    let badge = card.querySelector('.pe-filter-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'pe-filter-badge';
      // Put the badge on the thumbnail container when we can find one,
      // otherwise attach to the card itself.
      const thumb = card.querySelector('ytd-thumbnail, #thumbnail') || card;
      // Ensure host has positioning context
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

  /**
   * Process a single card. Returns true if it was matched (regardless of
   * which mode applies).
   */
  function processCard(card) {
    if (state.mode === 'off') {
      // Reset anything we previously marked — important when user toggles
      // from hide/label back to off without reloading.
      if (card.hasAttribute(MATCH_ATTR)) clearMatch(card);
      card.setAttribute(PROCESSED_ATTR, 'true');
      return false;
    }

    const { channelId, channelName } = readCardChannel(card);
    // If the card hasn't rendered its channel info yet, don't mark it
    // processed — we want the observer to revisit it once YouTube fills it in.
    if (!channelId && !channelName) return false;

    const entry = findMatch(channelId, channelName);
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
        // Still count it if it's currently matched, so the popup counter
        // reflects all matches on the page, not just newly-processed ones.
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
    // Mode changed — walk the DOM and redo everything.
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
      }).catch(() => { /* no popup open — ignore */ });
    } catch (_) { /* shutting down */ }
  }

  // --- Debounced MutationObserver ---

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

  // --- SPA navigation handling ---
  // YouTube fires yt-navigate-finish when internal navigation completes.
  // We treat it as a signal to re-scan from scratch.
  document.addEventListener('yt-navigate-finish', () => {
    // Give YouTube a beat to render the new cards.
    setTimeout(() => reprocessAll(), 300);
  });

  // --- Message handlers ---

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
      case 'pe:context-report': {
        // Right-click path from popup (future): pre-fill report form with the
        // card the user clicked. Not strictly used in v1 popup, but wired up
        // so report.html can be launched with ?channelId= or ?channelName=.
        sendResponse({ ok: true });
        return true;
      }
    }
  });

  // --- Boot ---

  async function init() {
    try {
      const stored = await browser.storage.local.get(['mode', 'channelList']);
      state.mode = stored.mode || 'hide';
      if (stored.channelList) {
        loadChannelList(stored.channelList);
      } else {
        // Storage not populated yet — ask the background page for the seed.
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
