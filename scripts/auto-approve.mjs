#!/usr/bin/env node
/*
 * PE YouTube Filter — auto-approval workflow
 *
 * Logic (from spec §6.2):
 *   1. List all open issues labeled "channel-report".
 *   2. Parse each issue body for channelId, channelName, suspectedOwner,
 *      and the "Reported by" GitHub username.
 *   3. Group by channelId (fallback to channelName if ID missing).
 *   4. Count unique reporters per group.
 *   5. For each group with >= threshold unique reporters that isn't already
 *      in channels.json, append an entry.
 *   6. Close the issues for approved channels.
 *   7. (The workflow commits the updated channels.json separately.)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.env.REPO_OWNER;
const REPO = process.env.REPO_NAME;
const THRESHOLD = parseInt(process.env.APPROVAL_THRESHOLD || '10', 10);
const CHANNELS_PATH = 'channels.json';

if (!TOKEN || !OWNER || !REPO) {
  console.error('Missing GITHUB_TOKEN, REPO_OWNER, or REPO_NAME env vars.');
  process.exit(1);
}

const API = 'https://api.github.com';
const ghHeaders = {
  'Authorization': `Bearer ${TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'pe-filter-auto-approve',
  'X-GitHub-Api-Version': '2022-11-28'
};

async function ghFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  const resp = await fetch(url, { ...opts, headers: { ...ghHeaders, ...(opts.headers || {}) } });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub ${resp.status} on ${url}: ${text.slice(0, 300)}`);
  }
  return resp;
}

async function listChannelReportIssues() {
  const issues = [];
  let page = 1;
  while (true) {
    const resp = await ghFetch(`/repos/${OWNER}/${REPO}/issues?state=open&labels=channel-report&per_page=100&page=${page}`);
    const batch = await resp.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    // The issues API also returns PRs — filter them out.
    for (const item of batch) {
      if (!item.pull_request) issues.push(item);
    }
    if (batch.length < 100) break;
    page++;
    if (page > 50) break; // safety
  }
  return issues;
}

/**
 * Extract the structured fields from an issue body. We're lenient about
 * whitespace and case but strict about the bold label structure the
 * extension produces.
 */
function parseIssue(issue) {
  const body = issue.body || '';
  const get = (label) => {
    const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+?)\\s*(?:\\n|$)`, 'i');
    const m = body.match(re);
    return m ? m[1].trim() : '';
  };
  const channelName = get('Channel Name');
  const channelUrl = get('Channel URL');
  const channelId = get('Channel ID').replace(/\(not provided\)/i, '').trim();
  const suspectedOwner = get('Suspected Owner');
  const reportedBy = get('Reported by').replace(/^@/, '').trim();

  // Trust the issue author as the source of truth for the reporter —
  // the body field is self-reported and could be spoofed, but the issue's
  // `user.login` cannot.
  const reporterLogin = (issue.user && issue.user.login) || reportedBy;

  return {
    issueNumber: issue.number,
    channelName,
    channelUrl,
    channelId,
    suspectedOwner,
    reporterLogin
  };
}

function modeString(strings) {
  const counts = new Map();
  let best = null, bestCount = 0;
  for (const s of strings) {
    if (!s) continue;
    const c = (counts.get(s) || 0) + 1;
    counts.set(s, c);
    if (c > bestCount) { best = s; bestCount = c; }
  }
  return best;
}

async function main() {
  const issues = await listChannelReportIssues();
  console.log(`Found ${issues.length} open channel-report issues.`);

  const parsed = issues.map(parseIssue).filter(p => p.channelName || p.channelId);

  // Group by channelId where available, else by lowercased channelName.
  const groups = new Map();
  for (const p of parsed) {
    const key = p.channelId || `name:${(p.channelName || '').toLowerCase()}`;
    if (!key || key === 'name:') continue;
    if (!groups.has(key)) groups.set(key, { key, reports: [] });
    groups.get(key).reports.push(p);
  }

  // Load current channels.json.
  const raw = await readFile(CHANNELS_PATH, 'utf8');
  const channelsDoc = JSON.parse(raw);
  const channels = Array.isArray(channelsDoc.channels) ? channelsDoc.channels : [];

  const existingIds = new Set(channels.filter(c => c.channelId).map(c => c.channelId));
  const existingNames = new Set(channels.map(c => (c.channelName || '').toLowerCase()).filter(Boolean));

  const today = new Date().toISOString().slice(0, 10);
  const approved = [];

  for (const group of groups.values()) {
    const uniqueReporters = new Set(group.reports.map(r => r.reporterLogin).filter(Boolean));
    const count = uniqueReporters.size;
    console.log(`  ${group.key}: ${count} unique reporters (${group.reports.length} reports)`);
    if (count < THRESHOLD) continue;

    // Pick the most common channelId, channelName, and suspectedOwner.
    const channelId = modeString(group.reports.map(r => r.channelId)) || '';
    const channelName = modeString(group.reports.map(r => r.channelName)) || '';
    const suspectedOwner = modeString(group.reports.map(r => r.suspectedOwner)) || 'unknown';

    // Skip if already in the list (matched by id OR by name).
    if (channelId && existingIds.has(channelId)) {
      console.log(`    already in list by id (${channelId}), skipping`);
      continue;
    }
    if (!channelId && channelName && existingNames.has(channelName.toLowerCase())) {
      console.log(`    already in list by name (${channelName}), skipping`);
      continue;
    }

    const entry = {
      channelName,
      channelId,
      owner: suspectedOwner,
      ownershipType: 'unknown',
      reportCount: count,
      source: '',
      dateAdded: today
    };
    channels.push(entry);
    if (channelId) existingIds.add(channelId);
    if (channelName) existingNames.add(channelName.toLowerCase());
    approved.push({ group, entry });
    console.log(`    APPROVED: ${channelName} (${suspectedOwner})`);
  }

  if (approved.length === 0) {
    console.log('No new channels to approve.');
    return;
  }

  // Bump the top-level version field so the extension picks up the change.
  channelsDoc.version = (typeof channelsDoc.version === 'number' ? channelsDoc.version : 0) + 1;
  channelsDoc.updated = today;
  channelsDoc.channels = channels;

  await writeFile(CHANNELS_PATH, JSON.stringify(channelsDoc, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${approved.length} new entries to ${CHANNELS_PATH}. New version: ${channelsDoc.version}`);

  // Close the related issues.
  for (const { group } of approved) {
    for (const r of group.reports) {
      try {
        await ghFetch(`/repos/${OWNER}/${REPO}/issues/${r.issueNumber}/comments`, {
          method: 'POST',
          body: JSON.stringify({
            body: 'This channel has been auto-approved after 10 unique reports and added to the list.'
          })
        });
        await ghFetch(`/repos/${OWNER}/${REPO}/issues/${r.issueNumber}`, {
          method: 'PATCH',
          body: JSON.stringify({ state: 'closed', state_reason: 'completed' })
        });
        console.log(`  closed #${r.issueNumber}`);
      } catch (err) {
        console.warn(`  failed to close #${r.issueNumber}: ${err.message}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
