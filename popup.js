/* PE YouTube Filter — popup logic */
if (typeof browser === 'undefined') var browser = chrome;

const $ = (sel) => document.querySelector(sel);
const modeButtons = document.querySelectorAll('.mode-btn');
const countEl = $('#count');
const counterBtn = $('#counter-btn');
const counterArrow = $('#counter-arrow');
const channelListEl = $('#channel-list');
const whitelistToggle = $('#whitelist-toggle');
const whitelistCountEl = $('#whitelist-count');
const whitelistListEl = $('#whitelist-list');
const reportBtn = $('#report-btn');
const refreshBtn = $('#refresh-btn');

let listOpen = false;
let whitelistOpen = false;
let currentChannels = [];
let activeTabId = null;

function setActiveMode(mode) {
  for (const btn of modeButtons) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-checked', btn.dataset.mode === mode ? 'true' : 'false');
  }
}

function renderChannelList(channels) {
  currentChannels = channels || [];
  const hasChannels = currentChannels.length > 0;

  countEl.textContent = currentChannels.length;
  counterBtn.classList.toggle('has-channels', hasChannels);

  if (!hasChannels) {
    listOpen = false;
    channelListEl.hidden = true;
    counterArrow.classList.remove('open');
    counterBtn.setAttribute('aria-expanded', 'false');
    return;
  }

  if (listOpen) renderChannelListItems();
}

function renderChannelListItems() {
  channelListEl.innerHTML = '';
  for (const ch of currentChannels) {
    const item = document.createElement('div');
    item.className = 'channel-list-item';

    const info = document.createElement('div');
    info.className = 'channel-list-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'channel-list-name';
    nameEl.textContent = ch.channelName;
    const ownerEl = document.createElement('div');
    ownerEl.className = 'channel-list-owner';
    ownerEl.textContent = ch.owner;
    info.append(nameEl, ownerEl);

    const ignoreBtn = document.createElement('button');
    ignoreBtn.className = 'ignore-btn';
    ignoreBtn.textContent = 'Ignore';
    item.append(info, ignoreBtn);

    const key = ch.channelName.toLowerCase();
    ignoreBtn.addEventListener('click', async () => {
      if (activeTabId) {
        await browser.tabs.sendMessage(activeTabId, { type: 'pe:whitelist-add', channelKey: key }).catch(() => {});
      }
      // Also persist directly in case message fails
      const { whitelist = [] } = await browser.storage.local.get('whitelist');
      if (!whitelist.includes(key)) {
        whitelist.push(key);
        await browser.storage.local.set({ whitelist });
      }
      currentChannels = currentChannels.filter(c => c.channelName.toLowerCase() !== key);
      renderChannelList(currentChannels);
      if (listOpen) renderChannelListItems();
      refreshWhitelist();
    });
    channelListEl.appendChild(item);
  }
}

async function refreshWhitelist() {
  const { whitelist = [] } = await browser.storage.local.get('whitelist');
  whitelistCountEl.textContent = whitelist.length;
  whitelistToggle.hidden = whitelist.length === 0;

  if (whitelistOpen) renderWhitelistItems(whitelist);
}

function renderWhitelistItems(whitelist) {
  whitelistListEl.innerHTML = '';
  if (whitelist.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'whitelist-empty';
    empty.textContent = 'No ignored channels';
    whitelistListEl.appendChild(empty);
    return;
  }
  for (const key of whitelist) {
    const item = document.createElement('div');
    item.className = 'whitelist-item';

    const keyEl = document.createElement('span');
    keyEl.className = 'whitelist-item-key';
    keyEl.textContent = key;

    const unignoreBtn = document.createElement('button');
    unignoreBtn.className = 'unignore-btn';
    unignoreBtn.textContent = 'Unignore';
    item.append(keyEl, unignoreBtn);

    unignoreBtn.addEventListener('click', async () => {
      if (activeTabId) {
        await browser.tabs.sendMessage(activeTabId, { type: 'pe:whitelist-remove', channelKey: key }).catch(() => {});
      }
      const { whitelist: wl = [] } = await browser.storage.local.get('whitelist');
      await browser.storage.local.set({ whitelist: wl.filter(k => k !== key) });
      refreshWhitelist();
    });
    whitelistListEl.appendChild(item);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function init() {
  const { mode = 'hide' } = await browser.storage.local.get('mode');
  setActiveMode(mode);

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab && /youtube\.com/.test(tab.url || '')) {
      activeTabId = tab.id;
      const resp = await browser.tabs.sendMessage(tab.id, { type: 'pe:get-count' }).catch(() => null);
      if (resp) {
        renderChannelList(resp.channels || []);
        countEl.textContent = resp.count;
      }
    }
  } catch (_) { /* not on YouTube */ }

  await refreshWhitelist();
}

// Toggle channel list on counter click
counterBtn.addEventListener('click', () => {
  if (!currentChannels.length) return;
  listOpen = !listOpen;
  channelListEl.hidden = !listOpen;
  counterArrow.classList.toggle('open', listOpen);
  counterBtn.setAttribute('aria-expanded', String(listOpen));
  if (listOpen) renderChannelListItems();
});

// Toggle whitelist section
whitelistToggle.addEventListener('click', async () => {
  whitelistOpen = !whitelistOpen;
  whitelistListEl.hidden = !whitelistOpen;
  if (whitelistOpen) {
    const { whitelist = [] } = await browser.storage.local.get('whitelist');
    renderWhitelistItems(whitelist);
  }
});

for (const btn of modeButtons) {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    await browser.storage.local.set({ mode });
    setActiveMode(mode);
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab && /youtube\.com/.test(tab.url || '')) {
        activeTabId = tab.id;
        const resp = await browser.tabs.sendMessage(tab.id, { type: 'pe:set-mode', mode });
        if (resp) {
          renderChannelList(resp.channels || []);
          countEl.textContent = resp.count;
        }
      }
    } catch (_) { /* ignore */ }
  });
}

reportBtn.addEventListener('click', async () => {
  let params = '';
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const u = new URL(tab.url);
      const chMatch = u.pathname.match(/\/channel\/(UC[\w-]{20,})/);
      if (chMatch) params = `?channelId=${encodeURIComponent(chMatch[1])}`;
    }
  } catch (_) { /* ignore */ }
  await browser.tabs.create({ url: browser.runtime.getURL('report.html') + params });
  window.close();
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.textContent = 'refreshing…';
  refreshBtn.disabled = true;
  const resp = await browser.runtime.sendMessage({ type: 'pe:refresh-channels' });
  refreshBtn.textContent = resp && resp.updated ? 'updated!' : 'up to date';
  setTimeout(() => {
    refreshBtn.textContent = 'refresh now';
    refreshBtn.disabled = false;
  }, 2000);
});

// Live count updates while popup is open
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'pe:filtered-count' && typeof msg.count === 'number') {
    renderChannelList(msg.channels || []);
    countEl.textContent = msg.count;
  }
});

init();
