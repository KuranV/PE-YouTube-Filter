/* Chrome/Firefox compat */
if (typeof browser === 'undefined') var browser = chrome; // eslint-disable-line no-use-before-define

/*
 * PE YouTube Filter — background (non-persistent event page)
 *
 * Responsibilities:
 *   1. On install, seed browser.storage.local with the bundled channels.json.
 *   2. Schedule a weekly refresh from the raw GitHub URL. Respect ETag /
 *      version field to skip no-op updates.
 *   3. Relay messages between content scripts and the stored channel list.
 */

// ---------- CONFIG ----------

const REPO_OWNER = 'KuranV';
const REPO_NAME  = 'PE-YouTube-Filter';
const CHANNELS_RAW_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/channels.json`;

const REFRESH_ALARM = 'pe:weekly-refresh';
const REFRESH_PERIOD_MINUTES = 7 * 24 * 60; // 1 week

// ---------- BOOT ----------

browser.runtime.onInstalled.addListener(async (details) => {
  await ensureSeeded();
  await setupAlarm();
  // On fresh install we also do an immediate fetch so the user gets the
  // latest list right away rather than waiting a week.
  if (details.reason === 'install') refreshChannels().catch(() => {});
});

browser.runtime.onStartup.addListener(async () => {
  await ensureSeeded();
  await setupAlarm();
});

async function setupAlarm() {
  const existing = await browser.alarms.get(REFRESH_ALARM);
  if (!existing) {
    browser.alarms.create(REFRESH_ALARM, {
      delayInMinutes: REFRESH_PERIOD_MINUTES,
      periodInMinutes: REFRESH_PERIOD_MINUTES
    });
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) refreshChannels().catch((e) => console.warn('[PE] refresh failed', e));
});

async function ensureSeeded() {
  const { channelList, mode } = await browser.storage.local.get(['channelList', 'mode']);
  if (!channelList) {
    try {
      const url = browser.runtime.getURL('channels.json');
      const resp = await fetch(url);
      const data = await resp.json();
      await browser.storage.local.set({ channelList: data });
    } catch (err) {
      console.warn('[PE] failed to seed channel list', err);
    }
  }
  if (!mode) {
    await browser.storage.local.set({ mode: 'hide' });
  }
}

// ---------- CHANNELS REFRESH ----------

async function refreshChannels() {
  const { channelListETag, channelList } = await browser.storage.local.get(['channelListETag', 'channelList']);
  const headers = { 'Cache-Control': 'no-cache' };
  if (channelListETag) headers['If-None-Match'] = channelListETag;

  let resp;
  try {
    resp = await fetch(CHANNELS_RAW_URL, { headers, cache: 'no-cache' });
  } catch (err) {
    console.warn('[PE] channel fetch error', err);
    return { updated: false, error: String(err) };
  }

  if (resp.status === 304) return { updated: false };
  if (!resp.ok) {
    console.warn('[PE] channel fetch non-OK', resp.status);
    return { updated: false, error: `HTTP ${resp.status}` };
  }

  const newETag = resp.headers.get('ETag');
  let data;
  try {
    data = await resp.json();
  } catch (err) {
    return { updated: false, error: 'invalid JSON' };
  }

  // Version check — if the JSON includes a version field, prefer that;
  // otherwise just trust the ETag change.
  const currentVersion = channelList && channelList.version;
  const newVersion = data && data.version;
  if (currentVersion != null && newVersion != null && newVersion <= currentVersion) {
    if (newETag) await browser.storage.local.set({ channelListETag: newETag });
    return { updated: false };
  }

  await browser.storage.local.set({
    channelList: data,
    channelListETag: newETag || null,
    channelListFetchedAt: Date.now()
  });

  // Tell all YouTube tabs to reload their in-memory copy.
  try {
    const tabs = await browser.tabs.query({ url: '*://*.youtube.com/*' });
    for (const tab of tabs) {
      browser.tabs.sendMessage(tab.id, { type: 'pe:channels-updated', list: data }).catch(() => {});
    }
  } catch (_) { /* ignore */ }

  return { updated: true, version: newVersion };
}

// ---------- MESSAGE ROUTER ----------

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'pe:request-channels':
      return browser.storage.local.get('channelList').then(({ channelList }) => ({ list: channelList }));
    case 'pe:refresh-channels':
      return refreshChannels();
    case 'pe:filtered-count':
      return Promise.resolve({ ok: true });
  }
});
