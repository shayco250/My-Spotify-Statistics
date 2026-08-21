# Listening Report

Turn a Spotify **Extended Streaming History** export into a full listening
report — top tracks and artists, a listening calendar, time-of-day patterns,
what you had on repeat, skip habits, and per-track and per-artist histories.

Everything runs in the visitor's browser. There is no server, no upload, no
account and no database: the files are read inside the tab and never leave the
device.

## Run it locally

The report uses a Web Worker, which browsers refuse to start from a `file://`
page, so open it through a local server rather than double-clicking the HTML:

```bash
py -3 -m http.server 8765
```

Then visit <http://127.0.0.1:8765/>. (If the Worker cannot start the report
falls back to processing on the main thread, so it still works — the tab just
freezes for a moment on very large exports.)

## Publish it on GitHub Pages

1. Push this folder to GitHub.
2. **Settings → Pages → Build and deployment**, source **Deploy from a branch**,
   branch `main`, folder `/ (root)`.
3. GitHub gives you `https://<your-username>.github.io/<repo>/`.

Static hosting is free with no expiry, and because nothing runs on a server
there is no cold start — the page opens immediately every time.

## How tracks are matched

Spotify's export has no ISRC, and the same song routinely appears under several
`spotify_track_uri` values: once as a single, once on an album, once as an
extended mix, once credited to a different member of a collaboration. Counting
raw URIs splits one song into several rows.

Two rules fix this, in order:

**1. Title and artist.** The title is stripped of version markers — `- Radio
Edit`, `(Extended Mix)`, `- Remastered 2011`, `- Instrumental`, `- Unplugged`,
`(Sped Up)` and so on. The credit is split on every separator that turns up in
practice (`,` `&` `+` `and` `x` `feat.` `ft.` `with` `vs`), lower-cased,
stripped of accents and sorted, so order and punctuation stop mattering:

```
"Martin Garrix and Matisse & Sadko"  ->  {martin garrix, matisse, sadko}
"Matisse & Sadko, Martin Garrix"     ->  {martin garrix, matisse, sadko}
```

Two entries merge when they share the cleaned title **and at least one artist**.
Requiring a shared artist is what keeps "Gravity" by Martin Garrix apart from
"Gravity" by Holding Absence, while still merging a track credited to
"Martin Garrix" with the same track credited to "Martin Garrix, DubVision".

**2. ISRC, optional.** Some releases share no artist at all — the same master
put out by two labels under two primary artists. Only a recording code can
catch those, so *Deep matching* looks the track up on Deezer through a small
proxy and merges anything that comes back with the same ISRC. It is off by
default because it costs a network round trip per duplicate title; rule 1 alone
already handles most of what people notice. See
[`cloudflare-worker/README.md`](cloudflare-worker/README.md) to enable it.

Coverage is not perfect: Deezer's catalogue is thinner for some non-English
repertoire, and a track it does not carry simply stays unmerged rather than
being merged wrongly.

## What counts as a play

A **stream** is a play of at least 30 seconds — that is what the leaderboards,
streak counts and "on repeat" scoring use. **Total hours** counts every play
including the short ones, so the headline figure reflects real listening time.
Podcasts and audiobooks are dropped: they carry no track or artist name.

## Layout

```
index.html                    the page
assets/css/app.css            design tokens, light and dark
assets/js/processing.js       parsing, cleaning, track merging
assets/js/worker.js           runs processing.js off the main thread
assets/js/analytics.js        every figure on the report
assets/js/charts.js           hand-written SVG charts, no chart library
assets/js/app.js              screen flow, filters, rendering
cloudflare-worker/            optional Deezer ISRC proxy
```

`new_app.py`, `refactor.py` and `requirements.txt` are the earlier Streamlit
version, kept for reference.
