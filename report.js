/* PE YouTube Filter — report form logic */

// These must match background.js.
const REPO_OWNER = 'REPLACE_ME_OWNER';
const REPO_NAME  = 'REPLACE_ME_REPO';
const EXTENSION_VERSION = browser.runtime.getManifest().version;

const $ = (sel) => document.querySelector(sel);

const authUnauth = $('#auth-unauth');
const authPending = $('#auth-pending');
const authOk = $('#auth-ok');
const connectBtn = $('#connect-btn');
const cancelAuthBtn = $('#cancel-auth-btn');
const logoutBtn = $('#logout-btn');
const userCodeEl = $('#user-code');
const verificationLink = $('#verification-link');
const ghUsernameEl = $('#gh-username');
const form = $('#report-form');
const submitBtn = $('#submit-btn');
const closeBtn = $('#close-btn');
const errorBox = $('#error-box');
const successBox = $('#success');
const issueLink = $('#issue-link');

let currentAuth = { authenticated: false, username: null };
let authPollTimer = null;

function showOnly(el) {
  for (const panel of [authUnauth, authPending, authOk]) {
    panel.classList.toggle('hidden', panel !== el);
  }
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}
function clearError() { errorBox.classList.add('hidden'); errorBox.textContent = ''; }

async function refreshAuth() {
  const resp = await browser.runtime.sendMessage({ type: 'pe:check-auth' });
  currentAuth = resp || { authenticated: false, username: null };
  if (currentAuth.authenticated) {
    showOnly(authOk);
    ghUsernameEl.textContent = currentAuth.username || '(unknown)';
    submitBtn.disabled = false;
    stopAuthPoll();
  } else {
    // Only switch to the unauth panel if we aren't mid-flow.
    if (authPending.classList.contains('hidden')) showOnly(authUnauth);
    submitBtn.disabled = true;
  }
}

function startAuthPoll() {
  stopAuthPoll();
  authPollTimer = setInterval(refreshAuth, 3000);
}
function stopAuthPoll() {
  if (authPollTimer) { clearInterval(authPollTimer); authPollTimer = null; }
}

connectBtn.addEventListener('click', async () => {
  clearError();
  connectBtn.disabled = true;
  try {
    const flow = await browser.runtime.sendMessage({ type: 'pe:start-device-flow' });
    if (!flow || !flow.userCode) {
      showError('Could not start GitHub authorization. Please try again.');
      connectBtn.disabled = false;
      return;
    }
    userCodeEl.textContent = flow.userCode;
    verificationLink.href = flow.verificationUri;
    verificationLink.textContent = flow.verificationUri;
    showOnly(authPending);
    // Opening the verification URL in a new tab saves the user a step.
    browser.tabs.create({ url: flow.verificationUri }).catch(() => {});
    startAuthPoll();
  } catch (err) {
    showError('Failed to start OAuth: ' + err.message);
    connectBtn.disabled = false;
  }
});

cancelAuthBtn.addEventListener('click', async () => {
  stopAuthPoll();
  connectBtn.disabled = false;
  showOnly(authUnauth);
});

logoutBtn.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'pe:logout' });
  await refreshAuth();
});

closeBtn.addEventListener('click', () => window.close());

// ---------- SUBMIT ----------

function validateChannelUrl(url) {
  try {
    const u = new URL(url);
    if (!/youtube\.com$/.test(u.hostname) && u.hostname !== 'youtu.be') return false;
    return true;
  } catch { return false; }
}

function extractChannelIdFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/channel\/(UC[\w-]{20,})/);
    return m ? m[1] : null;
  } catch { return null; }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  if (!currentAuth.authenticated) {
    showError('You need to connect GitHub before submitting.');
    return;
  }

  const channelName = $('#channel-name').value.trim();
  const channelUrl = $('#channel-url').value.trim();
  const suspectedOwner = $('#suspected-owner').value.trim();
  const sourceUrl = $('#source-url').value.trim();

  if (!validateChannelUrl(channelUrl)) {
    showError('Channel URL must be a youtube.com URL.');
    return;
  }
  const channelId = extractChannelIdFromUrl(channelUrl) || '';

  // Duplicate check — per spec §5.3, we cache the IDs of channels this user
  // has already reported so the UI prevents double submission.
  const { reportedChannels = [] } = await browser.storage.local.get('reportedChannels');
  const dedupeKey = channelId || channelName.toLowerCase();
  if (reportedChannels.includes(dedupeKey)) {
    showError('You have already reported this channel.');
    return;
  }

  const { githubToken, githubUsername } = await browser.storage.local.get(['githubToken', 'githubUsername']);
  if (!githubToken) {
    showError('GitHub token missing. Please reconnect.');
    await refreshAuth();
    return;
  }

  const title = `[channel-report] ${channelName}${channelId ? ' — ' + channelId : ''}`;
  const body = [
    `**Channel Name:** ${channelName}`,
    `**Channel URL:** ${channelUrl}`,
    `**Channel ID:** ${channelId || '(not provided)'}`,
    `**Suspected Owner:** ${suspectedOwner}`,
    `**Source (optional):** ${sourceUrl || '(none)'}`,
    `**Reported by:** @${githubUsername || '(unknown)'}`,
    `**Extension version:** ${EXTENSION_VERSION}`
  ].join('\n');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        title,
        body,
        labels: ['channel-report']
      })
    });

    if (resp.status === 401) {
      // Token expired/revoked — clear and prompt to reconnect.
      await browser.runtime.sendMessage({ type: 'pe:logout' });
      await refreshAuth();
      showError('Your GitHub session expired. Please reconnect and try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit report';
      return;
    }
    if (!resp.ok) {
      const text = await resp.text();
      showError(`GitHub API error (${resp.status}): ${text.slice(0, 200)}`);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit report';
      return;
    }

    const issue = await resp.json();
    reportedChannels.push(dedupeKey);
    await browser.storage.local.set({ reportedChannels });

    form.classList.add('hidden');
    successBox.classList.remove('hidden');
    issueLink.href = issue.html_url;
    issueLink.textContent = `#${issue.number}`;
  } catch (err) {
    showError('Network error: ' + err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit report';
  }
});

// ---------- INIT ----------

function prefillFromQuery() {
  const params = new URLSearchParams(location.search);
  const chId = params.get('channelId');
  const chName = params.get('channelName');
  if (chId) $('#channel-url').value = `https://www.youtube.com/channel/${chId}`;
  if (chName) $('#channel-name').value = chName;
}

prefillFromQuery();
refreshAuth();
