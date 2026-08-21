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

  function artistNameOfTrack(D, trackId) { return D.artistNames[D.trackArtistId[trackId]]; }

  /** Longest and current run of consecutive listening days. */
  function streaksFromDays(days) {
    if (!days.length) {
      return { longest: 0, longestStart: null, longestEnd: null, current: 0 };
    }
    var longest = 1, longestStart = days[0], longestEnd = days[0];
    var runLen = 1, runStart = days[0];

    for (var i = 1; i < days.length; i++) {
      if (days[i] === days[i - 1] + 1) {
        runLen++;
      } else if (days[i] !== days[i - 1]) {
        if (runLen > longest) { longest = runLen; longestStart = runStart; longestEnd = days[i - 1]; }
        runLen = 1; runStart = days[i];
      }
    }
    if (runLen > longest) { longest = runLen; longestStart = runStart; longestEnd = days[days.length - 1]; }

    // The current streak only counts if it reaches today or yesterday.
    var today = dateToDayNum(new Date());
    var last = days[days.length - 1];
    var current = 0;
    if (last >= today - 1) {
      current = 1;
      for (var j = days.length - 1; j > 0; j--) {
        if (days[j] === days[j - 1] + 1) current++;
        else if (days[j] !== days[j - 1]) break;
      }
    }
    return { longest: longest, longestStart: longestStart, longestEnd: longestEnd, current: current };
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
        artist: artistNameOfTrack(D, topId), plays: topPlays
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
        artist: artistNameOfTrack(D, e[0]),
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

  function topAlbums(D, r, limit) {
    var plays = new Map(), secs = new Map(), artistOf = new Map();
    for (var i = r.lo; i < r.hi; i++) {
      var t = D.trackId[i];
      var b = D.trackAlbumId[t];
      if (b < 0) continue;
      secs.set(b, (secs.get(b) || 0) + D.sec[i]);
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      plays.set(b, (plays.get(b) || 0) + 1);
      if (!artistOf.has(b)) artistOf.set(b, artistNameOfTrack(D, t));
    }
    return sortedEntriesDesc(plays, limit).map(function (e, idx) {
      return {
        rank: idx + 1, id: e[0], name: D.albumNames[e[0]],
        artist: artistOf.get(e[0]) || '',
        plays: e[1], hours: (secs.get(e[0]) || 0) / 3600
      };
    });
  }

  /* ---------------------------------------------------------------------
   * Listening habits — the fields the old dashboard never touched
   * ------------------------------------------------------------------ */

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
        worst = { rate: rate, id: t, name: D.trackName[t], artist: artistNameOfTrack(D, t), plays: e.total };
      }
    });

    return {
      total: total,
      skipRate: total ? skipped / total : 0,
      shuffleRate: total ? shuffled / total : 0,
      offlineRate: total ? offline / total : 0,
      platforms: sortedEntriesDesc(platforms).map(function (e) {
        return { name: D.platformNames[e[0]], count: e[1], share: e[1] / total };
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

  function sessionsPerMonth(D, r, gapHours, year) {
    var gapMs = gapHours * 3600000;
    var byMonth = new Map();
    var prevTs = -Infinity;

    for (var i = r.lo; i < r.hi; i++) {
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      var isNew = (D.ts[i] - prevTs) >= gapMs;
      prevTs = D.ts[i];
      if (!isNew) continue;
      if (year != null && D.year[i] !== year) continue;
      var key = D.year[i] * 12 + D.month[i];
      byMonth.set(key, (byMonth.get(key) || 0) + 1);
    }
    return fillMonths(byMonth);
  }

  function sessionSummary(D, r, gapHours) {
    var gapMs = gapHours * 3600000;
    var sessions = 0, curSec = 0, longest = 0, longestStart = 0, totalSec = 0;
    var prevTs = -Infinity, curStart = 0;

    for (var i = r.lo; i < r.hi; i++) {
      if (D.sec[i] < MIN_STREAM_SEC) continue;
      if ((D.ts[i] - prevTs) >= gapMs) {
        if (curSec > longest) { longest = curSec; longestStart = curStart; }
        sessions++;
        curSec = 0;
        curStart = D.ts[i];
      }
      prevTs = D.ts[i];
      curSec += D.sec[i];
      totalSec += D.sec[i];
    }
    if (curSec > longest) { longest = curSec; longestStart = curStart; }

    return {
      sessions: sessions,
      avgMinutes: sessions ? (totalSec / sessions) / 60 : 0,
      longestMinutes: longest / 60,
      longestStart: longest ? new Date(longestStart) : null
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
        id: t, name: D.trackName[t], artist: artistNameOfTrack(D, t),
        plays: e.plays, days: e.days,
        daysSinceLast: Math.floor(sinceLast),
        raw: 0.4 * density + 0.35 * volume + 0.25 * recency
      });
    });

    var min = Infinity, max = -Infinity;
    rows.forEach(function (x) { if (x.raw < min) min = x.raw; if (x.raw > max) max = x.raw; });
    var span = max - min;
    rows.forEach(function (x) {
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
      artist: artistNameOfTrack(D, trackId),
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
    var firstRow = null;

    for (var i = r.lo; i < r.hi; i++) {
      hoursPerDay.set(D.dayNum[i], (hoursPerDay.get(D.dayNum[i]) || 0) + D.sec[i]);
      var mk = D.year[i] * 12 + D.month[i];
      hoursPerMonth.set(mk, (hoursPerMonth.get(mk) || 0) + D.sec[i]);

      var t = D.trackId[i];
      var a = D.trackArtistId[t];
      artistSecs.set(a, (artistSecs.get(a) || 0) + D.sec[i]);

      if (D.sec[i] < MIN_STREAM_SEC) continue;
      if (firstRow === null) firstRow = i;
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

    return {
      streak: streaksFromDays(uniqueDays(D, r, null, null)),
      busiestDay: busiestDay && { day: busiestDay.key, hours: busiestDay.value / 3600 },
      bestMonth: bestMonth && { label: monthLabel(bestMonth.key), hours: bestMonth.value / 3600 },
      topArtist: topArtist && { name: D.artistNames[topArtist.key], hours: topArtist.value / 3600 },
      firstTrack: firstRow === null ? null : {
        name: D.trackName[D.trackId[firstRow]],
        artist: artistNameOfTrack(D, D.trackId[firstRow]),
        date: new Date(D.ts[firstRow])
      },
      mostDiverse: diverse
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
      topTrack: best ? { name: D.trackName[best[0]], artist: artistNameOfTrack(D, best[0]), plays: best[1] } : null,
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
        id: e[0], plays: e[1], name: D.trackName[e[0]], artist: artistNameOfTrack(D, e[0]),
        search: (D.trackName[e[0]] + ' ' + artistNameOfTrack(D, e[0])).toLowerCase()
      };
    });
    var artists = sortedEntriesDesc(artistPlays).map(function (e) {
      return { id: e[0], plays: e[1], name: D.artistNames[e[0]], search: D.artistNames[e[0]].toLowerCase() };
    });
    return { tracks: tracks, artists: artists };
  }

  global.SpotifyAnalytics = {
    MIN_STREAM_SEC: MIN_STREAM_SEC,
    range: range, fullRange: fullRange, bounds: bounds,
    dayNumToDate: dayNumToDate, dateToDayNum: dateToDayNum,
    isoToDayNum: isoToDayNum, dayNumToIso: dayNumToIso,
    monthLabel: monthLabel,
    glance: glance,
    topTracks: topTracks, topArtists: topArtists, topAlbums: topAlbums,
    habits: habits,
    yearsIn: yearsIn, calendar: calendar, monthlyHours: monthlyHours,
    byHour: byHour, byDayOfWeek: byDayOfWeek,
    sessionsPerMonth: sessionsPerMonth, sessionSummary: sessionSummary,
    obsession: obsession, playlist: playlist,
    trackDetail: trackDetail, artistDetail: artistDetail,
    funFacts: funFacts, timeTravel: timeTravel,
    buildSearchIndex: buildSearchIndex,
    streaksFromDays: streaksFromDays
  };
})(typeof self !== 'undefined' ? self : this);
