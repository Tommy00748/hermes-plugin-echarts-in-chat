# echarts-in-chat

Render ```` ```echarts ```` code blocks in the Hermes Desktop conversation stream
as **live, interactive charts** — zoomable, legend-filterable, resize-aware.

A desktop plugin for the
[`@hermes/plugin-sdk`](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk).

## What it demonstrates

- **Message-stream DOM injection** — turning a rendered code block into a live
  component inside the chat (a pure-frontend plugin pattern).
- **Surviving reloads** — a global singleton so repeated ⌘K reloads never stack
  duplicate observers or double-process blocks.
- **Race-free claiming** — `pre.replaceWith(div)` happens synchronously in the
  scan callback, so stale plugin instances can never steal a block mid-await.
- **Shiki quirks** — content sniffing (shiki renders no language label),
  the 120px scroll wrapper trap, and async-highlight observation via
  full-body scans + debounce + interval backstop.
- **Blob-URL reality** — plugins execute from a `blob:file://` URL, so relative
  imports fail; the optional local ECharts file is loaded by absolute path.

## Install

This repository is a Hermes **unified package** (`plugin.yaml` plus a
`desktop/plugin.js` entry point).

Install from GitHub:

```bash
hermes plugins install Tommy00748/hermes-plugin-echarts-in-chat
```

Or clone it manually into the plugin package root:

```bash
git clone https://github.com/Tommy00748/hermes-plugin-echarts-in-chat \
  ~/.hermes/plugins/echarts-in-chat
```

Then enable it in **Desktop → Capabilities → Plugins** (or ⌘K → **Reload
desktop plugins**) and restart the app if the chat does not pick it up.

If you only want the desktop half, you can also drop it into the standalone
desktop-plugin root: copy `desktop/plugin.js` and `vendor/` to
`~/.hermes/desktop-plugins/echarts-in-chat/`.

## Usage

In any chat message, include a code block with language `echarts` whose content
is a valid ECharts option JSON:

````markdown
```echarts
{
  "title": { "text": "Weekly sales", "left": "center" },
  "tooltip": {},
  "legend": { "bottom": 0 },
  "xAxis": { "type": "category", "data": ["Mon", "Tue", "Wed", "Thu", "Fri"] },
  "yAxis": { "type": "value" },
  "dataZoom": [{ "type": "slider" }],
  "series": [{ "type": "bar", "data": [120, 200, 150, 80, 70] }]
}
```
````

The block is replaced by a 400px-tall interactive chart (option
`"hermesHeight"` overrides, clamped to 280–560px).

## ECharts loading

The plugin loads ECharts from the jsDelivr CDN by default. For offline use or
slow networks, download `echarts.min.js` (v5.5.0, Apache-2.0) into the plugin's
`vendor/` folder and set `ECHARTS_LOCAL_VENDOR` at the top of
`desktop/plugin.js` to its absolute `file://` path.

## Disclosure (what this plugin does to your machine)

In the spirit of the Hermes catalog admission rules, this plugin discloses:

- **Third-party network calls.** On the first chart it renders, it fetches
  ECharts 5.5.0 from `https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js`
  by injecting a `<script>` tag. Nothing else is sent anywhere — no telemetry,
  no analytics, no account data. Set `ECHARTS_LOCAL_VENDOR` to a local
  `echarts.min.js` path to avoid the CDN entirely (the shipped
  `vendor/echarts.min.js` is bundled for exactly this).
- **Reads/writes outside the plugin's own data.** It observes the Desktop
  chat transcript DOM (`document.body` MutationObserver) and replaces
  `<pre>` blocks whose content is ECharts option JSON with chart containers.
  It also adds one global CSS rule so the chart is not clipped by the code
  block's 120px scroll wrapper.
- **Background activity.** While enabled it keeps a MutationObserver and a
  3-second `setInterval` scan running to catch virtualized list re-creations.
- **Shell commands.** None. The plugin never runs shell commands.
- **Stored credentials.** None. It reads no environment variables and stores
  no secrets.

## Catalog status

This plugin uses two mechanisms that the Hermes catalog admission rule 8
(`desktop/plugin.js` stays inside the plugin SDK surface) refuses:
the `<script>`-tag load from the CDN and the `document.body` MutationObserver.
`hermes plugins validate` therefore fails the `desktop surface` check, so the
plugin is published as a standalone repo and is **not** submitted to the
plugin catalog in this form. Making it catalog-admissible requires an
SDK-provided way to render a chart component in the transcript (for example
the transcript-directive area) plus an SDK-provided way to load the chart
library, instead of a CDN script tag.

## License

MIT — see [LICENSE](LICENSE).
