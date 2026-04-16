/* PE YouTube Filter — popup logic */

const $ = (sel) => document.querySelector(sel);
const modeButtons = document.querySelectorAll('.mode-btn');
const countEl = $('#count');
const reportBtn = $('#report-btn');
const refreshBtn = $('#refresh-btn');

function setActiveMode(mode) {
  for (const btn of modeButtons) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-checked', btn.dataset.mode === mode ? 'true' : 'false');
  }
}

async function init() {
  const { mode = 'hide' } = await browser.storage.local.get('mode');
  setActiveMode(mode);

  // Ask the active content script for its current count.
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab && /youtube\.com/.test(tab.url || '')) {
      const resp = await browser.tabs.sendMessage(tab.id, { type: 'pe:get-count' }).catch(() => null);
      if (resp && typeof resp.count === 'number') countEl.textContent = resp.count;
    }
  } catch (_) { /* not on YouTube */ }
}

for (const btn of modeButtons) {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    await browser.storage.local.set({ mode });
    setActiveMode(mode);
    // Message the active tab so the change applies without reload.
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab && /youtube\.com/.test(tab.url || '')) {
        const resp = await browser.tabs.sendMessage(tab.id, { type: 'pe:set-mode', mode });
        if (resp && typeof resp.count === 'number') countEl.textContent = resp.count;
      }
    } catch (_) { /* ignore */ }
  });
}

reportBtn.addEventListener('click', async () => {
  // Pre-fill nothing at this stage — report.html will let the user type.
  // Future: capture the current video / channel page in the active tab and
  // pass ?channelId=... to the form.
  let params = '';
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const u = new URL(tab.url);
      const chMatch = u.pathname.match(/\/channel\/(UC[\w-]{20,})/);
      if (chMatch) params = `?channelId=${encodeURIComponent(chMatch[1])}`;
      else if (u.pathname === '/watch') {
        // We can't easily get the channel from here without a content script call.
        // Leave blank.
      }
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

// Live count updates while popup is open.
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'pe:filtered-count' && typeof msg.count === 'number') {
    countEl.textContent = msg.count;
  }
});

init();
