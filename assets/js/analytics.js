/* =============================================================================
 * analytics.js — every number shown on the dashboard.
 *
 * Works on the typed-array dataset produced by processing.js. Rows are sorted
 * by timestamp, so a date filter is just a pair of indices: no copying, no
 * re-scanning of data outside the range.
 *
 * Two populations are used throughout, matching the original dashboard:
 *   • "streams"  — plays of at least 30 seconds (what counts as listening)
 *   • "all rows" — every play, used wherever total time is reported
 * ========================================================================== */
(function (global) {
  'use strict';

  var MIN_STREAM_SEC = 30;
  var DAY_MS = 86400000;

  /* ---------------------------------------------------------------------
   * Grouping switch
   *
   * processing.js hands over two ways of counting the same rows: "strict",
   * where a remix is its own track, and "folded", where every version counts
   * as the original song. Switching rewrites one array of ints and swaps the
   * metadata tables — no reparsing, so the toggle is instant.
   * ------------------------------------------------------------------ */

  function applyGrouping(D, folded) {
    var meta = folded ? D.folded : D.strict;
    var ids = new Int32Array(D.rowCount);

    if (folded) {
      for (var i = 0; i < D.rowCount; i++) ids[i] = D.foldMap[D.strictTrackId[i]];
    } else {
      ids.set(D.strictTrackId);
    }

    D.grouping = folded ? 'folded' : 'strict';
    D.trackId = ids;
    D.trackName = meta.trackName;
    D.trackCredit = meta.trackCredit;
    D.trackArtistId = meta.trackArtistId;
    D.trackAlbumId = meta.trackAlbumId;
    D.trackCount = meta.trackName.length;
    return D;
  }

  /* ---------------------------------------------------------------------
   * Day-number helpers. dayNum is "days since 1970-01-01" in local time.
   * ------------------------------------------------------------------ */

  function dayNumToDate(dayNum) { return new Date(dayNum * DAY_MS); }

  function dateToDayNum(date) {
    return Math.floor((date.getTime() - date.getTimezoneOffset() * 60000) / DAY_MS);
  }

  /** "2025-03-14" -> dayNum (parsed as a local calendar date) */
  function isoToDayNum(iso) {
    var p = String(iso).split('-');
    return dateToDayNum(new Date(+p[0], +p[1] - 1, +p[2]));
  }

  function dayNumToIso(dayNum) {
    var d = dayNumToDate(dayNum);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  /* ---------------------------------------------------------------------
   * Range selection
   * ------------------------------------------------------------------ */

  function lowerBound(arr, n, value) {
    var lo = 0, hi = n;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < value) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Index range [lo, hi) covering startDay..endDay inclusive. */
  function range(D, startDay, endDay) {
    return {
      lo: lowerBound(D.dayNum, D.rowCount, startDay),
      hi: lowerBound(D.dayNum, D.rowCount, endDay + 1)
    };
  }

  function fullRange(D) { return { lo: 0, hi: D.rowCount }; }

  function bounds(D) {
    if (!D.rowCount) return { minDay: 0, maxDay: 0 };
    return { minDay: D.dayNum[0], maxDay: D.dayNum[D.rowCount - 1] };
  }

  /* ---------------------------------------------------------------------
   * Small utilities
   * ------------------------------------------------------------------ */

  function sortedEntriesDesc(map, limit) {
    var out = [];
    map.forEach(function (v, k) { out.push([k, v]); });
    out.sort(function (a, b) { return b[1] - a[1]; });
    return limit ? out.slice(0, limit) : out;
  }

  /** Every credited artist, as one line: "Martin Garrix, DubVision, Jaimes". */
  function creditOfTrack(D, trackId) {
    return D.trackCredit[trackId] || D.artistNames[D.trackArtistId[trackId]];
  }

  function artistNameOfTrack(D, trackId) { return D.artistNames[D.trackArtistId[trackId]]; }

  /** Split a sorted day list into runs of consecutive days. */
  function runsFromDays(days) {
    var runs = [];
    if (!days.length) return runs;
    var start = days[0], len = 1;
    for (var i = 1; i < days.length; i++) {
      if (days[i] === days[i - 1]) continue;
      if (days[i] === days[i - 1] + 1) { len++; continue; }
      runs.push({ start: start, end: days[i - 1], length: len });
      start = days[i]; len = 1;
    }
    runs.push({ start: start, end: days[days.length - 1], length: len });
    return runs;
  }

  /** Longest, current and previous run of consecutive listening days. */
  function streaksFromDays(days) {
    var runs = runsFromDays(days);
    if (!runs.length) {
      return { longest: 0, longestStart: null, longestEnd: null, current: 0, previous: null };
    }

    var best = runs[0];
    for (var i = 1; i < runs.length; i++) if (runs[i].length > best.length) best = runs[i];

    // The current streak only counts if it reaches today or yesterday.
    var today = dateToDayNum(new Date());
    var lastRun = runs[runs.length - 1];
    var isLive = lastRun.end >= today - 1;

    // "Previous" is the run before the live one, or the most recent finished
    // run when nothing is running right now.
    var prevRun = isLive
      ? (runs.length > 1 ? runs[runs.length - 2] : null)
      : lastRun;

    return {
      longest: best.length,
      longestStart: best.start,
      longestEnd: best.end,
      current: isLive ? lastRun.length : 0,
      previous: prevRun ? { length: prevRun.length, start: prevRun.start, end: prevRun.end } : null
    };
  }

  /** Unique listening days inside a range, ascending. Rows are time-ordered,
   *  so this needs no Set. */
  function uniqueDays(D, r, trackId, artistId) {
    var days = [], last = -1;
    for (var i = r.lo; i < r.hi; i++) {
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      if (trackId != null && D.trackId[i] !== trackId) continue;
      if (artistId != null && D.trackArtistId[D.trackId[i]] !== artistId) continue;
      var d = D.dayNum[i];
      if (d !== last) { days.push(d); last = d; }
    }
    return days;
  }

  /* ---------------------------------------------------------------------
   * Headline figures
   * ------------------------------------------------------------------ */

  function glance(D, r) {
    var hours = 0, streams = 0;
    var trackPlays = new Map();
    var artistSeen = new Set();

    for (var i = r.lo; i < r.hi; i++) {
      hours += D.sec[i];
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      streams++;
      var t = D.trackId[i];
      trackPlays.set(t, (trackPlays.get(t) || 0) + 1);
      artistSeen.add(D.trackArtistId[t]);
    }
    hours /= 3600;

    var topId = null, topPlays = 0;
    trackPlays.forEach(function (v, k) { if (v > topPlays) { topPlays = v; topId = k; } });

    return {
      hours: hours,
      streams: streams,
      uniqueTracks: trackPlays.size,
      uniqueArtists: artistSeen.size,
      topTrack: topId == null ? null : {
        id: topId, name: D.trackName[topId],
        artist: creditOfTrack(D, topId), plays: topPlays
      }
    };
  }

  /* ---------------------------------------------------------------------
   * Leaderboards
   * ------------------------------------------------------------------ */

  function topTracks(D, r, limit) {
    var plays = new Map(), secs = new Map();
    for (var i = r.lo; i < r.hi; i++) {
      var t = D.trackId[i];
      secs.set(t, (secs.get(t) || 0) + D.sec[i]);
      if (D.sec[i] >= MIN_STREAM_SEC) plays.set(t, (plays.get(t) || 0) + 1);
    }
    return sortedEntriesDesc(plays, limit).map(function (e, idx) {
      return {
        rank: idx + 1, id: e[0], name: D.trackName[e[0]],
        artist: creditOfTrack(D, e[0]),
        plays: e[1], hours: (secs.get(e[0]) || 0) / 3600
      };
    });
  }

  function topArtists(D, r, limit) {
    var plays = new Map(), secs = new Map(), tracksPer = new Map();
    for (var i = r.lo; i < r.hi; i++) {
      var a = D.trackArtistId[D.trackId[i]];
      secs.set(a, (secs.get(a) || 0) + D.sec[i]);
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      plays.set(a, (plays.get(a) || 0) + 1);
      var set = tracksPer.get(a);
      if (!set) { set = new Set(); tracksPer.set(a, set); }
      set.add(D.trackId[i]);
    }
    return sortedEntriesDesc(plays, limit).map(function (e, idx) {
      return {
        rank: idx + 1, id: e[0], name: D.artistNames[e[0]],
        plays: e[1], hours: (secs.get(e[0]) || 0) / 3600,
        tracks: tracksPer.get(e[0]) ? tracksPer.get(e[0]).size : 0
      };
    });
  }

  /** Every distinct track by one artist, most played first. */
  function artistTrackList(D, r, artistId) {
    var plays = new Map(), secs = new Map();
    for (var i = r.lo; i < r.hi; i++) {
      var t = D.trackId[i];
      if (D.trackArtistId[t] !== artistId) continue;
      secs.set(t, (secs.get(t) || 0) + D.sec[i]);
      if (D.sec[i] >= MIN_STREAM_SEC) plays.set(t, (plays.get(t) || 0) + 1);
    }
    return sortedEntriesDesc(plays).map(function (e, idx) {
      return {
        rank: idx + 1, id: e[0], name: D.trackName[e[0]],
        artist: creditOfTrack(D, e[0]),
        plays: e[1], hours: (secs.get(e[0]) || 0) / 3600
      };
    });
  }

  /* ---------------------------------------------------------------------
   * Listening habits — the fields the old dashboard never touched
   * ------------------------------------------------------------------ */

  /** Turn raw platform strings into a short, readable list of what they were. */
  function describeRawPlatforms(rawCounts) {
    if (!rawCounts) return '';
    var pretty = new Map();

    for (var raw in rawCounts) {
      // Spotify writes things like "Partner sonos_ZP120" or "windows (10.0.19042)".
      var label = String(raw).split(/[\s(,;]/)[0].replace(/[_-]+/g, ' ').trim();
      if (!label) label = raw;
      label = label.charAt(0).toUpperCase() + label.slice(1);
      pretty.set(label, (pretty.get(label) || 0) + rawCounts[raw]);
    }

    return sortedEntriesDesc(pretty, 3).map(function (e) { return e[0]; }).join(', ');
  }

  function habits(D, r) {
    var total = 0, skipped = 0, shuffled = 0, offline = 0;
    var platforms = new Map(), reasons = new Map();
    var skipPerTrack = new Map();

    for (var i = r.lo; i < r.hi; i++) {
      total++;
      var f = D.flags[i];
      // Spotify's own "skipped" flag, with a short play as the fallback for
      // exports that predate the field.
      var isSkip = (f & 1) ? true : (D.sec[i] < MIN_STREAM_SEC);
      if (isSkip) skipped++;
      if (f & 2) shuffled++;
      if (f & 4) offline++;

      var p = D.platformId[i];
      platforms.set(p, (platforms.get(p) || 0) + 1);
      var rn = D.reasonId[i];
      reasons.set(rn, (reasons.get(rn) || 0) + 1);

      var t = D.trackId[i];
      var e = skipPerTrack.get(t);
      if (!e) { e = { total: 0, skipped: 0 }; skipPerTrack.set(t, e); }
      e.total++;
      if (isSkip) e.skipped++;
    }

    var worst = null;
    skipPerTrack.forEach(function (e, t) {
      if (e.total < 8) return;
      var rate = e.skipped / e.total;
      if (!worst || rate > worst.rate) {
        worst = { rate: rate, id: t, name: D.trackName[t], artist: creditOfTrack(D, t), plays: e.total };
      }
    });

    return {
      total: total,
      skipRate: total ? skipped / total : 0,
      shuffleRate: total ? shuffled / total : 0,
      offlineRate: total ? offline / total : 0,
      platforms: sortedEntriesDesc(platforms).map(function (e) {
        var label = D.platformNames[e[0]];
        return {
          name: label, count: e[1], share: e[1] / total,
          // "Other" and "Unknown" mean nothing on their own, so carry the raw
          // strings behind them for the caller to spell out.
          detail: describeRawPlatforms(D.platformRaw && D.platformRaw[label])
        };
      }),
      reasons: sortedEntriesDesc(reasons, 5).map(function (e) {
        return { name: D.reasonNames[e[0]], count: e[1], share: e[1] / total };
      }),
      mostSkipped: worst
    };
  }

  /* ---------------------------------------------------------------------
   * Time-shaped views
   * ------------------------------------------------------------------ */

  function yearsIn(D, r) {
    var set = new Set();
    for (var i = r.lo; i < r.hi; i++) set.add(D.year[i]);
    return Array.from(set).sort(function (a, b) { return b - a; });
  }

  /** { dayNum: plays } for one calendar year. */
  function calendar(D, r, year) {
    var counts = new Map();
    for (var i = r.lo; i < r.hi; i++) {
      if (D.year[i] !== year) continue;
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      var d = D.dayNum[i];
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    return counts;
  }

  /** Hours per calendar month, ascending, gaps filled with zero. */
  function monthlyHours(D, r, year) {
    var byMonth = new Map();
    for (var i = r.lo; i < r.hi; i++) {
      if (year != null && D.year[i] !== year) continue;
      var key = D.year[i] * 12 + D.month[i];
      byMonth.set(key, (byMonth.get(key) || 0) + D.sec[i]);
    }
    return fillMonths(byMonth, function (v) { return v / 3600; });
  }

  function fillMonths(byMonth, transform) {
    var keys = Array.from(byMonth.keys()).sort(function (a, b) { return a - b; });
    if (!keys.length) return [];
    var out = [];
    for (var k = keys[0]; k <= keys[keys.length - 1]; k++) {
      var raw = byMonth.get(k) || 0;
      out.push({
        key: k,
        label: monthLabel(k),
        value: transform ? transform(raw) : raw
      });
    }
    return out;
  }

  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function monthLabel(key) {
    return MONTH_SHORT[key % 12] + " '" + String(Math.floor(key / 12)).slice(2);
  }

  function byHour(D, r) {
    var counts = new Array(24).fill(0);
    for (var i = r.lo; i < r.hi; i++) {
      if (D.sec[i] >= MIN_STREAM_SEC) counts[D.hour[i]]++;
    }
    return counts;
  }

  function byDayOfWeek(D, r) {
    // Monday-first, matching the original dashboard.
    var counts = new Array(7).fill(0);
    for (var i = r.lo; i < r.hi; i++) {
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      counts[(D.dow[i] + 6) % 7]++;
    }
    return counts;
  }

  /* ---------------------------------------------------------------------
   * Sessions — runs of listening separated by a gap of silence
   * ------------------------------------------------------------------ */

  /* A session is an unbroken listening stretch. Anything longer than this
     much silence starts a new one — a short pause between tracks, a phone
     call, a walk to the car, all stay inside the same session. */
  var SILENCE_BREAK_MS = 30 * 60000;

  /** All listening stretches in a range, in order. */
  function listeningRuns(D, r) {
    var runs = [];
    var cur = null;

    for (var i = r.lo; i < r.hi; i++) {
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      var start = D.ts[i];
      var end = D.ts[i] + D.sec[i] * 1000;

      if (cur && (start - cur.end) <= SILENCE_BREAK_MS) {
        cur.end = Math.max(cur.end, end);
        cur.plays++;
        cur.playedSec += D.sec[i];
      } else {
        if (cur) runs.push(cur);
        cur = { start: start, end: end, plays: 1, playedSec: D.sec[i],
                year: D.year[i], month: D.month[i] };
      }
    }
    if (cur) runs.push(cur);

    runs.forEach(function (run) { run.hours = (run.end - run.start) / 3600000; });
    return runs;
  }

  /** Sessions that ran for at least minHours without a break. */
  function sessionsPerMonth(D, r, minHours, year) {
    var byMonth = new Map();
    listeningRuns(D, r).forEach(function (run) {
      if (run.hours < minHours) return;
      if (year != null && run.year !== year) return;
      var key = run.year * 12 + run.month;
      byMonth.set(key, (byMonth.get(key) || 0) + 1);
    });
    return fillMonths(byMonth);
  }

  function sessionSummary(D, r, minHours) {
    var runs = listeningRuns(D, r);
    var qualifying = runs.filter(function (run) { return run.hours >= minHours; });

    var longest = null, totalHours = 0;
    qualifying.forEach(function (run) {
      totalHours += run.hours;
      if (!longest || run.hours > longest.hours) longest = run;
    });

    return {
      allRuns: runs.length,
      sessions: qualifying.length,
      avgHours: qualifying.length ? totalHours / qualifying.length : 0,
      longestHours: longest ? longest.hours : 0,
      longestStart: longest ? new Date(longest.start) : null,
      breakMinutes: SILENCE_BREAK_MS / 60000
    };
  }

  /* ---------------------------------------------------------------------
   * Obsession score
   *   density (40%) — unique days listened, against how long you have known it
   *   volume  (35%) — log of total plays, so old giants cannot bury new loves
   *   recency (25%) — exponential decay once you stop playing it
   * ------------------------------------------------------------------ */

  function obsession(D, r, refMs, limit) {
    var stats = new Map();

    for (var i = r.lo; i < r.hi; i++) {
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      var t = D.trackId[i];
      var e = stats.get(t);
      if (!e) {
        e = { plays: 0, days: 0, lastDay: -1, first: D.ts[i], last: D.ts[i] };
        stats.set(t, e);
      }
      e.plays++;
      if (D.dayNum[i] !== e.lastDay) { e.days++; e.lastDay = D.dayNum[i]; }
      e.last = D.ts[i];
    }
    if (!stats.size) return [];

    var rows = [];
    stats.forEach(function (e, t) {
      var sinceFirst = Math.max(0, (refMs - e.first) / DAY_MS);
      var sinceLast = Math.max(0, (refMs - e.last) / DAY_MS);
      var density = e.days / (sinceFirst + 5);
      var volume = Math.log10(e.plays + 1);
      var recency = Math.exp(-0.015 * sinceLast);
      rows.push({
        id: t, name: D.trackName[t], artist: creditOfTrack(D, t),
        plays: e.plays, days: e.days,
        daysSinceFirst: Math.round(sinceFirst),
        daysSinceLast: Math.round(sinceLast),
        // Kept so the explanation can show the arithmetic rather than assert it.
        density: density, volume: volume, recency: recency,
        raw: 0.4 * density + 0.35 * volume + 0.25 * recency
      });
    });

    var min = Infinity, max = -Infinity;
    rows.forEach(function (x) { if (x.raw < min) min = x.raw; if (x.raw > max) max = x.raw; });
    var span = max - min;
    rows.forEach(function (x) {
      x.rawMin = min;
      x.rawMax = max;
      x.score = span > 0 ? Math.round((1 + 99 * (x.raw - min) / span) * 100) / 100 : 50;
    });

    rows.sort(function (a, b) { return b.score - a.score; });
    return limit ? rows.slice(0, limit) : rows;
  }

  /* ---------------------------------------------------------------------
   * Recommended playlist — current obsessions plus all-time favourites
   * ------------------------------------------------------------------ */

  function playlist(D, r, size, refMs) {
    size = size || 50;
    var obs = obsession(D, r, refMs || Date.now());
    var top = topTracks(D, r, 100);
    var out = [], seen = new Set();

    function take(list, from, to, count, source, shuffle) {
      var pool = list.slice(from, to);
      if (shuffle) {
        for (var i = pool.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
        }
      }
      for (var k = 0; k < pool.length && count > 0; k++) {
        var item = pool[k];
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push({ id: item.id, name: item.name, artist: item.artist, source: source });
        count--;
      }
    }

    take(obs, 0, 15, 15, 'On repeat now', false);
    take(obs, 15, 50, 15, 'On repeat now', true);
    take(top, 0, 5, 5, 'All-time favourite', false);
    take(top, 5, 50, 15, 'All-time favourite', true);

    // Top up from whatever is left, so the list reaches its target length
    // even when the earlier slices overlapped heavily.
    if (out.length < size) take(top, 0, top.length, size - out.length, 'All-time favourite', false);
    if (out.length < size) take(obs, 0, obs.length, size - out.length, 'On repeat now', false);

    return out.slice(0, size);
  }

  /* ---------------------------------------------------------------------
   * Per-track and per-artist detail
   * ------------------------------------------------------------------ */

  function trackDetail(D, r, trackId, allTracksRanked) {
    var plays = 0, secs = 0, byMonth = new Map(), perDay = new Map();
    var firstTs = null, lastTs = null;

    for (var i = r.lo; i < r.hi; i++) {
      if (D.trackId[i] !== trackId) continue;
      secs += D.sec[i];
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      plays++;
      if (firstTs === null) firstTs = D.ts[i];
      lastTs = D.ts[i];
      var key = D.year[i] * 12 + D.month[i];
      byMonth.set(key, (byMonth.get(key) || 0) + 1);
      perDay.set(D.dayNum[i], (perDay.get(D.dayNum[i]) || 0) + 1);
    }

    var busiestDay = null, busiestPlays = 0;
    perDay.forEach(function (v, d) { if (v > busiestPlays) { busiestPlays = v; busiestDay = d; } });

    var rank = null;
    for (var k = 0; k < allTracksRanked.length; k++) {
      if (allTracksRanked[k].id === trackId) { rank = k + 1; break; }
    }

    return {
      id: trackId,
      name: D.trackName[trackId],
      artist: creditOfTrack(D, trackId),
      album: D.trackAlbumId[trackId] >= 0 ? D.albumNames[D.trackAlbumId[trackId]] : null,
      plays: plays,
      hours: secs / 3600,
      rank: rank,
      daysPlayed: perDay.size,
      firstListen: firstTs === null ? null : new Date(firstTs),
      lastListen: lastTs === null ? null : new Date(lastTs),
      busiestDay: busiestDay, busiestPlays: busiestPlays,
      monthly: fillMonths(byMonth),
      streak: streaksFromDays(uniqueDays(D, r, trackId, null))
    };
  }

  function artistDetail(D, r, artistId, allArtistsRanked) {
    var plays = 0, secs = 0, byMonth = new Map();
    var trackPlays = new Map(), daysSeen = new Set();
    var firstTs = null, lastTs = null;

    for (var i = r.lo; i < r.hi; i++) {
      var t = D.trackId[i];
      if (D.trackArtistId[t] !== artistId) continue;
      secs += D.sec[i];
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      plays++;
      if (firstTs === null) firstTs = D.ts[i];
      lastTs = D.ts[i];
      daysSeen.add(D.dayNum[i]);
      var key = D.year[i] * 12 + D.month[i];
      byMonth.set(key, (byMonth.get(key) || 0) + 1);
      trackPlays.set(t, (trackPlays.get(t) || 0) + 1);
    }

    var rank = null;
    for (var k = 0; k < allArtistsRanked.length; k++) {
      if (allArtistsRanked[k].id === artistId) { rank = k + 1; break; }
    }

    return {
      id: artistId,
      name: D.artistNames[artistId],
      plays: plays,
      hours: secs / 3600,
      rank: rank,
      uniqueTracks: trackPlays.size,
      daysPlayed: daysSeen.size,
      firstListen: firstTs === null ? null : new Date(firstTs),
      lastListen: lastTs === null ? null : new Date(lastTs),
      monthly: fillMonths(byMonth),
      streak: streaksFromDays(uniqueDays(D, r, null, artistId)),
      topTracks: sortedEntriesDesc(trackPlays, 5).map(function (e) {
        return { id: e[0], name: D.trackName[e[0]], plays: e[1] };
      })
    };
  }

  /* ---------------------------------------------------------------------
   * Fun facts
   * ------------------------------------------------------------------ */

  function funFacts(D, r) {
    var hoursPerDay = new Map(), hoursPerMonth = new Map();
    var artistSecs = new Map(), artistTracks = new Map();
    var artistPlays = new Map();
    var streams = 0, lateNight = 0;

    // A track counts as a discovery when its first ever play falls inside the
    // selected range — so narrowing the dates answers "what was new to me then".
    var firstSeen = new Int32Array(D.trackCount).fill(-1);
    for (var j = 0; j < D.rowCount; j++) {
      if (D.sec[j] < MIN_STREAM_SEC) continue;
      var tid = D.trackId[j];
      if (firstSeen[tid] === -1) firstSeen[tid] = j;
    }

    var discoveries = 0;
    var counted = new Set();

    for (var i = r.lo; i < r.hi; i++) {
      hoursPerDay.set(D.dayNum[i], (hoursPerDay.get(D.dayNum[i]) || 0) + D.sec[i]);
      var mk = D.year[i] * 12 + D.month[i];
      hoursPerMonth.set(mk, (hoursPerMonth.get(mk) || 0) + D.sec[i]);

      var t = D.trackId[i];
      var a = D.trackArtistId[t];
      artistSecs.set(a, (artistSecs.get(a) || 0) + D.sec[i]);

      if (D.sec[i] < MIN_STREAM_SEC) continue;
      streams++;
      if (D.hour[i] < 5) lateNight++;
      artistPlays.set(a, (artistPlays.get(a) || 0) + 1);

      if (!counted.has(t)) {
        counted.add(t);
        if (firstSeen[t] >= r.lo && firstSeen[t] < r.hi) discoveries++;
      }

      var set = artistTracks.get(a);
      if (!set) { set = new Set(); artistTracks.set(a, set); }
      set.add(t);
    }

    function argMax(map) {
      var bk = null, bv = -Infinity;
      map.forEach(function (v, k) { if (v > bv) { bv = v; bk = k; } });
      return bk === null ? null : { key: bk, value: bv };
    }

    var busiestDay = argMax(hoursPerDay);
    var bestMonth = argMax(hoursPerMonth);
    var topArtist = argMax(artistSecs);

    var diverse = null;
    artistTracks.forEach(function (set, a) {
      if (!diverse || set.size > diverse.count) {
        diverse = { id: a, name: D.artistNames[a], count: set.size };
      }
    });

    // How much of your listening sits with a handful of artists.
    var topTen = sortedEntriesDesc(artistPlays, 10);
    var topTenPlays = topTen.reduce(function (s, e) { return s + e[1]; }, 0);

    var longestRun = null;
    listeningRuns(D, r).forEach(function (run) {
      if (!longestRun || run.hours > longestRun.hours) longestRun = run;
    });

    return {
      streak: streaksFromDays(uniqueDays(D, r, null, null)),
      busiestDay: busiestDay && { day: busiestDay.key, hours: busiestDay.value / 3600 },
      bestMonth: bestMonth && { label: monthLabel(bestMonth.key), hours: bestMonth.value / 3600 },
      topArtist: topArtist && { name: D.artistNames[topArtist.key], hours: topArtist.value / 3600 },
      mostDiverse: diverse,
      discoveries: discoveries,
      concentration: streams ? topTenPlays / streams : 0,
      topTenCount: topTen.length,
      lateNightShare: streams ? lateNight / streams : 0,
      longestSitting: longestRun && { hours: longestRun.hours, plays: longestRun.plays, start: new Date(longestRun.start) }
    };
  }

  /** "One year ago today", measured from the last day in the data. */
  function timeTravel(D) {
    var b = bounds(D);
    var target = b.maxDay - 365;
    if (target < b.minDay) return null;

    var r = range(D, target, target);
    if (r.hi <= r.lo) return { day: target, plays: 0, hours: 0, topTrack: null, obsession: null };

    var plays = 0, secs = 0, trackPlays = new Map();
    for (var i = r.lo; i < r.hi; i++) {
      secs += D.sec[i];
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      plays++;
      trackPlays.set(D.trackId[i], (trackPlays.get(D.trackId[i]) || 0) + 1);
    }

    var best = sortedEntriesDesc(trackPlays, 1)[0];
    // Obsession as it stood back then: everything up to that day, nothing after.
    var history = { lo: 0, hi: r.hi };
    var obs = obsession(D, history, (target + 1) * DAY_MS, 1)[0] || null;

    return {
      day: target,
      plays: plays,
      hours: secs / 3600,
      topTrack: best ? { name: D.trackName[best[0]], artist: creditOfTrack(D, best[0]), plays: best[1] } : null,
      obsession: obs
    };
  }

  /* ---------------------------------------------------------------------
   * Search indexes for the track / artist pickers
   * ------------------------------------------------------------------ */

  function buildSearchIndex(D, r) {
    var trackPlays = new Map(), artistPlays = new Map();
    for (var i = r.lo; i < r.hi; i++) {
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      var t = D.trackId[i];
      trackPlays.set(t, (trackPlays.get(t) || 0) + 1);
      var a = D.trackArtistId[t];
      artistPlays.set(a, (artistPlays.get(a) || 0) + 1);
    }
    var tracks = sortedEntriesDesc(trackPlays).map(function (e) {
      return {
        id: e[0], plays: e[1], name: D.trackName[e[0]], artist: creditOfTrack(D, e[0]),
        search: (D.trackName[e[0]] + ' ' + creditOfTrack(D, e[0])).toLowerCase()
      };
    });
    var artists = sortedEntriesDesc(artistPlays).map(function (e) {
      return { id: e[0], plays: e[1], name: D.artistNames[e[0]], search: D.artistNames[e[0]].toLowerCase() };
    });
    return { tracks: tracks, artists: artists };
  }

  global.SpotifyAnalytics = {
    MIN_STREAM_SEC: MIN_STREAM_SEC,
    applyGrouping: applyGrouping,
    range: range, fullRange: fullRange, bounds: bounds,
    dayNumToDate: dayNumToDate, dateToDayNum: dateToDayNum,
    isoToDayNum: isoToDayNum, dayNumToIso: dayNumToIso,
    monthLabel: monthLabel,
    glance: glance,
    topTracks: topTracks, topArtists: topArtists,
    artistTrackList: artistTrackList,
    habits: habits,
    yearsIn: yearsIn, calendar: calendar, monthlyHours: monthlyHours,
    byHour: byHour, byDayOfWeek: byDayOfWeek,
    listeningRuns: listeningRuns,
    sessionsPerMonth: sessionsPerMonth, sessionSummary: sessionSummary,
    obsession: obsession, playlist: playlist,
    trackDetail: trackDetail, artistDetail: artistDetail,
    funFacts: funFacts, timeTravel: timeTravel,
    buildSearchIndex: buildSearchIndex,
    streaksFromDays: streaksFromDays,
    creditOfTrack: creditOfTrack
  };
})(typeof self !== 'undefined' ? self : this);
