/* =============================================================================
 * processing.js — parsing, cleaning and track-matching for Spotify
 * Extended Streaming History exports.
 *
 * Produces TWO groupings of the same rows, so the report can switch between
 * them instantly without re-reading the files:
 *
 *   strict  — a remix, instrumental or extended mix is its own track.
 *             This is the default: they really are different recordings.
 *   folded  — every version collapses into the original song.
 *
 * Both groupings still merge the things that are only ever bookkeeping
 * differences: the same song filed under a single and an album, a remaster,
 * a reordered credit, or (via ISRC) two labels releasing one master.
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

  // Markers that do not change the recording — only how it was packaged.
  // Stripped for both groupings.
  var NEUTRAL_MARKERS =
    '(?:remaster(?:ed)?|radio\\s*edit|edit|mix\\s*cut|explicit|clean|mono|stereo|' +
    'single\\s*version|album\\s*version|original\\s*mix|original\\s*version|' +
    'bonus\\s*track|deluxe)';

  // Markers for a genuinely different performance or arrangement.
  // Stripped only when the listener asks for versions to be folded together.
  var VARIANT_MARKERS =
    '(?:remix(?:ed)?|instrumental|extended(?:\\s*mix)?|unplugged|acoustic|live|' +
    'sped\\s*up|slowed|reverb|karaoke|cover|acapella|a\\s*cappella|reprise|' +
    'demo|session|club\\s*mix|dub\\s*mix|vip\\s*mix|vip|rework|bootleg|' +
    'mixed|mix|version)';

  function markerRegexes(marker) {
    return {
      dash: new RegExp('\\s+-\\s+[^-]*' + marker + '[^-]*$', 'i'),
      bracket: new RegExp('\\s*[\\(\\[][^\\)\\]]*' + marker + '[^\\)\\]]*[\\)\\]]', 'ig')
    };
  }

  var RE_NEUTRAL = markerRegexes(NEUTRAL_MARKERS);
  var RE_VARIANT = markerRegexes(VARIANT_MARKERS);
  var RE_TRAILING_FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;
  var RE_FEAT_CAPTURE = /(?:feat\.?|ft\.?|featuring)\s+([^()\[\]]+)/i;
  var RE_BRACKET_FEAT = /\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^\)\]]*[\)\]]/ig;

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
      .replace(/['’`´]/g, '') // apostrophes: dont === don't
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function tidy(name) {
    return name
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/[\s\-–—,]+$/, '')
      .trim();
  }

  function stripMarkers(name, re) {
    var prev;
    do {
      prev = name;
      name = name.replace(re.dash, '');
    } while (name !== prev && name.length);
    return name.replace(re.bracket, '');
  }

  /**
   * Two levels of cleaning.
   *   level 'variant' — drops packaging noise only. "Gravity - Instrumental
   *                     Mix" keeps its identity; "Radio Ga Ga - Remastered
   *                     2011" becomes "Radio Ga Ga".
   *   level 'base'    — also drops the version, so every "Gravity" is one song.
   */
  function cleanTrackName(raw, level) {
    var original = String(raw == null ? '' : raw).trim();
    var name = original;

    name = stripMarkers(name, RE_NEUTRAL);
    if (level === 'base') name = stripMarkers(name, RE_VARIANT);

    name = name.replace(RE_BRACKET_FEAT, '').replace(RE_TRAILING_FEAT, '');
    name = tidy(name);

    return name.length ? name : tidy(original) || original;
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

  /** Human-readable credit list, de-duplicated but in the order given. */
  function artistList(s) {
    if (!s) return [];
    var parts = String(s).split(RE_ARTIST_SPLIT);
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].replace(/[\(\[\)\]]/g, '').trim();
      if (!name) continue;
      var key = normText(name);
      if (!key || seen[key]) continue;
      seen[key] = 1;
      out.push(name);
    }
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
    [/sonos|alexa|google_home|speaker/, 'Speaker'],
    [/cast|chromecast/, 'Chromecast'],
    [/xbox|playstation|ps4|ps5/, 'Console'],
    [/\btv\b|roku|android_tv|webos|tizen/, 'TV'],
    [/car|automotive|android_auto|carplay/, 'Car'],
    [/partner/, 'Partner device']
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

  /** Group slots that share a title AND at least one artist. */
  function mergeByTitleAndArtist(uf, nSlots, titles, tokens) {
    var buckets = Object.create(null);
    for (var i = 0; i < nSlots; i++) {
      var title = titles[i];
      if (!title) continue;
      var bucket = buckets[title];
      if (!bucket) bucket = buckets[title] = Object.create(null);
      var toks = tokens[i];
      for (var t = 0; t < toks.length; t++) {
        var rep = bucket[toks[t]];
        if (rep === undefined) bucket[toks[t]] = i;
        else uf.union(rep, i);
      }
    }
  }

  /* ---------------------------------------------------------------------
   * Deezer lookup — resolves an ISRC and the full credit list per track.
   * Runs through a proxy because Deezer's API sends no CORS headers.
   * ------------------------------------------------------------------ */

  // Below this many plays a duplicate is not worth a network round trip.
  var DEEZER_MIN_PLAYS = 5;
  var CONCURRENCY = 6;

  function normaliseProxy(url) {
    var u = String(url || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    // A bare host would be read as a path relative to the page, and every
    // request would quietly 404.
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }

  function fetchIsrcBatch(pairs, proxyUrl, onTick) {
    var results = new Array(pairs.length);
    var base = normaliseProxy(proxyUrl);
    var next = 0, done = 0, failed = 0;

    return new Promise(function (resolve) {
      if (!pairs.length || !base) { resolve({ results: results, failed: 0 }); return; }

      function runOne() {
        var i = next++;
        if (i >= pairs.length) return Promise.resolve();

        var p = pairs[i];
        var url = base + '/isrc?artist=' + encodeURIComponent(p.artist) +
          '&track=' + encodeURIComponent(p.track);

        return fetch(url)
          .then(function (r) {
            if (!r.ok) throw new Error('proxy returned ' + r.status);
            return r.json();
          })
          .catch(function () {
            // A blocked or unreachable proxy must not look like "no match
            // found" — that difference is the whole point of the pass.
            failed++;
            return null;
          })
          .then(function (data) {
            if (data && data.isrc) results[i] = data;
            done++;
            if (onTick) onTick(done, pairs.length);
            return runOne();
          });
      }

      var lanes = [];
      for (var c = 0; c < Math.min(CONCURRENCY, pairs.length); c++) lanes.push(runOne());
      Promise.all(lanes).then(function () { resolve({ results: results, failed: failed }); });
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
    var variantName = new Array(nSlots);   // display title, packaging stripped
    var variantNorm = new Array(nSlots);   // matching key, versions kept apart
    var baseName = new Array(nSlots);      // display title, version stripped
    var baseNorm = new Array(nSlots);      // matching key, versions folded
    var slotArtist = new Array(nSlots);    // primary (album) artist
    var slotCredit = new Array(nSlots);    // full credit line, best known
    var slotTokens = new Array(nSlots);    // normalised artist set

    for (i = 0; i < nSlots; i++) {
      var rawName = modeOf(slots[i].names);
      var rawArtist = modeOf(slots[i].artists);
      variantName[i] = cleanTrackName(rawName, 'variant');
      variantNorm[i] = normText(variantName[i]);
      baseName[i] = cleanTrackName(rawName, 'base');
      baseNorm[i] = normText(baseName[i]);
      slotArtist[i] = rawArtist;

      var credit = rawArtist;
      var feat = extractFeat(rawName);
      if (feat) credit += ', ' + feat;
      slotCredit[i] = credit;
      slotTokens[i] = artistTokens(credit);
    }

    /* ---- 4. Strict grouping ---------------------------------------------
     * Same title (packaging stripped) plus at least one shared artist.
     * Requiring a shared artist is what keeps "Gravity" by Martin Garrix
     * apart from "Gravity" by Holding Absence.
     * ------------------------------------------------------------------ */
    var ufStrict = makeUnionFind(nSlots);
    mergeByTitleAndArtist(ufStrict, nSlots, variantNorm, slotTokens);

    /* ---- 5. Deezer pass: merge by ISRC ---------------------------------
     * Catches masters released by two labels under two primary artists —
     * the one case no amount of string matching can see.
     * ------------------------------------------------------------------ */
    var deezerCredits = Object.create(null);   // slot -> full credit from Deezer
    var deezerPromise = Promise.resolve();
    var lookup = { attempted: 0, failed: 0, matched: 0, merged: 0 };

    if (opts.deezerProxy) {
      var groupPlays = Object.create(null);
      var groupsPerTitle = Object.create(null);
      var groupLead = Object.create(null);   // root -> its most played slot
      for (i = 0; i < nSlots; i++) {
        var root = ufStrict.find(i);
        groupPlays[root] = (groupPlays[root] || 0) + slots[i].plays;
        if (groupLead[root] === undefined ||
            slots[i].plays > slots[groupLead[root]].plays) {
          groupLead[root] = i;
        }
        // Bucket on the base title so versions of one song land together and
        // can be compared — but each is still looked up under its own name.
        var ttl = baseNorm[i];
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
          var lead = groupLead[r];
          // Search under the version-bearing title. Asking Deezer for
          // "Gravity" when the entry is "Gravity - Instrumental Mix" would
          // return the original's code and silently fuse the two.
          candidates.push({ slot: r, track: variantName[lead], artist: slotArtist[lead] });
        }
      }

      if (candidates.length) {
        lookup.attempted = candidates.length;
        report({ phase: 'deezer', current: 0, total: candidates.length });
        deezerPromise = fetchIsrcBatch(candidates, opts.deezerProxy, function (d, tot) {
          report({ phase: 'deezer', current: d, total: tot });
        }).then(function (batch) {
          lookup.failed = batch.failed;

          // An ISRC identifies one specific recording, so two entries carrying
          // the same code are the same master. The proxy checks the title and
          // the artist before returning a code.
          var byIsrc = Object.create(null);
          for (var c = 0; c < candidates.length; c++) {
            var hit = batch.results[c];
            if (!hit || !hit.isrc) continue;
            lookup.matched++;
            var slotIdx = candidates[c].slot;
            if (hit.artists) deezerCredits[slotIdx] = hit.artists;
            var other = byIsrc[hit.isrc];
            if (other === undefined) { byIsrc[hit.isrc] = slotIdx; continue; }
            if (ufStrict.find(other) !== ufStrict.find(slotIdx)) lookup.merged++;
            ufStrict.union(other, slotIdx);
          }
        });
      }
    }

    return deezerPromise.then(function () {
      /* ---- 6. Folded grouping ------------------------------------------
       * Everything the strict pass merged, plus versions of the same song.
       * ---------------------------------------------------------------- */
      var ufFolded = makeUnionFind(nSlots);
      for (var s = 0; s < nSlots; s++) ufFolded.union(ufStrict.find(s), s);
      mergeByTitleAndArtist(ufFolded, nSlots, baseNorm, slotTokens);

      return finalise({
        cols: cols, order: order, kept: kept, slots: slots, rowSlot: rowSlot,
        variantName: variantName, baseName: baseName,
        slotArtist: slotArtist, slotCredit: slotCredit, slotTokens: slotTokens,
        deezerCredits: deezerCredits,
        ufStrict: ufStrict, ufFolded: ufFolded,
        lookup: lookup,
        report: report
      });
    });
  }

  /** Collapse union-find roots into dense ids plus display metadata. */
  function buildGrouping(ctx, uf, displayNames) {
    var nSlots = ctx.slots.length;
    var rootToId = Object.create(null);
    var slotTrack = new Int32Array(nSlots);
    var nameVotes = [], artistVotes = [], albumVotes = [], creditVotes = [];

    for (var i = 0; i < nSlots; i++) {
      var root = uf.find(i);
      var id = rootToId[root];
      if (id === undefined) {
        id = nameVotes.length;
        rootToId[root] = id;
        nameVotes.push(Object.create(null));
        artistVotes.push(Object.create(null));
        albumVotes.push(Object.create(null));
        creditVotes.push(Object.create(null));
      }
      slotTrack[i] = id;

      var p = ctx.slots[i].plays;
      nameVotes[id][displayNames[i]] = (nameVotes[id][displayNames[i]] || 0) + p;
      artistVotes[id][ctx.slotArtist[i]] = (artistVotes[id][ctx.slotArtist[i]] || 0) + p;
      // Deezer's credit list is the most complete one available, so it wins.
      var credit = ctx.deezerCredits[i] || ctx.slotCredit[i];
      var weight = ctx.deezerCredits[i] ? p + 1e6 : p;
      creditVotes[id][credit] = (creditVotes[id][credit] || 0) + weight;
      for (var alb in ctx.slots[i].albums) {
        albumVotes[id][alb] = (albumVotes[id][alb] || 0) + ctx.slots[i].albums[alb];
      }
    }

    return {
      slotTrack: slotTrack,
      count: nameVotes.length,
      nameVotes: nameVotes, artistVotes: artistVotes,
      albumVotes: albumVotes, creditVotes: creditVotes
    };
  }

  /** Turn vote tables into the flat arrays analytics.js consumes. */
  function materialise(grouping, artistNames, artistIndex, albumNames, albumIndex) {
    var count = grouping.count;
    var trackName = new Array(count);
    var trackCredit = new Array(count);
    var trackArtistId = new Int32Array(count);
    var trackAlbumId = new Int32Array(count);

    for (var i = 0; i < count; i++) {
      trackName[i] = modeOf(grouping.nameVotes[i]) || '(unknown)';

      var credit = modeOf(grouping.creditVotes[i]) || '';
      trackCredit[i] = artistList(credit).join(', ');

      var aName = modeOf(grouping.artistVotes[i]) || '(unknown)';
      var aKey = normText(aName);
      var aid = artistIndex[aKey];
      if (aid === undefined) {
        aid = artistNames.length; artistIndex[aKey] = aid; artistNames.push(aName);
      }
      trackArtistId[i] = aid;

      var albName = modeOf(grouping.albumVotes[i]);
      if (albName) {
        var albKey = normText(albName) + ' :: ' + aKey;
        var bid = albumIndex[albKey];
        if (bid === undefined) {
          bid = albumNames.length; albumIndex[albKey] = bid; albumNames.push(albName);
        }
        trackAlbumId[i] = bid;
      } else {
        trackAlbumId[i] = -1;
      }
    }

    return { trackName: trackName, trackCredit: trackCredit,
             trackArtistId: trackArtistId, trackAlbumId: trackAlbumId };
  }

  function finalise(ctx) {
    ctx.report({ phase: 'aggregate', total: ctx.kept });

    var cols = ctx.cols, order = ctx.order, kept = ctx.kept;

    var strict = buildGrouping(ctx, ctx.ufStrict, ctx.variantName);
    var folded = buildGrouping(ctx, ctx.ufFolded, ctx.baseName);

    // Both groupings share one artist and album vocabulary.
    var artistNames = [], artistIndex = Object.create(null);
    var albumNames = [], albumIndex = Object.create(null);
    var strictMeta = materialise(strict, artistNames, artistIndex, albumNames, albumIndex);
    var foldedMeta = materialise(folded, artistNames, artistIndex, albumNames, albumIndex);

    // strict track id -> folded track id, so the report can switch instantly.
    var foldMap = new Int32Array(strict.count);
    for (var s = 0; s < ctx.slots.length; s++) {
      foldMap[strict.slotTrack[s]] = folded.slotTrack[s];
    }

    /* ---- Row-level typed arrays ----------------------------------------- */
    var ts = new Float64Array(kept);
    var sec = new Float32Array(kept);
    var strictTrackId = new Int32Array(kept);
    var dayNum = new Int32Array(kept);
    var year = new Int16Array(kept);
    var month = new Int8Array(kept);
    var day = new Int8Array(kept);
    var hour = new Int8Array(kept);
    var dow = new Int8Array(kept);
    var platformId = new Int8Array(kept);
    var reasonId = new Int8Array(kept);
    var flags = new Uint8Array(kept);      // 1 skipped, 2 shuffle, 4 offline

    var platformNames = [], platformIdx = Object.create(null);
    var platformRaw = {};                  // label -> {raw platform: count}
    var reasonNames = [], reasonIdx = Object.create(null);
    var d = new Date();

    for (var i = 0; i < kept; i++) {
      var src = order[i];
      var t = cols.ts[src];
      ts[i] = t;
      sec[i] = cols.sec[src];
      strictTrackId[i] = strict.slotTrack[ctx.rowSlot[i]];

      d.setTime(t);
      year[i] = d.getFullYear();
      month[i] = d.getMonth();
      day[i] = d.getDate();
      hour[i] = d.getHours();
      dow[i] = d.getDay();
      // Local calendar day, expressed as a day count so it fits an Int32.
      dayNum[i] = Math.floor((t - d.getTimezoneOffset() * 60000) / 86400000);

      var pl = platformLabel(cols.plat[src]);
      var pid = platformIdx[pl];
      if (pid === undefined) {
        pid = platformNames.length; platformIdx[pl] = pid; platformNames.push(pl);
        platformRaw[pl] = Object.create(null);
      }
      platformId[i] = pid;
      // Keep the raw strings behind "Other" so the report can say what it is.
      var raw = cols.plat[src] || 'unknown';
      platformRaw[pl][raw] = (platformRaw[pl][raw] || 0) + 1;

      var rl = reasonLabel(cols.rend[src]);
      var rid = reasonIdx[rl];
      if (rid === undefined) { rid = reasonNames.length; reasonIdx[rl] = rid; reasonNames.push(rl); }
      reasonId[i] = rid;

      flags[i] = (cols.skip[src] ? 1 : 0) | (cols.shuf[src] ? 2 : 0) | (cols.offl[src] ? 4 : 0);
    }

    return {
      rowCount: kept,
      ts: ts, sec: sec,
      strictTrackId: strictTrackId, foldMap: foldMap,
      dayNum: dayNum, year: year, month: month, day: day, hour: hour, dow: dow,
      platformId: platformId, reasonId: reasonId, flags: flags,

      strict: strictMeta,
      folded: foldedMeta,

      artistNames: artistNames, albumNames: albumNames,
      platformNames: platformNames, platformRaw: platformRaw,
      reasonNames: reasonNames,

      stats: {
        rawUris: ctx.slots.length,
        strictTracks: strict.count,
        foldedTracks: folded.count,
        lookup: ctx.lookup
      }
    };
  }

  global.SpotifyProcessing = {
    processFiles: processFiles,
    cleanTrackName: cleanTrackName,
    artistTokens: artistTokens,
    artistList: artistList,
    normText: normText,
    platformLabel: platformLabel,
    normaliseProxy: normaliseProxy
  };
})(typeof self !== 'undefined' ? self : this);
