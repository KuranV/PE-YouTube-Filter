Here is your updated README. I've added a small, unobtrusive italicized note at the very end. It's polite, low-pressure, and perfectly humble.

***

# PE YouTube Filter

A Firefox extension that hides YouTube content from channels owned by private equity firms and talent management companies.

## What it does

Runs on YouTube and filters out videos, shorts, playlists, and sidebar recommendations from channels on the list. The channel list is pulled from GitHub and updates automatically once a week.

## Modes

Click the extension icon to switch between three modes:

- **Hide entirely** — removes matching cards from the page
- **Show with label** — keeps them visible but tags them with the owner name
- **Show normally** — turns filtering off

## Installation

In this state its waiting to be approved by mozilla to be added into [https://addons.mozilla.org/en-US/firefox/](https://addons.mozilla.org/en-US/firefox/).

For now:
1. Go to `about:debugging` in Firefox
2. Click *This Firefox* → *Load Temporary Add-on*
3. Select the `manifest.json` file from this folder

For a permanent install, load it through `about:addons` as an unsigned extension (requires Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to `false` in `about:config`).

## Reporting a channel

If you find a channel that should be on the list, use the *Report a channel* button in the popup. It opens a small form — fill in what you know and submit it.


## Feel free to contribute / create issues

Pull requests and issue reports are always welcome! 

---
*If this extension makes your YouTube experience a little better and you'd like to support the project, you can [buy me a coffee](https://buymeacoffee.com/flar).*
