/*
 * PE YouTube Filter — background (non-persistent event page)
 *
 * Responsibilities:
 *   1. On install, seed browser.storage.local with the bundled channels.json.
 *   2. Schedule a weekly refresh from the raw GitHub URL. Respect ETag /
 *      version field to skip no-op updates.
 *   3. Handle the GitHub OAuth Device Flow (start + poll) so the report
 *      page doesn't have to stay open while we wait for the user to enter
 *      the code at github.com/login/device.
 *   4. Relay messages between content scripts and the stored channel list.
 */

// ---------- CONFIG ----------
// Edit these two to point at your fork of the channel repo. The extension
// will fetch channels.json from the raw URL and submit reports as issues
// against the same repo.
const REPO_OWNER = 'REPLACE_ME_OWNER';
const REPO_NAME  = 'REPLACE_ME_REPO';
const CHANNELS_RAW_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/channels.json`;

// GitHub OAuth client_id for the Device Flow app. Device Flow doesn't use a
// client secret, so this is safe to ship in the extension source.
const GITHUB_CLIENT_ID = 'REPLACE_ME_GITHUB_OAUTH_CLIENT_ID';
const GITHUB_OAUTH_SCOPE = 'public_repo';

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

// ---------- GITHUB OAUTH — DEVICE FLOW ----------
//
// Flow:
//   1. POST https://github.com/login/device/code
//        -> { device_code, user_code, verification_uri, interval, expires_in }
//      We return user_code + verification_uri to the report page. The user
//      opens the URI and enters the code.
//   2. POST https://github.com/login/oauth/access_token (polling every `interval` seconds)
//        -> { access_token } once the user authorizes
//        -> or { error: "authorization_pending" | "slow_down" | ... } until then
//   3. Store the token in browser.storage.local.githubToken.
//
// We run the poll loop in the background so it survives the popup closing.

let activeDeviceFlow = null; // { deviceCode, interval, expiresAt, resolve }

async function startDeviceFlow() {
  // If one is already in progress and not expired, return it.
  if (activeDeviceFlow && activeDeviceFlow.expiresAt > Date.now()) {
    return {
      userCode: activeDeviceFlow.userCode,
      verificationUri: activeDeviceFlow.verificationUri,
      expiresAt: activeDeviceFlow.expiresAt
    };
  }

  const resp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_OAUTH_SCOPE })
  });
  if (!resp.ok) throw new Error(`device code request failed: ${resp.status}`);
  const data = await resp.json();

  activeDeviceFlow = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: Math.max(5, data.interval || 5),
    expiresAt: Date.now() + (data.expires_in * 1000)
  };

  // Start polling in the background (does not await).
  pollForToken().catch((e) => console.warn('[PE] device flow poll error', e));

  return {
    userCode: activeDeviceFlow.userCode,
    verificationUri: activeDeviceFlow.verificationUri,
    expiresAt: activeDeviceFlow.expiresAt
  };
}

async function pollForToken() {
  while (activeDeviceFlow && Date.now() < activeDeviceFlow.expiresAt) {
    await new Promise(r => setTimeout(r, activeDeviceFlow.interval * 1000));
    if (!activeDeviceFlow) return;

    let resp;
    try {
      resp = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: activeDeviceFlow.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      });
    } catch (err) {
      continue; // transient network — keep trying
    }

    let data;
    try { data = await resp.json(); } catch (_) { continue; }

    if (data.access_token) {
      // Fetch the username so we can store it alongside the token.
      let username = null;
      try {
        const userResp = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': `Bearer ${data.access_token}`, 'Accept': 'application/vnd.github+json' }
        });
        if (userResp.ok) {
          const u = await userResp.json();
          username = u.login;
        }
      } catch (_) { /* non-fatal */ }

      await browser.storage.local.set({
        githubToken: data.access_token,
        githubUsername: username,
        githubAuthAt: Date.now()
      });
      activeDeviceFlow = null;
      return { ok: true };
    }

    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      activeDeviceFlow.interval += 5;
      continue;
    }
    // expired, access_denied, etc. — give up.
    activeDeviceFlow = null;
    await browser.storage.local.set({ githubAuthError: data.error || 'unknown' });
    return { ok: false, error: data.error };
  }
  activeDeviceFlow = null;
}

// ---------- MESSAGE ROUTER ----------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'pe:request-channels':
      return browser.storage.local.get('channelList').then(({ channelList }) => ({ list: channelList }));
    case 'pe:refresh-channels':
      return refreshChannels();
    case 'pe:start-device-flow':
      return startDeviceFlow();
    case 'pe:check-auth':
      return browser.storage.local.get(['githubToken', 'githubUsername']).then(({ githubToken, githubUsername }) => ({
        authenticated: !!githubToken,
        username: githubUsername || null
      }));
    case 'pe:logout':
      activeDeviceFlow = null;
      return browser.storage.local.remove(['githubToken', 'githubUsername', 'githubAuthAt', 'githubAuthError'])
        .then(() => ({ ok: true }));
    case 'pe:filtered-count':
      // Forwarded from content scripts; popup listens directly, so we
      // don't need to re-broadcast. Swallow to avoid "no receiver" warnings.
      return Promise.resolve({ ok: true });
  }
});
