# RSS Live Links MV3 — Privacy Policy

Last updated: 2026-10-28

RSS Live Links MV3 is a fork of the "RSS Live Links" browser extension. It is a
local RSS/Atom/JSON Feed reader: your subscriptions, read states and options are
stored inside your own browser profile. **The developer does not operate any
server, does not receive your data, and does not collect analytics, usage
statistics, advertising identifiers or account information.**

## Data the extension stores

Stored locally (extension storage / localStorage) and never uploaded to the
developer:

* the feed URLs you subscribe to, their titles, icons and cached items;
* read / unseen states and unread counters;
* your option settings (fonts, refresh intervals, groups, etc.).

Uninstalling the extension removes this data.

If you enable the "Use bookmark folder" option, feed items are also mirrored into
a bookmark folder in your browser profile. That data stays in your browser and is
subject to your browser's own sync settings.

## Network requests the extension makes

The extension has to perform network requests to work. All of them are triggered
by your own actions (subscribing, refreshing, opening a page) and go to third
parties, not to the developer:

1. **Feed downloads** — it requests the feed URLs you subscribed to, directly
   from those sites.
2. **CORS proxy fallback** — if a feed cannot be fetched directly because of the
   browser's cross-origin restrictions, the request is retried through one of
   several public CORS proxy services. In that case the feed URL is disclosed to
   that proxy service.
3. **Favicons** — feed icons are loaded from Google's favicon service
   (`https://www.google.com/s2/favicons?domain=...`), which discloses the feed's
   domain name to Google.
4. **Feed discovery** — when you open a web page, the extension reads that page's
   HTML for feed links and may request a small number of common feed paths
   (for example `/feed` or `/rss`) on the same site you are visiting, in order to
   detect feeds the page does not advertise. These requests go to the site you
   are already visiting. Results are cached for 5 minutes per site.
5. **Release notes / help links** — opening these links simply opens the
   corresponding page in a new tab.

The extension does not use remote code, does not inject ads, and does not track
your browsing history beyond the current tab's URL, which is used only to
discover feeds for the page you are viewing.

## Permissions and why they are needed

| Permission | Purpose |
| --- | --- |
| `tabs` | detect feed links for the page in the active tab, open items in tabs |
| `bookmarks` | optional two-way sync of feed state with bookmark folders |
| `storage` | store subscriptions, items and options locally |
| `scripting` | re-inject the feed detector into already-open tabs after an update |
| `contextMenus` | popup context menu actions |
| `http://*/*`, `https://*/*` | feeds can live on any site, so feed discovery and fetching cannot be limited to a fixed list of hosts |

## Contact

Questions about this policy: `<https://github.com/rzhy1/RSSLiveLinks-MV3>`.
