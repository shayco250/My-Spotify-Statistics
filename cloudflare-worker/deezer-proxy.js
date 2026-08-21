/* =============================================================================
 * deezer-proxy.js — Cloudflare Worker
 *
 * The browser cannot call Deezer directly: their API sends no CORS headers, so
 * every request from a web page is blocked. This Worker sits in between.
 *
 * It exposes one endpoint:
 *
 *   GET /isrc?artist=Martin%20Garrix&track=Empty
 *   -> { "isrc": "NLZ541500123", "title": "Empty", "artists": "Martin Garrix, DubVision" }
 *   -> { "isrc": null }   when nothing convincing was found
 *
 * Doing the search and the track lookup here rather than in the browser halves
 * the number of round trips, and the result is cached at the edge for 30 days,
 * so popular tracks are answered without touching Deezer at all.
 *
 * Deploy: see README.md in this folder.
 * ========================================================================== */

const DEEZER = 'https://api.deezer.com';

// A real answer is worth keeping for a long time — ISRCs do not change.
// A miss is kept only briefly, so one rate-limited minute cannot poison a
// track's result for a month.
const HIT_CACHE_SECONDS = 60 * 60 * 24 * 30;   // 30 days
const MISS_CACHE_SECONDS = 60 * 10;            // 10 minutes

// Sites allowed to call this Worker. Add your own GitHub Pages URL here.
const ALLOWED_ORIGINS = [
  'https://shayco250.github.io'
];

/** Any localhost port counts as development, so a local test server works
 *  without editing this file every time the port changes. */
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  const allowed = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function json(body, origin, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
      ...extra
    }
  });
}

const norm = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

/** Guard against Deezer answering with a completely unrelated track. */
function looksLikeMatch(wanted, returned) {
  const a = norm(wanted);
  const b = norm(returned);
  if (!a || !b) return false;
  if (a === b || b.startsWith(a) || a.startsWith(b)) return true;

  // Otherwise require a decent word overlap.
  const wordsA = a.split(' ').filter((w) => w.length > 2);
  if (!wordsA.length) return false;
  const setB = new Set(b.split(' '));
  const hits = wordsA.filter((w) => setB.has(w)).length;
  return hits / wordsA.length >= 0.6;
}

/**
 * The caller merges anything sharing an ISRC without further checks, so the
 * artist has to be verified here. Deezer's artist: filter is fuzzy enough to
 * return, say, Martin Garrix's "Gravity" for a search naming Robbie Mendez \u2014
 * returning a code in that case would silently fuse two different songs.
 *
 * A match means the requested artist appears among the recording's credited
 * contributors (or is the album artist), in either direction so that
 * "Martin Garrix" still matches a credit of "Martin Garrix & DubVision".
 */
function artistMatches(wanted, contributors, mainArtist) {
  const want = norm(wanted);
  if (!want) return false;

  const candidates = [];
  if (Array.isArray(contributors)) contributors.forEach((c) => candidates.push(c && c.name));
  if (mainArtist) candidates.push(mainArtist);

  return candidates.filter(Boolean).some((name) => {
    const got = norm(name);
    if (!got) return false;
    return got === want || got.includes(want) || want.includes(got);
  });
}

/** Deezer throttles bursts. Back off and retry rather than reporting a miss,
 *  because a miss here means two versions of a song never get merged. */
async function deezerFetch(url, attempt = 0) {
  const res = await fetch(url, { cf: { cacheTtl: HIT_CACHE_SECONDS, cacheEverything: true } });
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    return deezerFetch(url, attempt + 1);
  }
  return res;
}

async function lookupIsrc(artist, track) {
  const query = `artist:"${artist.replace(/"/g, '')}" track:"${track.replace(/"/g, '')}"`;
  const searchUrl = `${DEEZER}/search?q=${encodeURIComponent(query)}&limit=1`;

  const searchRes = await deezerFetch(searchUrl);
  if (!searchRes.ok) return { isrc: null, transient: true };

  const search = await searchRes.json();
  // Deezer reports throttling in the body with a 200 status.
  if (search && search.error && search.error.code === 4) return { isrc: null, transient: true };
  if (!search || !Array.isArray(search.data) || !search.data.length) return { isrc: null };

  const hit = search.data[0];
  if (!looksLikeMatch(track, hit.title)) return { isrc: null };

  const trackRes = await deezerFetch(`${DEEZER}/track/${hit.id}`);
  if (!trackRes.ok) return { isrc: null, transient: true };

  const info = await trackRes.json();
  if (info && info.error && info.error.code === 4) return { isrc: null, transient: true };
  if (!info || !info.isrc) return { isrc: null };
  if (!artistMatches(artist, info.contributors, info.artist && info.artist.name)) {
    return { isrc: null, reason: 'artist mismatch' };
  }

  const artists = Array.isArray(info.contributors)
    ? info.contributors.map((c) => c.name).filter(Boolean).join(', ')
    : '';

  return { isrc: info.isrc, title: info.title || null, artists: artists || null };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Only GET is supported.' }, origin, 405);
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'deezer-isrc-proxy' }, origin);
    }
    if (url.pathname !== '/isrc') {
      return json({ error: 'Unknown endpoint.' }, origin, 404);
    }

    const artist = (url.searchParams.get('artist') || '').slice(0, 200).trim();
    const track = (url.searchParams.get('track') || '').slice(0, 200).trim();
    if (!artist || !track) {
      return json({ error: 'Both "artist" and "track" are required.' }, origin, 400);
    }

    // Serve a previously computed answer when we have one.
    const cache = caches.default;
    const cacheKey = new Request(
      `https://isrc.cache/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`,
      { method: 'GET' }
    );
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.json();
      return json(body, origin, 200, { 'X-Cache': 'HIT' });
    }

    let result;
    try {
      result = await lookupIsrc(artist, track);
    } catch (err) {
      return json({ isrc: null, error: 'Lookup failed.' }, origin, 200);
    }

    // Never let a throttled moment stick around as a permanent "not found".
    const ttl = result.isrc ? HIT_CACHE_SECONDS
      : (result.transient ? 0 : MISS_CACHE_SECONDS);

    if (ttl > 0) {
      await cache.put(cacheKey, new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${ttl}`
        }
      }));
    }

    return json(result, origin, 200, { 'X-Cache': 'MISS' });
  }
};
