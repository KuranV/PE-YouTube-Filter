# PE YouTube Filter

A Firefox extension that detects YouTube channels owned or managed by private equity firms / talent management companies and gives you control over how they appear in your feed. The channel list grows through crowdsourced reporting backed by GitHub Issues.


## Repo layout

```
manifest.json                       Firefox MV3 manifest
background.js                       Event page: weekly refresh, OAuth, routing
content.js                          Injected into YouTube, runs the filter
content.css                         Badge styles
popup.html / popup.js               Toolbar popup (mode toggle, counter, report)
report.html / report.js             Report form with GitHub Device Flow UX
channels.json                       Bundled seed list
icons/                              16/32/48/128 PNG icons
.github/workflows/auto-approve.yml  Daily GitHub Actions run
scripts/auto-approve.mjs            Counts reports, updates channels.json
```

## Before it works — three placeholders to replace

Search the repo for `REPLACE_ME`. There are three values that must be set:

1. **`REPO_OWNER`** (in `background.js` and `report.js`) — the GitHub org or user that hosts the channel-list repo.
2. **`REPO_NAME`** (in `background.js` and `report.js`) — the repo name, e.g. `pe-youtube-channels`.
3. **`GITHUB_CLIENT_ID`** (in `background.js`) — a GitHub OAuth App configured for the Device Flow. Create it at https://github.com/settings/developers → *New OAuth App*, then enable **Device Flow** in the app's settings page. No client secret is needed; shipping the client_id in source is safe.

Then push `channels.json`, `.github/workflows/auto-approve.yml`, and `scripts/auto-approve.mjs` to the repo you referenced in steps 1 and 2. The workflow uses the built-in `GITHUB_TOKEN` — no extra secrets.

## Running locally

1. Open Firefox → `about:debugging` → *This Firefox* → *Load Temporary Add-on…*
2. Pick `manifest.json` from this directory.
3. Open YouTube. Try switching between *Hide entirely*, *Show with label*, and *Show normally* in the popup.
4. Click *Report a channel* to test the form. Reports go to the repo as GitHub Issues.

## How it works (in a paragraph each)

**Detection.** `content.js` runs on every `youtube.com` page, walks all video cards (`ytd-rich-item-renderer`, `ytd-video-renderer`, `ytd-compact-video-renderer`, `ytd-grid-video-renderer` and a few others) *and* channel-entity cards (`ytd-channel-renderer`, `ytd-grid-channel-renderer`, `ytd-mini-channel-renderer` — the channel itself as it appears at the top of search results or in channel grids). It extracts the channel ID from `/channel/UC...` anchors, preferring ID matches but falling back to channel-name matches when YouTube serves `/@handle` URLs. When the user navigates directly to a flagged channel page (e.g. `/@Fern` or `/channel/UC...`), the extension reads the channel ID from the page's canonical `<link>` / `og:title` meta and shows either a full-page overlay (hide mode) or a sticky banner at the top of the channel header (label mode). A `MutationObserver` with a 200 ms debounce handles lazy-loaded cards, and `yt-navigate-finish` resets state on SPA navigation.

**Modes.** *Hide entirely* sets `display:none` on matching cards and shows a full-page overlay on flagged channel pages with a "Go back" / "Show anyway" choice. *Show with label* attaches a red badge to matching thumbnails and a sticky red banner at the top of flagged channel pages. *Show normally* removes any marks and stops processing. Switching modes in the popup messages the active tab; no reload needed.

**Weekly refresh.** `background.js` uses the `alarms` API to refresh `channels.json` once a week from `raw.githubusercontent.com`. It sends `If-None-Match` with the stored ETag to avoid unnecessary downloads, and also respects a `version` field if present. On update, it messages all open YouTube tabs so they pick up the new list without reload.

**Reporting.** The extension uses GitHub's OAuth Device Flow (no client secret required, safe for public extensions). `background.js` handles the full flow — hitting `/login/device/code`, polling `/login/oauth/access_token` at the GitHub-specified interval, and handling `slow_down` responses. The token is `public_repo`-scoped and stored only in `browser.storage.local`. The report form in `report.html` shows the user code and verification URL, auto-opens GitHub in a new tab, and polls for auth state so it becomes submittable the moment authorization completes.

**Auto-approval.** `scripts/auto-approve.mjs` runs daily. It lists all open issues with the `channel-report` label, parses the bold-field format from the issue body, groups by `channelId` (falling back to lowercased name if ID is missing), and counts unique `user.login` values — trusting GitHub's own issue author rather than the self-reported field. If ≥10 unique users reported a channel, the script appends an entry to `channels.json` with the most commonly reported owner name, bumps `version`, and closes the related issues with the boilerplate comment.

## Abuse resistance

The spec's threshold and the real-GitHub-account requirement do most of the work. Bulk fake reports require bulk fake accounts, which GitHub's abuse detection discourages. If it becomes a problem, raise `APPROVAL_THRESHOLD` in the workflow — no extension update needed.

## Out of scope (spec §11)

Manual channel add/remove UI, Chrome port, ML-based detection, dedicated backend, YouTube mobile app.

## Notes

- All `browser.*` APIs, not `chrome.*`. This is Firefox-only.
- `manifest.json` declares `browser_specific_settings.gecko.id` so it can be loaded via `about:debugging`.
- The extension fires unauthenticated requests only to `raw.githubusercontent.com` (for the channel list) and authenticated requests to `api.github.com` (for issue creation). Neither approaches the rate limits under normal use.
