# Deezer ISRC proxy

A tiny Cloudflare Worker that lets the report look up a recording's ISRC.

You only need this if you want **Deep matching** switched on. Without it the
report still merges remixes, extended mixes, instrumentals and reordered
credits on its own — the proxy only adds the cases where the same recording is
filed under two different titles or two different primary artists.

## Why a proxy is needed

Deezer's public API sends no CORS headers, so a browser refuses to read its
responses. The Worker sits in between, adds the headers, and — because it does
the search and the track lookup in one hop and caches the answer at the edge
for 30 days — makes the whole scan several times faster than calling Deezer
from the page.

## Cost

Cloudflare's free Workers plan allows **100,000 requests per day**, resets
daily, and does not expire. One report with a few hundred duplicate titles
costs a few hundred requests, and cached tracks cost none at all.

## Deploy it (about five minutes, no command line)

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. In the dashboard go to **Compute (Workers) → Create → Start from Hello World**
   and give it a name, e.g. `deezer-isrc`.
3. Click **Deploy**, then **Edit code**.
4. Delete everything in the editor and paste the contents of
   [`deezer-proxy.js`](deezer-proxy.js).
5. `ALLOWED_ORIGINS` near the top lists the sites allowed to call the Worker.
   It already carries `https://shayco250.github.io`; add your own GitHub Pages
   address if you fork this. Any `localhost` port is allowed automatically, so
   a local test server works without editing anything.
6. Click **Deploy**. Cloudflare shows the Worker's URL, something like
   `https://deezer-isrc.<your-subdomain>.workers.dev`.

## Point the report at it

Open [`../assets/js/app.js`](../assets/js/app.js) and set the Worker URL:

```js
var DEEZER_PROXY = 'https://deezer-isrc.your-subdomain.workers.dev';
```

Leave it as `''` to keep the online lookup switched off entirely.

## Check it works

Open this in a browser — it should answer with an ISRC:

```
https://deezer-isrc.your-subdomain.workers.dev/isrc?artist=Martin%20Garrix&track=Empty
```

`/health` answers `{"ok":true}` if the Worker is up at all.

## What it returns

```json
{ "isrc": "NLZ541500123", "title": "Empty", "artists": "Martin Garrix, DubVision" }
```

`{"isrc": null}` means nothing convincing was found. The Worker checks both the
title and the artist of Deezer's answer before returning a code, because the
report merges anything sharing an ISRC without asking further questions — a
loose match here would silently fuse two different songs into one.
