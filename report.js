/* PE YouTube Filter — report form */

const WORKER_URL = 'https://pe-youtube-filter.pe-yt-filter.workers.dev';

const form       = document.getElementById('report-form');
const submitBtn  = document.getElementById('submit-btn');
const closeBtn   = document.getElementById('close-btn');
const errorBox   = document.getElementById('error-box');
const successBox = document.getElementById('success');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}
function clearError() {
  errorBox.classList.add('hidden');
  errorBox.textContent = '';
}

closeBtn.addEventListener('click', () => window.close());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const channelName   = document.getElementById('channel-name').value.trim();
  const channelUrl    = document.getElementById('channel-url').value.trim();
  const suspectedOwner = document.getElementById('suspected-owner').value.trim();
  const sourceUrl     = document.getElementById('source-url').value.trim();

  const channelId = extractChannelId(channelUrl);

  // Local dedup — prevent submitting the same channel twice from this browser.
  const { reportedChannels = [] } = await browser.storage.local.get('reportedChannels');
  const dedupeKey = channelId || channelName.toLowerCase();
  if (reportedChannels.includes(dedupeKey)) {
    showError('You have already reported this channel.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';

  try {
    const resp = await fetch(`${WORKER_URL}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelName, channelUrl, channelId, suspectedOwner, sourceUrl }),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      showError(data.error || `Server error (${resp.status}). Please try again.`);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit report';
      return;
    }

    reportedChannels.push(dedupeKey);
    await browser.storage.local.set({ reportedChannels });

    form.classList.add('hidden');
    successBox.classList.remove('hidden');
  } catch (err) {
    showError('Network error: ' + err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit report';
  }
});

function extractChannelId(url) {
  try {
    const m = new URL(url).pathname.match(/\/channel\/(UC[\w-]{20,})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Pre-fill from query params (e.g. when opened from the content script).
(function prefill() {
  const params = new URLSearchParams(location.search);
  const chId   = params.get('channelId');
  const chName = params.get('channelName');
  if (chId)   document.getElementById('channel-url').value  = `https://www.youtube.com/channel/${chId}`;
  if (chName) document.getElementById('channel-name').value = chName;
})();
