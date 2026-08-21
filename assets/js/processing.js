/* =============================================================================
 * processing.js — parsing, cleaning and track-merging for Spotify
 * Extended Streaming History exports.
 *
 * Loaded twice on purpose:
 *   1. inside the Web Worker (via importScripts in worker.js)
 *   2. on the main thread (via <script>) as a fallback when Workers are
 *      unavailable, e.g. when the page is opened straight off the filesystem.
 *
 * Everything here is pure computation — no DOM access.
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------
   * Text normalisation
   * ------------------------------------------------------------------ */

  // Words that mark a *variant* of a recording rather than a different song.
  // Used to strip "- Radio Edit", "(Extended Mix)", "- Remastered 2011" …
  var VERSION_WORDS =
    '(?:remaster(?:ed)?|remix(?:ed)?|mix(?:ed)?|edit|version|live|instrumental|' +
    'acoustic|unplugged|acapella|a\\s*cappella|reprise|session|radio|extended|' +
    'club|dub|vip|rework|bootleg|demo|bonus|deluxe|original|sped\\s*up|slowed|' +
    'reverb|karaoke|cover|mono|stereo|clean|explicit|single|' +
    'feat\\.?|ft\\.?|featuring)';

  var RE_DASH_VERSION = new RegExp('\\s+-\\s+[^-]*' + VERSION_WORDS + '[^-]*$', 'i');
  var RE_BRACKET_VERSION = new RegExp(
    '\\s*[\\(\\[][^\\)\\]]*' + VERSION_WORDS + '[^\\)\\]]*[\\)\\]]', 'ig');
  var RE_TRAILING_FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;
  var RE_FEAT_CAPTURE = /(?:feat\.?|ft\.?|featuring)\s+([^()\[\]]+)/i;

  // Splits a credit string into individual artists. Handles every separator the
  // user is likely to meet: "A, B", "A & B", "A and B", "A x B", "A feat. B" …
  var RE_ARTIST_SPLIT =
    /\s*(?:,|&|\+|\/|;|·|\||、)\s*|\s+(?:feat\.?|ft\.?|featuring|with|and|x|vs\.?|versus|meets|presents)\s+/g;

  /** Lower-case, strip accents and punctuation, collapse whitespace.
   *  Keeps letters/digits of every script, so Hebrew survives intact. */
  function normText(s) {
    if (s == null) return '';
    return String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')  // combining marks left by NFKD
      .replace(/['’`´]/g, '')      // apostrophes: dont === don't
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  /** Remove version/feat suffixes so "Empty - Extended Mix" === "Empty". */
  function cleanTrackName(raw) {
    var original = String(raw == null ? '' : raw).trim();
    var name = original;
    var prev;

    // " - Radio Edit", possibly stacked: "Song - Live - Remastered 2011"
    do {
      prev = name;
      name = name.replace(RE_DASH_VERSION, '');
    } while (name !== prev && name.length);

    name = name.replace(RE_BRACKET_VERSION, '');
    name = name.replace(RE_TRAILING_FEAT, '');
    name = name
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/[\s\-–—,]+$/, '')
      .trim();

    return name.length ? name : original;
  }

  /** "Empty (feat. DubVision)" -> "DubVision" */
  function extractFeat(raw) {
    var m = RE_FEAT_CAPTURE.exec(String(raw == null ? '' : raw));
    return m ? m[1].trim() : '';
  }

  /** Credit string -> sorted, de-duplicated set of normalised artist names.
   *  Order, separators and casing are all discarded, so
   *  "Martin Garrix and Matisse & Sadko" === "Matisse & Sadko, Martin Garrix". */
  function artistTokens(s) {
    if (!s) return [];
    var t = String(s).toLowerCase().replace(/[\(\[][^\)\]]*[\)\]]/g, ' ');
    var parts = t.split(RE_ARTIST_SPLIT);
    var set = Object.create(null);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var n = normText(parts[i]);
      if (n && !set[n]) { set[n] = 1; out.push(n); }
    }
    out.sort();
    return out;
  }

  /* ---------------------------------------------------------------------
   * Platform / reason-end labelling
   * ------------------------------------------------------------------ */

  var PLATFORM_RULES = [
    [/ipad/, 'iPad'],
    [/iphone|ios/, 'iPhone'],
    [/android/, 'Android'],
    [/web_?player|webplayer/, 'Web player'],
    [/windows|win32|winnt/, 'Windows'],
    [/osx|os x|macos|macintosh/, 'Mac'],
    [/linux|ubuntu/, 'Linux'],
    [/cast|sonos|partner|speaker|alexa|google_home/, 'Speaker / Cast'],
    [/xbox|playstation|ps4|ps5/, 'Console'],
    [/tv|chromecast|roku/, 'TV']
  ];

  function platformLabel(raw) {
    if (!raw) return 'Unknown';
    var s = String(raw).toLowerCase();
    for (var i = 0; i < PLATFORM_RULES.length; i++) {
      if (PLATFORM_RULES[i][0].test(s)) return PLATFORM_RULES[i][1];
    }
    return 'Other';
  }

  var REASON_LABELS = {
    trackdone: 'Played to the end',
    fwdbtn: 'Skipped forward',
    backbtn: 'Skipped back',
    endplay: 'Stopped playback',
    logout: 'Logged out',
    remote: 'Changed remotely',
    trackerror: 'Playback error',
    unexpected_exit: 'App closed',
    unexpected_exit_while_paused: 'App closed while paused',
    playbtn: 'Pressed play',
    clickrow: 'Picked from a list',
    appload: 'App opened',
    unknown: 'Unknown'
  };

  function reasonLabel(raw) {
    if (!raw) return 'Unknown';
    // Spotify writes these with both hyphens and underscores across export
    // generations, e.g. "unexpected-exit-while-paused".
    var k = String(raw).toLowerCase().replace(/-/g, '_');
    return REASON_LABELS[k] || (k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '));
  }

  /* ---------------------------------------------------------------------
   * Union–Find, used to merge track identities
   * ------------------------------------------------------------------ */

  function makeUnionFind(n) {
    var parent = new Int32Array(n);
    for (var i = 0; i < n; i++) parent[i] = i;

    function find(x) {
      var root = x;
      while (parent[root] !== root) root = parent[root];
      while (parent[x] !== root) { var next = parent[x]; parent[x] = root; x = next; }
      return root;
    }
    function union(a, b) {
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }
    return { find: find, union: union };
  }

  /** Most frequent value in a {value: count} map. Ties break on the longer
   *  string, which tends to keep the more descriptive spelling. */
  function modeOf(counts) {
    var best = null, bestN = -1;
    for (var k in counts) {
      var n = counts[k];
      if (n > bestN || (n === bestN && best !== null && k.length > best.length)) {
        best = k; bestN = n;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------------
   * Deezer lookup (optional) — resolves an ISRC per (track, artist) pair.
   * Runs through a proxy because Deezer's API sends no CORS headers.
   * ------------------------------------------------------------------ */

  // Below this many plays a duplicate is not worth a network round trip.
  var DEEZER_MIN_PLAYS = 5;

  function fetchIsrcBatch(pairs, proxyUrl, onTick) {
    var results = new Array(pairs.length);
    var CONCURRENCY = 6;
    var next = 0, done = 0;

    return new Promise(function (resolve) {
      if (!pairs.length) { resolve(results); return; }

      function runOne() {
        var i = next++;
        if (i >= pairs.length) return Promise.resolve();

        var p = pairs[i];
        var url = proxyUrl.replace(/\/+$/, '') +
          '/isrc?artist=' + encodeURIComponent(p.artist) +
          '&track=' + encodeURIComponent(p.track);

        return fetch(url)
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; })
          .then(function (data) {
            if (data && data.isrc) results[i] = data.isrc;
            done++;
            if (onTick) onTick(done, pairs.length);
            return runOne();
          });
      }

      var lanes = [];
      for (var c = 0; c < Math.min(CONCURRENCY, pairs.length); c++) lanes.push(runOne());
      Promise.all(lanes).then(function () { resolve(results); });
    });
  }

  /* ---------------------------------------------------------------------
   * Main entry point
   * ------------------------------------------------------------------ */

  /**
   * @param {Array<File|string|Array>} inputs  files, JSON strings or arrays
   * @param {Object} opts  { deezerProxy: string|null, onProgress: fn }
   * @returns {Promise<Object>} dataset ready for analytics.js
   */
  function processFiles(inputs, opts) {
    opts = opts || {};
    var report = opts.onProgress || function () {};

    // Parallel column arrays — far lighter than one object per play.
    var ts = [], sec = [], name = [], artist = [], album = [],
        uri = [], plat = [], skip = [], shuf = [], offl = [], rend = [];

    function ingest(rows, label) {
      if (!Array.isArray(rows)) {
        throw new Error(label + ' is not a Spotify history file (expected a JSON array).');
      }
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r) continue;
        var tn = r.master_metadata_track_name;
        var an = r.master_metadata_album_artist_name;
        if (!tn || !an) continue;                 // podcasts, audiobooks, blanks

        var t = Date.parse(r.ts);
        if (!isFinite(t)) continue;

        ts.push(t);
        sec.push((r.ms_played || 0) / 1000);
        name.push(String(tn));
        artist.push(String(an));
        album.push(r.master_metadata_album_album_name ? String(r.master_metadata_album_album_name) : '');
        uri.push(r.spotify_track_uri ? String(r.spotify_track_uri) : '');
        plat.push(r.platform ? String(r.platform) : '');
        skip.push(r.skipped === true ? 1 : 0);
        shuf.push(r.shuffle === true ? 1 : 0);
        offl.push(r.offline === true ? 1 : 0);
        rend.push(r.reason_end ? String(r.reason_end) : '');
      }
    }

    // Read and parse one file at a time so the raw JSON can be collected
    // before the next one is read — this is what keeps 300 MB imports viable.
    var chain = Promise.resolve();
    inputs.forEach(function (input, idx) {
      chain = chain.then(function () {
        report({ phase: 'read', current: idx + 1, total: inputs.length,
                 label: (input && input.name) || ('file ' + (idx + 1)) });

        if (Array.isArray(input)) { ingest(input, 'input ' + (idx + 1)); return; }

        var textPromise = (typeof input === 'string')
          ? Promise.resolve(input)
          : input.text();

        return textPromise.then(function (text) {
          var parsed;
          try { parsed = JSON.parse(text); }
          catch (e) { throw new Error('Could not read ' + ((input && input.name) || 'the file') + ' — it is not valid JSON.'); }
          text = null;
          ingest(parsed, (input && input.name) || 'the file');
          parsed = null;
        });
      });
    });

    return chain.then(function () {
      if (!ts.length) {
        throw new Error('No music plays found. Make sure you uploaded the ' +
          '"Streaming_History_Audio_*.json" files from your Spotify export.');
      }
      return buildDataset({
        ts: ts, sec: sec, name: name, artist: artist, album: album, uri: uri,
        plat: plat, skip: skip, shuf: shuf, offl: offl, rend: rend
      }, opts, report);
    });
  }

  function buildDataset(cols, opts, report) {
    var n = cols.ts.length;
    report({ phase: 'dedupe', total: n });

    /* ---- 1. Drop exact duplicates coming from overlapping exports -------- */
    var seen = Object.create(null);
    var keep = new Uint8Array(n);
    var kept = 0;
    for (var i = 0; i < n; i++) {
      var k = cols.ts[i] + '|' + cols.name[i] + '|' + cols.sec[i];
      if (seen[k]) continue;
      seen[k] = 1;
      keep[i] = 1;
      kept++;
    }
    seen = null;

    /* ---- 2. Sort surviving rows by timestamp ---------------------------- */
    var order = new Int32Array(kept);
    var o = 0;
    for (i = 0; i < n; i++) if (keep[i]) order[o++] = i;
    var tsRef = cols.ts;
    Array.prototype.sort.call(order, function (a, b) { return tsRef[a] - tsRef[b]; });

    /* ---- 3. Collect one entry per distinct Spotify track URI ------------ */
    report({ phase: 'match', total: kept });

    var uriIndex = Object.create(null);   // uri string -> slot
    var slots = [];                       // { names, artists, albums, plays }
    var rowSlot = new Int32Array(kept);

    for (i = 0; i < kept; i++) {
      var src = order[i];
      var rawUri = cols.uri[src];
      // Tracks with no URI (local files) fall back to a synthetic identity.
      var key = rawUri || ('local:' + cols.name[src] + ' :: ' + cols.artist[src]);
      var slot = uriIndex[key];
      if (slot === undefined) {
        slot = slots.length;
        uriIndex[key] = slot;
        slots.push({ names: Object.create(null), artists: Object.create(null),
                     albums: Object.create(null), plays: 0 });
      }
      var S = slots[slot];
      S.names[cols.name[src]] = (S.names[cols.name[src]] || 0) + 1;
      S.artists[cols.artist[src]] = (S.artists[cols.artist[src]] || 0) + 1;
      if (cols.album[src]) S.albums[cols.album[src]] = (S.albums[cols.album[src]] || 0) + 1;
      S.plays++;
      rowSlot[i] = slot;
    }
    uriIndex = null;

    var nSlots = slots.length;
    var slotClean = new Array(nSlots);     // display title, version stripped
    var slotNorm = new Array(nSlots);      // normalised title, for matching
    var slotArtist = new Array(nSlots);    // display artist
    var slotTokens = new Array(nSlots);    // normalised artist set

    for (i = 0; i < nSlots; i++) {
      var rawName = modeOf(slots[i].names);
      var rawArtist = modeOf(slots[i].artists);
      slotClean[i] = cleanTrackName(rawName);
      slotNorm[i] = normText(slotClean[i]);
      slotArtist[i] = rawArtist;
      var credit = rawArtist;
      var feat = extractFeat(rawName);
      if (feat) credit += ', ' + feat;
      slotTokens[i] = artistTokens(credit);
    }

    /* ---- 4. Merge identities -------------------------------------------
     * Two recordings are the same song when they share a normalised title
     * AND at least one artist. That single rule covers reordered credits
     * ("A & B" vs "B, A"), different separators, extra featured artists,
     * and version suffixes — all without guessing.
     * ------------------------------------------------------------------ */
    var uf = makeUnionFind(nSlots);
    var titleBuckets = Object.create(null);

    for (i = 0; i < nSlots; i++) {
      var title = slotNorm[i];
      if (!title) continue;
      var bucket = titleBuckets[title];
      if (!bucket) bucket = titleBuckets[title] = Object.create(null);
      var toks = slotTokens[i];
      for (var t = 0; t < toks.length; t++) {
        var rep = bucket[toks[t]];
        if (rep === undefined) bucket[toks[t]] = i;
        else uf.union(rep, i);
      }
    }
    titleBuckets = null;

    /* ---- 5. Optional Deezer pass: merge by ISRC ------------------------
     * Catches the leftovers where the same recording is filed under two
     * spellings, so the title rule above could not see them.
     * ------------------------------------------------------------------ */
    var deezerPromise;
    if (opts.deezerProxy) {
      // Only bother with titles that still resolve to more than one group
      // and are played often enough to matter.
      var groupPlays = Object.create(null);
      var groupsPerTitle = Object.create(null);
      for (i = 0; i < nSlots; i++) {
        var root = uf.find(i);
        groupPlays[root] = (groupPlays[root] || 0) + slots[i].plays;
        var ttl = slotNorm[i];
        if (!ttl) continue;
        if (!groupsPerTitle[ttl]) groupsPerTitle[ttl] = Object.create(null);
        groupsPerTitle[ttl][root] = true;
      }

      var candidates = [];
      var seenRoot = Object.create(null);
      for (var ttlKey in groupsPerTitle) {
        var roots = Object.keys(groupsPerTitle[ttlKey]);
        if (roots.length < 2) continue;
        for (var ri = 0; ri < roots.length; ri++) {
          var r = +roots[ri];
          if (seenRoot[r] || (groupPlays[r] || 0) < DEEZER_MIN_PLAYS) continue;
          seenRoot[r] = true;
          candidates.push({ slot: r, track: slotClean[r], artist: slotArtist[r] });
        }
      }

      if (candidates.length) {
        report({ phase: 'deezer', current: 0, total: candidates.length });
        deezerPromise = fetchIsrcBatch(candidates, opts.deezerProxy, function (d, tot) {
          report({ phase: 'deezer', current: d, total: tot });
        }).then(function (isrcs) {
          // An ISRC identifies one specific recording, so two entries carrying
          // the same code are the same master — even when Spotify credits them
          // to different primary artists, which is exactly the case the title
          // rule above cannot see. The proxy checks the title and the artist
          // before returning a code, so a wrong code should not reach here.
          var byIsrc = Object.create(null);
          for (var c = 0; c < candidates.length; c++) {
            var code = isrcs[c];
            if (!code) continue;
            var slotIdx = candidates[c].slot;
            var other = byIsrc[code];
            if (other === undefined) byIsrc[code] = slotIdx;
            else uf.union(other, slotIdx);
          }
        });
      } else {
        deezerPromise = Promise.resolve();
      }
    } else {
      deezerPromise = Promise.resolve();
    }

    return deezerPromise.then(function () {
      return finalise(cols, order, kept, slots, slotClean, slotArtist, rowSlot, uf, report);
    });
  }

  function finalise(cols, order, kept, slots, slotClean, slotArtist, rowSlot, uf, report) {
    report({ phase: 'aggregate', total: kept });

    /* ---- Collapse union-find roots into dense track ids ----------------- */
    var nSlots = slots.length;
    var rootToTrack = Object.create(null);
    var slotTrack = new Int32Array(nSlots);
    var trackNameVotes = [], trackArtistVotes = [], trackAlbumVotes = [];

    for (var i = 0; i < nSlots; i++) {
      var root = uf.find(i);
      var tid = rootToTrack[root];
      if (tid === undefined) {
        tid = trackNameVotes.length;
        rootToTrack[root] = tid;
        trackNameVotes.push(Object.create(null));
        trackArtistVotes.push(Object.create(null));
        trackAlbumVotes.push(Object.create(null));
      }
      slotTrack[i] = tid;
      var p = slots[i].plays;
      trackNameVotes[tid][slotClean[i]] = (trackNameVotes[tid][slotClean[i]] || 0) + p;
      trackArtistVotes[tid][slotArtist[i]] = (trackArtistVotes[tid][slotArtist[i]] || 0) + p;
      for (var alb in slots[i].albums) {
        trackAlbumVotes[tid][alb] = (trackAlbumVotes[tid][alb] || 0) + slots[i].albums[alb];
      }
    }

    var nTracks = trackNameVotes.length;
    var trackName = new Array(nTracks);
    var trackArtistId = new Int32Array(nTracks);
    var trackAlbumId = new Int32Array(nTracks);
    var artistNames = [], artistIndex = Object.create(null);
    var albumNames = [], albumIndex = Object.create(null);

    for (i = 0; i < nTracks; i++) {
      trackName[i] = modeOf(trackNameVotes[i]) || '(unknown)';

      var aName = modeOf(trackArtistVotes[i]) || '(unknown)';
      var aKey = normText(aName);
      var aid = artistIndex[aKey];
      if (aid === undefined) { aid = artistNames.length; artistIndex[aKey] = aid; artistNames.push(aName); }
      trackArtistId[i] = aid;

      var albName = modeOf(trackAlbumVotes[i]);
      if (albName) {
        var albKey = normText(albName) + ' :: ' + aKey;
        var bid = albumIndex[albKey];
        if (bid === undefined) { bid = albumNames.length; albumIndex[albKey] = bid; albumNames.push(albName); }
        trackAlbumId[i] = bid;
      } else {
        trackAlbumId[i] = -1;
      }
    }

    /* ---- Build the row-level typed arrays ------------------------------- */
    var ts = new Float64Array(kept);
    var sec = new Float32Array(kept);
    var trackId = new Int32Array(kept);
    var dayNum = new Int32Array(kept);
    var year = new Int16Array(kept);
    var month = new Int8Array(kept);
    var hour = new Int8Array(kept);
    var dow = new Int8Array(kept);
    var platformId = new Int8Array(kept);
    var reasonId = new Int8Array(kept);
    var flags = new Uint8Array(kept);      // 1 skipped, 2 shuffle, 4 offline

    var platformNames = [], platformIdx = Object.create(null);
    var reasonNames = [], reasonIdx = Object.create(null);
    var d = new Date();

    for (i = 0; i < kept; i++) {
      var src = order[i];
      var t = cols.ts[src];
      ts[i] = t;
      sec[i] = cols.sec[src];
      trackId[i] = slotTrack[rowSlot[i]];

      d.setTime(t);
      year[i] = d.getFullYear();
      month[i] = d.getMonth();
      hour[i] = d.getHours();
      dow[i] = d.getDay();
      // Local calendar day, expressed as a day count so it can live in an Int32.
      dayNum[i] = Math.floor((t - d.getTimezoneOffset() * 60000) / 86400000);

      var pl = platformLabel(cols.plat[src]);
      var pid = platformIdx[pl];
      if (pid === undefined) { pid = platformNames.length; platformIdx[pl] = pid; platformNames.push(pl); }
      platformId[i] = pid;

      var rl = reasonLabel(cols.rend[src]);
      var rid = reasonIdx[rl];
      if (rid === undefined) { rid = reasonNames.length; reasonIdx[rl] = rid; reasonNames.push(rl); }
      reasonId[i] = rid;

      flags[i] = (cols.skip[src] ? 1 : 0) | (cols.shuf[src] ? 2 : 0) | (cols.offl[src] ? 4 : 0);
    }

    var mergedSlots = nSlots - nTracks;

    return {
      rowCount: kept,
      ts: ts, sec: sec, trackId: trackId,
      dayNum: dayNum, year: year, month: month, hour: hour, dow: dow,
      platformId: platformId, reasonId: reasonId, flags: flags,
      trackName: trackName, trackArtistId: trackArtistId, trackAlbumId: trackAlbumId,
      artistNames: artistNames, albumNames: albumNames,
      platformNames: platformNames, reasonNames: reasonNames,
      stats: { rawUris: nSlots, tracks: nTracks, merged: mergedSlots }
    };
  }

  global.SpotifyProcessing = {
    processFiles: processFiles,
    cleanTrackName: cleanTrackName,
    artistTokens: artistTokens,
    normText: normText,
    platformLabel: platformLabel
  };
})(typeof self !== 'undefined' ? self : this);
