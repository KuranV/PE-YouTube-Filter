/*
 * PE YouTube Filter — Cloudflare Worker
 *
 * POST /report  — accept a channel report from the extension
 * Cron (daily)  — find channels that hit the threshold and open one GitHub PR
 *
 * Required secrets (set via `wrangler secret put`):
 *   GITHUB_TOKEN  — fine-grained PAT with Contents + Pull requests write on the repo
 *
 * Required D1 binding: DB  (see wrangler.toml)
 */

const REPO_OWNER       = 'KuranV';
const REPO_NAME        = 'PE-YouTube-Filter';
const REPORT_THRESHOLD = 10;  // reports needed before a PR is opened

// ── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ── ENTRY POINT ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/report') {
      return handleReport(request, env);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(processPending(env));
  },
};

// ── POST /report ──────────────────────────────────────────────────────────────

async function handleReport(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { channelName, channelUrl, channelId, suspectedOwner, sourceUrl } = body;

  if (!channelName || !channelUrl || !suspectedOwner) {
    return json({ error: 'channelName, channelUrl and suspectedOwner are required' }, 400);
  }

  if (!isYouTubeUrl(channelUrl)) {
    return json({ error: 'channelUrl must be a youtube.com URL' }, 400);
  }

  const channelKey = channelId || channelName.toLowerCase();
  const submitterIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = new Date().toISOString();

  // Insert individual report — ignore if same IP already reported this channel.
  try {
    await env.DB.prepare(`
      INSERT INTO reports (channel_key, channel_id, channel_name, channel_url,
                           suspected_owner, source_url, submitted_at, submitter_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(channelKey, channelId || null, channelName, channelUrl,
            suspectedOwner, sourceUrl || null, now, submitterIp).run();
  } catch (err) {
    // UNIQUE constraint hit — same IP already reported this channel.
    if (err.message && err.message.includes('UNIQUE')) {
      return json({ ok: true, duplicate: true });
    }
    throw err;
  }

  // Upsert into the channels aggregate table.
  await env.DB.prepare(`
    INSERT INTO channels (channel_key, channel_id, channel_name, channel_url,
                          suspected_owner, source_url, report_count,
                          first_reported, last_reported)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(channel_key) DO UPDATE SET
      report_count = report_count + 1,
      last_reported = excluded.last_reported
  `).bind(channelKey, channelId || null, channelName, channelUrl,
          suspectedOwner, sourceUrl || null, now, now).run();

  return json({ ok: true });
}

// ── CRON — process pending channels ──────────────────────────────────────────

async function processPending(env) {
  const { results } = await env.DB.prepare(`
    SELECT * FROM channels
    WHERE report_count >= ? AND pr_created = 0
  `).bind(REPORT_THRESHOLD).all();

  if (!results || results.length === 0) return;

  try {
    await createPR(env, results);
    const keys = results.map(r => r.channel_key);
    const placeholders = keys.map(() => '?').join(',');
    await env.DB.prepare(`
      UPDATE channels SET pr_created = 1 WHERE channel_key IN (${placeholders})
    `).bind(...keys).run();
  } catch (err) {
    console.error('[PE Worker] PR creation failed:', err);
  }
}

// ── GITHUB PR CREATION ────────────────────────────────────────────────────────

async function createPR(env, channels) {
  const token = env.GITHUB_TOKEN;
  const base = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'PE-YouTube-Filter-Worker',
    'Content-Type': 'application/json',
  };

  // 1. Get main branch SHA.
  const refResp = await ghFetch(`${base}/git/ref/heads/main`, headers);
  const mainSha = refResp.object.sha;

  // 2. Create a new branch.
  const branch = `auto-report-${Date.now()}`;
  await ghFetch(`${base}/git/refs`, headers, {
    ref: `refs/heads/${branch}`,
    sha: mainSha,
  });

  // 3. Get current channels.json.
  const fileResp = await ghFetch(`${base}/contents/channels.json`, headers);
  const currentJson = JSON.parse(atob(fileResp.content.replace(/\n/g, '')));

  // 4. Build new entries and append them.
  const today = new Date().toISOString().slice(0, 10);
  const existingKeys = new Set([
    ...currentJson.channels.map(c => c.channelId).filter(Boolean),
    ...currentJson.channels.map(c => c.channelName.toLowerCase()),
  ]);

  const newChannels = channels.filter(c => {
    return !existingKeys.has(c.channel_id) && !existingKeys.has(c.channel_name.toLowerCase());
  });

  if (newChannels.length === 0) return;

  for (const c of newChannels) {
    currentJson.channels.push({
      channelName:   c.channel_name,
      channelId:     c.channel_id || '',
      owner:         c.suspected_owner,
      ownershipType: 'unknown',
      reportCount:   c.report_count,
      source:        c.source_url || '',
      dateAdded:     today,
    });
  }

  currentJson.updated = today;

  // 5. Push updated file to the new branch.
  const updatedContent = btoa(unescape(encodeURIComponent(
    JSON.stringify(currentJson, null, 2) + '\n'
  )));

  await ghFetch(`${base}/contents/channels.json`, headers, {
    message: `Add ${newChannels.length} community-reported channel(s)`,
    content: updatedContent,
    sha:     fileResp.sha,
    branch,
  }, 'PUT');

  // 6. Open the PR.
  const names = newChannels.map(c => `- ${c.channel_name}`).join('\n');
  await ghFetch(`${base}/pulls`, headers, {
    title: `[auto] Add ${newChannels.length} community-reported channel(s)`,
    body:  `Channels that reached ${REPORT_THRESHOLD} user reports:\n\n${names}\n\n_Opened automatically by the PE YouTube Filter Worker._`,
    head:  branch,
    base:  'main',
  });
}

async function ghFetch(url, headers, body, method) {
  const opts = {
    method: method || (body ? 'POST' : 'GET'),
    headers,
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub ${opts.method} ${url} → ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com' || u.hostname === 'youtu.be';
  } catch {
    return false;
  }
}
