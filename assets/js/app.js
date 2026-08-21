/* =============================================================================
 * app.js — screen flow, filters and rendering.
 * ========================================================================== */
(function () {
  'use strict';

  var A = window.SpotifyAnalytics;
  var C = window.SpotifyCharts;
  var esc = C.esc;

  /* ---------------------------------------------------------------------
   * Deezer proxy.
   *
   * Leave empty and the report skips the online lookup entirely — the
   * built-in title + artist matcher still merges versions on its own.
   * Set it to your Cloudflare Worker URL to enable "Deep matching".
   * See cloudflare-worker/README.md.
   * ------------------------------------------------------------------ */
  var DEEZER_PROXY = '';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    data: null,
    files: [],
    range: null,
    startDay: 0,
    endDay: 0,
    minDay: 0,
    maxDay: 0,
    search: null,
    selectedTrack: null,
    selectedArtist: null,
    playlist: null
  };

  /* =====================================================================
   * Stage 1 — picking files
   * ================================================================== */

  var dropzone = $('dropzone');
  var fileInput = $('file-input');
  var analyzeBtn = $('analyze-btn');

  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener('dragover', function (e) {
    e.preventDefault(); dropzone.classList.add('is-over');
  });
  dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('is-over'); });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('is-over');
    if (e.dataTransfer.files.length) acceptFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files.length) acceptFiles(fileInput.files);
  });

  function acceptFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return /\.json$/i.test(f.name);
    });
    if (!files.length) {
      showUploadError('Those files are not JSON. Look for "Streaming_History_Audio_*.json" inside the zip Spotify sent you.');
      return;
    }
    state.files = files;

    var list = $('file-list');
    list.innerHTML = files.map(function (f) {
      return '<li><span class="bidi">' + esc(f.name) + '</span>' +
        '<span class="size">' + (f.size / 1048576).toFixed(1) + ' MB</span></li>';
    }).join('');
    list.hidden = false;
    analyzeBtn.disabled = false;
  }

  function showUploadError(message) {
    var list = $('file-list');
    list.innerHTML = '<li><span>' + esc(message) + '</span></li>';
    list.hidden = false;
  }

  analyzeBtn.addEventListener('click', startImport);

  /* =====================================================================
   * Stage 2 — importing
   * ================================================================== */

  function showStage(name) {
    $('stage-upload').hidden = name !== 'upload';
    $('stage-loading').hidden = name !== 'loading';
    $('stage-report').hidden = name !== 'report';
    if (name !== 'loading') window.scrollTo(0, 0);
  }

  function setProgress(info) {
    var title = $('loader-title'), sub = $('loader-sub');
    var bar = $('progress-bar'), wrap = $('progress');

    if (info.phase === 'read') {
      title.textContent = 'Reading your files';
      sub.textContent = info.label + ' — ' + info.current + ' of ' + info.total;
      wrap.hidden = false;
      bar.style.width = ((info.current - 1) / info.total * 100).toFixed(1) + '%';
    } else if (info.phase === 'dedupe') {
      title.textContent = 'Tidying up';
      sub.textContent = C.fmtNum(info.total) + ' plays found. Removing duplicates from overlapping exports…';
      wrap.hidden = true;
    } else if (info.phase === 'match') {
      title.textContent = 'Matching tracks';
      sub.textContent = 'Merging the same song filed under different releases.';
      wrap.hidden = true;
    } else if (info.phase === 'deezer') {
      title.textContent = 'Deep matching';
      sub.textContent = 'Checking release codes — ' + info.current + ' of ' + info.total + ' tracks.';
      wrap.hidden = false;
      bar.style.width = (info.total ? info.current / info.total * 100 : 0).toFixed(1) + '%';
    } else if (info.phase === 'aggregate') {
      title.textContent = 'Building your report';
      sub.textContent = 'Almost there.';
      wrap.hidden = true;
    }
  }

  function startImport() {
    showStage('loading');
    setProgress({ phase: 'read', current: 1, total: state.files.length, label: state.files[0].name });

    var useDeezer = $('deep-match').checked && DEEZER_PROXY;
    if ($('deep-match').checked && !DEEZER_PROXY) {
      console.warn('Deep matching is switched on but DEEZER_PROXY is empty in app.js — skipping it.');
    }

    var worker = null;
    try {
      worker = new Worker('assets/js/worker.js');
    } catch (e) {
      worker = null;   // e.g. opened via file://
    }

    if (worker) {
      worker.onmessage = function (event) {
        var msg = event.data;
        if (msg.type === 'progress') setProgress(msg.info);
        else if (msg.type === 'done') { worker.terminate(); onDataset(msg.dataset); }
        else if (msg.type === 'error') { worker.terminate(); onImportError(msg.message); }
      };
      worker.onerror = function () {
        worker.terminate();
        runOnMainThread(useDeezer);
      };
      worker.postMessage({ type: 'process', files: state.files, deezerProxy: useDeezer ? DEEZER_PROXY : null });
    } else {
      runOnMainThread(useDeezer);
    }
  }

  function runOnMainThread(useDeezer) {
    window.SpotifyProcessing.processFiles(state.files, {
      deezerProxy: useDeezer ? DEEZER_PROXY : null,
      onProgress: setProgress
    }).then(onDataset).catch(function (err) {
      onImportError(err && err.message ? err.message : String(err));
    });
  }

  function onImportError(message) {
    showStage('upload');
    showUploadError(message);
  }

  /* =====================================================================
   * Stage 3 — the report
   * ================================================================== */

  function onDataset(dataset) {
    // Typed arrays arrive transferred; rebuild the views on this side.
    state.data = dataset;

    var b = A.bounds(dataset);
    state.minDay = b.minDay;
    state.maxDay = b.maxDay;
    state.startDay = b.minDay;
    state.endDay = b.maxDay;

    buildYearPickers();
    wireControls();

    var link = $('profile-link').value.trim();
    var out = $('profile-out');
    if (/^https?:\/\/(open\.)?spotify\.com\//i.test(link)) {
      out.href = link;
      out.hidden = false;
    }

    showStage('report');
    refresh();
  }

  function buildYearPickers() {
    var years = A.yearsIn(state.data, A.fullRange(state.data));
    $('year-quick').innerHTML = '<option value="all">All time</option>' +
      years.map(function (y) { return '<option value="' + y + '">' + y + '</option>'; }).join('');
  }

  /** The per-chart year pickers only offer years the current date range
   *  actually contains, so narrowing the dates can never leave a chart
   *  pointing at a year with nothing in it. */
  function refreshYearPickers() {
    var years = A.yearsIn(state.data, state.range);
    var busiest = busiestYear(state.range);

    ['calendar-year', 'timeline-year', 'session-year'].forEach(function (id) {
      var el = $(id);
      var previous = el.value;
      var prefix = id === 'calendar-year' ? '' : '<option value="all">All time</option>';
      el.innerHTML = prefix + years.map(function (y) {
        return '<option value="' + y + '">' + y + '</option>';
      }).join('');

      var stillValid = Array.prototype.some.call(el.options, function (o) { return o.value === previous; });
      if (stillValid) el.value = previous;
      else if (id === 'calendar-year') el.value = busiest != null ? String(busiest) : '';
      else el.value = 'all';
    });
  }

  function busiestYear(r) {
    var D = state.data, counts = new Map();
    for (var i = r.lo; i < r.hi; i++) counts.set(D.year[i], (counts.get(D.year[i]) || 0) + 1);
    var best = null, bestN = -1;
    counts.forEach(function (v, k) { if (v > bestN) { bestN = v; best = k; } });
    return best;
  }

  var controlsWired = false;

  function wireControls() {
    if (controlsWired) return;
    controlsWired = true;

    $('year-quick').addEventListener('change', function () {
      var v = this.value;
      if (v === 'all') {
        state.startDay = state.minDay; state.endDay = state.maxDay;
      } else {
        var y = +v;
        state.startDay = Math.max(state.minDay, A.dateToDayNum(new Date(y, 0, 1)));
        state.endDay = Math.min(state.maxDay, A.dateToDayNum(new Date(y, 11, 31)));
      }
      syncDateInputs();
      refresh();
    });

    $('date-start').addEventListener('change', function () {
      if (!this.value) return;
      state.startDay = clampDay(A.isoToDayNum(this.value));
      if (state.startDay > state.endDay) state.endDay = state.startDay;
      $('year-quick').value = 'all';
      syncDateInputs();
      refresh();
    });

    $('date-end').addEventListener('change', function () {
      if (!this.value) return;
      state.endDay = clampDay(A.isoToDayNum(this.value));
      if (state.endDay < state.startDay) state.startDay = state.endDay;
      $('year-quick').value = 'all';
      syncDateInputs();
      refresh();
    });

    $('reset-dates').addEventListener('click', function () {
      state.startDay = state.minDay;
      state.endDay = state.maxDay;
      $('year-quick').value = 'all';
      syncDateInputs();
      refresh();
    });

    $('restart-btn').addEventListener('click', function () {
      state.data = null;
      state.files = [];
      $('file-list').hidden = true;
      $('file-list').innerHTML = '';
      fileInput.value = '';
      analyzeBtn.disabled = true;
      showStage('upload');
    });

    $('track-count').addEventListener('change', renderTopTracks);
    $('artist-count').addEventListener('change', renderTopArtists);
    $('obsession-count').addEventListener('change', renderObsession);
    $('calendar-year').addEventListener('change', renderCalendar);
    $('timeline-year').addEventListener('change', renderTimeline);
    $('session-year').addEventListener('change', renderSessions);
    $('session-gap').addEventListener('change', renderSessions);
    $('make-playlist').addEventListener('click', renderPlaylist);
    $('copy-playlist').addEventListener('click', copyPlaylist);

    setupSearch('track');
    setupSearch('artist');
    setupTooltip();
    watchColourScheme();
  }

  /* Browsers do not always re-resolve a custom property used as an SVG paint
     when the colour scheme flips, so charts drawn under the old theme keep the
     old ink. Redrawing them on the change is the reliable fix. */
  function watchColourScheme() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      if (!state.data || !state.range) return;
      renderHabits();
      renderCalendar();
      renderTimeline();
      renderWhen();
      renderSessions();
      renderTrackDetail();
      renderArtistDetail();
      if (state.playlist) renderPlaylist();
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  function clampDay(d) { return Math.min(state.maxDay, Math.max(state.minDay, d)); }

  /** Reference point for "right now" scoring.
   *  An export downloaded months ago should still be scored against the day
   *  its data ends, otherwise every track looks equally stale and recency
   *  stops telling us anything. */
  function referenceMs() {
    return Math.min(Date.now(), (state.endDay + 1) * 86400000);
  }

  function syncDateInputs() {
    var s = $('date-start'), e = $('date-end');
    s.min = e.min = A.dayNumToIso(state.minDay);
    s.max = e.max = A.dayNumToIso(state.maxDay);
    s.value = A.dayNumToIso(state.startDay);
    e.value = A.dayNumToIso(state.endDay);
  }

  /* ---------------------------------------------------------------------
   * Full refresh — runs on load and on every date change
   * ------------------------------------------------------------------ */

  function refresh() {
    var D = state.data;
    state.range = A.range(D, state.startDay, state.endDay);
    syncDateInputs();

    // An empty range still renders: every section has an empty state, and
    // stopping early here would leave the previous range's figures on screen.
    refreshYearPickers();
    state.search = A.buildSearchIndex(D, state.range);
    state.selectedTrack = state.search.tracks.length ? state.search.tracks[0].id : null;
    state.selectedArtist = state.search.artists.length ? state.search.artists[0].id : null;

    renderHeader();
    renderGlance();
    renderTopTracks();
    renderTopArtists();
    renderTopAlbums();
    renderHabits();
    renderCalendar();
    renderTimeline();
    renderWhen();
    renderObsession();
    renderSessions();
    renderTrackDetail();
    renderArtistDetail();
    renderFunFacts();

    $('playlist').innerHTML = '';
    $('copy-playlist').hidden = true;
    state.playlist = null;

    resetSearchInputs();
  }

  function fmtDay(dayNum, opts) {
    return A.dayNumToDate(dayNum).toLocaleDateString(undefined,
      opts || { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function renderHeader() {
    $('report-range').textContent = fmtDay(state.startDay) + ' – ' + fmtDay(state.endDay);
    var days = state.endDay - state.startDay + 1;
    $('filter-note').textContent = state.range.hi > state.range.lo
      ? C.fmtNum(days) + (days === 1 ? ' day covered' : ' days covered')
      : 'No plays in these dates — widen the range.';
  }

  function renderGlance() {
    var g = A.glance(state.data, state.range);
    $('hero-hours').textContent = C.fmtNum(g.hours, g.hours < 100 ? 1 : 0);
    $('stat-streams').textContent = C.fmtNum(g.streams);
    $('stat-tracks').textContent = C.fmtNum(g.uniqueTracks);
    $('stat-artists').textContent = C.fmtNum(g.uniqueArtists);

    if (g.topTrack) {
      $('stat-top').innerHTML = '<span class="bidi">' + esc(g.topTrack.name) + '</span>' +
        '<br><span class="panel-sub bidi">' + esc(g.topTrack.artist) + ' · ' +
        C.fmtNum(g.topTrack.plays) + ' plays</span>';
    } else {
      $('stat-top').textContent = '—';
    }

    var perDay = g.hours / Math.max(1, state.endDay - state.startDay + 1);
    $('hero-line').innerHTML = 'That is about <strong>' + C.fmtNum(perDay * 60, 0) +
      ' minutes a day</strong>, across <strong>' + C.fmtNum(g.streams) + '</strong> streams of ' +
      'at least 30 seconds.';

    var st = state.data.stats;
    $('merge-note').textContent = st.merged > 0
      ? C.fmtNum(st.rawUris) + ' Spotify track IDs were merged into ' + C.fmtNum(st.tracks) +
        ' distinct songs, so remixes, re-releases and extended versions count once.'
      : 'Every Spotify track ID in your export was already a distinct song.';
  }

  /* ------------------------------------------------------------ lists -- */

  function rankRow(opts) {
    return '<div class="rank-row' + (opts.onClick ? ' is-clickable' : '') + '"' +
      (opts.dataId != null ? ' data-id="' + opts.dataId + '"' : '') + '>' +
      '<span class="rank-n">' + opts.rank + '</span>' +
      '<span class="rank-meta">' +
        '<span class="rank-name bidi">' + esc(opts.name) + '</span>' +
        (opts.sub ? '<span class="rank-sub bidi">' + esc(opts.sub) + '</span>' : '') +
      '</span>' +
      (opts.barPct != null
        ? '<span class="rank-bar"><i style="width:' + opts.barPct.toFixed(1) + '%"></i></span>' : '') +
      (opts.pill || '') +
      (opts.figure
        ? '<span class="rank-figure">' + opts.figure +
          (opts.figureSub ? '<small>' + opts.figureSub + '</small>' : '') + '</span>' : '') +
      '</div>';
  }

  function renderTopTracks() {
    var n = +$('track-count').value;
    var rows = A.topTracks(state.data, state.range, n);
    var max = rows.length ? rows[0].plays : 1;

    $('top-tracks').innerHTML = rows.length
      ? '<div class="rank-list">' + rows.map(function (t) {
          return rankRow({
            rank: t.rank, name: t.name, sub: t.artist, dataId: t.id, onClick: true,
            barPct: (t.plays / max) * 100,
            figure: C.fmtNum(t.plays), figureSub: C.fmtNum(t.hours, 1) + ' h'
          });
        }).join('') + '</div>'
      : '<p class="empty">No tracks in this range.</p>';

    bindRankClicks('top-tracks', function (id) { selectTrack(id); });
  }

  function renderTopArtists() {
    var n = +$('artist-count').value;
    var rows = A.topArtists(state.data, state.range, n);
    var max = rows.length ? rows[0].plays : 1;

    $('top-artists').innerHTML = rows.length
      ? '<div class="rank-list">' + rows.map(function (a) {
          return rankRow({
            rank: a.rank, name: a.name,
            sub: C.fmtNum(a.tracks) + (a.tracks === 1 ? ' track' : ' tracks'),
            dataId: a.id, onClick: true,
            barPct: (a.plays / max) * 100,
            figure: C.fmtNum(a.plays), figureSub: C.fmtNum(a.hours, 1) + ' h'
          });
        }).join('') + '</div>'
      : '<p class="empty">No artists in this range.</p>';

    bindRankClicks('top-artists', function (id) { selectArtist(id); });
  }

  function renderTopAlbums() {
    var rows = A.topAlbums(state.data, state.range, 10);
    var max = rows.length ? rows[0].plays : 1;

    $('top-albums').innerHTML = rows.length
      ? '<div class="rank-list">' + rows.map(function (b) {
          return rankRow({
            rank: b.rank, name: b.name, sub: b.artist,
            barPct: (b.plays / max) * 100,
            figure: C.fmtNum(b.plays), figureSub: C.fmtNum(b.hours, 1) + ' h'
          });
        }).join('') + '</div>'
      : '<p class="empty">No album information in this export.</p>';
  }

  function bindRankClicks(containerId, handler) {
    var container = $(containerId);
    container.querySelectorAll('.rank-row.is-clickable').forEach(function (row) {
      row.addEventListener('click', function () { handler(+row.dataset.id); });
    });
  }

  /* ----------------------------------------------------------- habits -- */

  function renderHabits() {
    var h = A.habits(state.data, state.range);

    $('habit-skip').textContent = Math.round(h.skipRate * 100) + '%';
    $('habit-shuffle').textContent = Math.round(h.shuffleRate * 100) + '%';
    $('habit-offline').textContent = Math.round(h.offlineRate * 100) + '%';

    $('habit-skip-detail').innerHTML = h.mostSkipped
      ? 'Most abandoned: <span class="bidi">' + esc(h.mostSkipped.name) + '</span> (' +
        Math.round(h.mostSkipped.rate * 100) + '% of its plays)'
      : 'No track has enough plays to single out yet.';

    $('habit-reasons').innerHTML = h.reasons.map(function (r) {
      return '<li><span class="rl-name">' + esc(r.name) + '</span>' +
        '<span class="rl-bar"><i style="width:' + (r.share * 100).toFixed(1) + '%"></i></span>' +
        '<span class="rl-pct">' + Math.round(r.share * 100) + '%</span></li>';
    }).join('');

    $('platform-donut').innerHTML = C.donut({ items: h.platforms });
    $('platform-legend').innerHTML = h.platforms.slice(0, 6).map(function (p, i) {
      return '<li><span class="dot" data-c="' + i + '"></span>' +
        '<span class="name">' + esc(p.name) + '</span>' +
        '<span class="pct">' + (p.share * 100 < 1 ? '<1' : Math.round(p.share * 100)) + '%</span></li>';
    }).join('');
  }

  /* --------------------------------------------------------- calendar -- */

  function renderCalendar() {
    var year = +$('calendar-year').value;
    if (!year) { $('calendar').innerHTML = '<p class="empty">No year selected.</p>'; return; }
    var counts = A.calendar(state.data, state.range, year);
    $('calendar').innerHTML = counts.size
      ? C.calendarHeatmap({ year: year, counts: counts })
      : '<p class="empty">No plays recorded in ' + year + ' within the selected dates.</p>';
  }

  function renderTimeline() {
    var v = $('timeline-year').value;
    var year = v === 'all' ? null : +v;
    var series = A.monthlyHours(state.data, state.range, year);
    $('timeline').innerHTML = C.barChart({
      labels: series.map(function (s) { return s.label; }),
      values: series.map(function (s) { return s.value; }),
      unit: 'hours', decimals: 1, height: 300,
      labelAngle: series.length > 14,
      tips: series.map(function (s) { return s.label + ' — ' + C.fmtNum(s.value, 1) + ' hours'; })
    });
  }

  var DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  function renderWhen() {
    var hours = A.byHour(state.data, state.range);
    var hourMax = Math.max.apply(null, hours);
    $('hour-peak').textContent = hourMax > 0
      ? 'Busiest around ' + String(hours.indexOf(hourMax)).padStart(2, '0') + ':00'
      : '';
    $('chart-hour').innerHTML = C.barChart({
      labels: hours.map(function (_, i) { return String(i); }),
      values: hours, unit: 'streams', height: 260, showValues: false,
      tips: hours.map(function (v, i) {
        return String(i).padStart(2, '0') + ':00 — ' + C.fmtNum(v) + ' streams';
      })
    });

    var dows = A.byDayOfWeek(state.data, state.range);
    var dowMax = Math.max.apply(null, dows);
    $('dow-peak').textContent = dowMax > 0
      ? DAY_NAMES[dows.indexOf(dowMax)] + ' is your heaviest day'
      : '';
    $('chart-dow').innerHTML = C.barChart({
      labels: DAY_NAMES.map(function (d) { return d.slice(0, 3); }),
      values: dows, unit: 'streams', height: 260,
      tips: dows.map(function (v, i) { return DAY_NAMES[i] + ' — ' + C.fmtNum(v) + ' streams'; })
    });
  }

  /* -------------------------------------------------------- obsession -- */

  function renderObsession() {
    var n = +$('obsession-count').value;
    var rows = A.obsession(state.data, state.range, referenceMs(), n);

    $('obsession-list').innerHTML = rows.length
      ? '<div class="rank-list">' + rows.map(function (t, i) {
          var tier = t.score >= 80 ? 1 : t.score >= 55 ? 2 : 3;
          return rankRow({
            rank: i + 1, name: t.name, sub: t.artist, dataId: t.id, onClick: true,
            pill: '<span class="score-pill" data-tier="' + tier + '">' + t.score.toFixed(1) + '</span>',
            figure: C.fmtNum(t.plays), figureSub: C.fmtNum(t.days) + ' days'
          });
        }).join('') + '</div>'
      : '<p class="empty">Not enough plays in this range.</p>';

    bindRankClicks('obsession-list', function (id) { selectTrack(id); });

    var sample = rows[2] || rows[0];
    $('explain-example').innerHTML = sample
      ? 'For example, <strong class="bidi">' + esc(sample.name) + '</strong> by <span class="bidi">' +
        esc(sample.artist) + '</span>: ' + C.fmtNum(sample.plays) + ' plays across ' +
        C.fmtNum(sample.days) + ' separate days, last heard ' +
        (sample.daysSinceLast === 0 ? 'today' : sample.daysSinceLast + ' days ago') +
        ' — score ' + sample.score.toFixed(1) + '.'
      : '';
  }

  /* --------------------------------------------------------- playlist -- */

  function renderPlaylist() {
    var rows = A.playlist(state.data, state.range, 50, referenceMs());
    state.playlist = rows;

    $('playlist').innerHTML = rows.length
      ? '<div class="rank-list">' + rows.map(function (t, i) {
          return rankRow({
            rank: i + 1, name: t.name, sub: t.artist, dataId: t.id, onClick: true,
            pill: '<span class="tag" data-kind="' +
              (t.source === 'On repeat now' ? 'repeat' : 'classic') + '">' +
              esc(t.source) + '</span>'
          });
        }).join('') + '</div>'
      : '<p class="empty">Not enough tracks in this range to build a playlist.</p>';

    bindRankClicks('playlist', function (id) { selectTrack(id); });
    $('copy-playlist').hidden = !rows.length;
  }

  function copyPlaylist() {
    if (!state.playlist) return;
    var text = state.playlist.map(function (t, i) {
      return (i + 1) + '. ' + t.name + ' — ' + t.artist;
    }).join('\n');

    var btn = $('copy-playlist');
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy list'; }, 1800);
    }).catch(function () {
      btn.textContent = 'Copy failed';
      setTimeout(function () { btn.textContent = 'Copy list'; }, 1800);
    });
  }

  /* --------------------------------------------------------- sessions -- */

  function renderSessions() {
    var gap = +$('session-gap').value;
    var v = $('session-year').value;
    var year = v === 'all' ? null : +v;

    var summary = A.sessionSummary(state.data, state.range, gap);
    $('session-summary').innerHTML = 'A session ends after <strong>' + gap +
      (gap === 1 ? ' hour' : ' hours') + '</strong> of silence. You had <strong>' +
      C.fmtNum(summary.sessions) + '</strong> of them, averaging <strong>' +
      C.fmtNum(summary.avgMinutes, 0) + ' minutes</strong>. The longest ran ' +
      C.fmtNum(summary.longestMinutes / 60, 1) + ' hours' +
      (summary.longestStart
        ? ' starting ' + summary.longestStart.toLocaleDateString(undefined,
            { day: 'numeric', month: 'long', year: 'numeric' }) + '.'
        : '.');

    var series = A.sessionsPerMonth(state.data, state.range, gap, year);
    $('chart-sessions').innerHTML = C.barChart({
      labels: series.map(function (s) { return s.label; }),
      values: series.map(function (s) { return s.value; }),
      unit: 'sessions', height: 280,
      labelAngle: series.length > 14,
      tips: series.map(function (s) { return s.label + ' — ' + C.fmtNum(s.value) + ' sessions'; })
    });
  }

  /* ----------------------------------------------------------- search -- */

  function setupSearch(kind) {
    var input = $(kind + '-search');
    var results = $(kind + '-results');
    var activeIndex = -1;

    function close() { results.hidden = true; input.setAttribute('aria-expanded', 'false'); activeIndex = -1; }

    function open(items) {
      if (!items.length) { close(); return; }
      results.innerHTML = items.map(function (item, i) {
        return '<li role="option" data-id="' + item.id + '" data-i="' + i + '">' +
          '<span><span class="bidi">' + esc(item.name) + '</span>' +
          (kind === 'track' ? '<span class="sr-sub bidi"> — ' + esc(item.artist) + '</span>' : '') +
          '</span><span class="sr-plays">' + C.fmtNum(item.plays) + '</span></li>';
      }).join('');
      results.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      activeIndex = -1;

      results.querySelectorAll('li').forEach(function (li) {
        li.addEventListener('mousedown', function (e) {
          e.preventDefault();
          choose(+li.dataset.id);
        });
      });
    }

    function choose(id) {
      close();
      input.value = '';
      if (kind === 'track') selectTrack(id); else selectArtist(id);
    }

    function search(term) {
      var pool = kind === 'track' ? state.search.tracks : state.search.artists;
      term = term.trim().toLowerCase();
      if (!term) return pool.slice(0, 12);
      var out = [];
      for (var i = 0; i < pool.length && out.length < 30; i++) {
        if (pool[i].search.indexOf(term) !== -1) out.push(pool[i]);
      }
      return out;
    }

    input.addEventListener('input', function () { open(search(input.value)); });
    input.addEventListener('focus', function () { if (state.search) open(search(input.value)); });
    input.addEventListener('blur', function () { setTimeout(close, 120); });

    input.addEventListener('keydown', function (e) {
      var items = results.querySelectorAll('li');
      if (results.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex += e.key === 'ArrowDown' ? 1 : -1;
        if (activeIndex < 0) activeIndex = items.length - 1;
        if (activeIndex >= items.length) activeIndex = 0;
        items.forEach(function (li, i) { li.classList.toggle('is-active', i === activeIndex); });
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(+items[Math.max(0, activeIndex)].dataset.id);
      } else if (e.key === 'Escape') {
        close();
      }
    });
  }

  function resetSearchInputs() {
    $('track-search').value = '';
    $('artist-search').value = '';
    $('track-results').hidden = true;
    $('artist-results').hidden = true;
  }

  function selectTrack(id) {
    state.selectedTrack = id;
    renderTrackDetail();
    $('track-detail').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function selectArtist(id) {
    state.selectedArtist = id;
    renderArtistDetail();
    $('artist-detail').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ----------------------------------------------------------- detail -- */

  function statCell(label, value) {
    return '<div class="stat"><span class="stat-label">' + esc(label) +
      '</span><span class="stat-value">' + value + '</span></div>';
  }

  function milestone(label, value, sub, tone) {
    return '<div class="milestone"' + (tone ? ' data-tone="' + tone + '"' : '') + '>' +
      '<div class="m-label">' + esc(label) + '</div>' +
      '<div class="m-value bidi">' + value + '</div>' +
      (sub ? '<div class="m-sub">' + sub + '</div>' : '') + '</div>';
  }

  function streakText(streak) {
    if (!streak.longest) return { value: 'No streak yet', sub: '' };
    return {
      value: streak.longest + (streak.longest === 1 ? ' day' : ' days in a row'),
      sub: streak.longest > 1 && streak.longestStart != null
        ? fmtDay(streak.longestStart, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) +
          ' → ' + fmtDay(streak.longestEnd, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        : ''
    };
  }

  function renderTrackDetail() {
    if (state.selectedTrack == null) {
      $('track-detail').innerHTML = '<p class="empty">Pick a track to see its story.</p>';
      return;
    }
    var ranked = A.topTracks(state.data, state.range, 0) || [];
    var t = A.trackDetail(state.data, state.range, state.selectedTrack, ranked);
    if (!t.plays) {
      $('track-detail').innerHTML = '<p class="empty">That track has no plays in the selected dates.</p>';
      return;
    }

    var st = streakText(t.streak);
    $('track-detail').innerHTML =
      '<div class="detail-head"><h3 class="bidi">' + esc(t.name) + '</h3>' +
      '<span class="by bidi">' + esc(t.artist) + '</span></div>' +
      (t.album ? '<p class="panel-sub bidi">From ' + esc(t.album) + '</p>' : '') +
      '<div class="detail-strip">' +
        statCell('Streams', C.fmtNum(t.plays)) +
        statCell('Hours', C.fmtNum(t.hours, 1)) +
        statCell('Rank', t.rank ? '#' + t.rank : '—') +
        statCell('Days played', C.fmtNum(t.daysPlayed)) +
      '</div>' +
      '<div class="detail-cols">' +
        '<div>' + C.areaChart({
          labels: t.monthly.map(function (m) { return m.label; }),
          values: t.monthly.map(function (m) { return m.value; }),
          height: 230, unit: 'plays'
        }) + '</div>' +
        '<div class="milestones">' +
          milestone('First listen',
            t.firstListen ? t.firstListen.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—') +
          milestone('Busiest day',
            t.busiestDay != null ? fmtDay(t.busiestDay) : '—',
            t.busiestPlays ? C.fmtNum(t.busiestPlays) + ' plays that day' : '', 'teal') +
          milestone('Longest streak', st.value, st.sub, 'quiet') +
        '</div>' +
      '</div>';
  }

  function renderArtistDetail() {
    if (state.selectedArtist == null) {
      $('artist-detail').innerHTML = '<p class="empty">Pick an artist to see their story.</p>';
      return;
    }
    var ranked = A.topArtists(state.data, state.range, 0) || [];
    var a = A.artistDetail(state.data, state.range, state.selectedArtist, ranked);
    if (!a.plays) {
      $('artist-detail').innerHTML = '<p class="empty">That artist has no plays in the selected dates.</p>';
      return;
    }

    var st = streakText(a.streak);
    $('artist-detail').innerHTML =
      '<div class="detail-head"><h3 class="bidi">' + esc(a.name) + '</h3></div>' +
      '<div class="detail-strip">' +
        statCell('Streams', C.fmtNum(a.plays)) +
        statCell('Hours', C.fmtNum(a.hours, 1)) +
        statCell('Rank', a.rank ? '#' + a.rank : '—') +
        statCell('Tracks', C.fmtNum(a.uniqueTracks)) +
      '</div>' +
      '<div class="detail-cols">' +
        '<div>' + C.areaChart({
          labels: a.monthly.map(function (m) { return m.label; }),
          values: a.monthly.map(function (m) { return m.value; }),
          height: 230, unit: 'plays'
        }) + '</div>' +
        '<div class="milestones">' +
          milestone('Most played track',
            a.topTracks[0] ? esc(a.topTracks[0].name) : '—',
            a.topTracks[0] ? C.fmtNum(a.topTracks[0].plays) + ' plays' : '') +
          milestone('First listen',
            a.firstListen ? a.firstListen.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—',
            '', 'teal') +
          milestone('Longest streak', st.value, st.sub, 'quiet') +
        '</div>' +
      '</div>';
  }

  /* -------------------------------------------------------- fun facts -- */

  function renderFunFacts() {
    var f = A.funFacts(state.data, state.range);
    var tt = A.timeTravel(state.data);

    if (tt && tt.plays) {
      $('time-travel').innerHTML =
        '<h3>One year earlier — ' + fmtDay(tt.day) + '</h3>' +
        '<p>You played <strong>' + C.fmtNum(tt.plays) + '</strong> streams (' +
        C.fmtNum(tt.hours, 1) + ' hours) that day.' +
        (tt.topTrack ? ' On heaviest rotation: <strong class="bidi">' + esc(tt.topTrack.name) +
          '</strong> by <span class="bidi">' + esc(tt.topTrack.artist) + '</span>.' : '') +
        (tt.obsession ? ' Your top obsession at the time was <strong class="bidi">' +
          esc(tt.obsession.name) + '</strong>.' : '') + '</p>';
      $('time-travel').hidden = false;
    } else {
      $('time-travel').hidden = true;
    }

    var cards = [];
    var s = f.streak;

    cards.push(fact('Current streak',
      s.current ? s.current + (s.current === 1 ? ' day' : ' days') : 'Not listening today',
      s.current ? 'Consecutive days with music.' : 'Play something to start one.'));

    var ls = streakText(s);
    cards.push(fact('Longest streak', ls.value, ls.sub));

    if (f.topArtist) cards.push(fact('Most hours', f.topArtist.name, C.fmtNum(f.topArtist.hours, 0) + ' hours'));
    if (f.busiestDay) cards.push(fact('Biggest day', fmtDay(f.busiestDay.day), C.fmtNum(f.busiestDay.hours, 1) + ' hours of music'));
    if (f.bestMonth) cards.push(fact('Biggest month', f.bestMonth.label, C.fmtNum(f.bestMonth.hours, 0) + ' hours'));
    if (f.firstTrack) {
      cards.push(fact('Where it starts', f.firstTrack.name,
        f.firstTrack.artist + ' · ' +
        f.firstTrack.date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })));
    }
    if (f.mostDiverse) cards.push(fact('Widest catalogue', f.mostDiverse.name, C.fmtNum(f.mostDiverse.count) + ' different tracks played'));

    $('fact-grid').innerHTML = cards.join('');
  }

  function fact(label, value, sub) {
    return '<div class="fact"><div class="f-label">' + esc(label) + '</div>' +
      '<div class="f-value bidi">' + esc(value) + '</div>' +
      (sub ? '<div class="f-sub bidi">' + esc(sub) + '</div>' : '') + '</div>';
  }

  /* ---------------------------------------------------------- tooltip -- */

  function setupTooltip() {
    var tip = $('tooltip');
    var current = null;

    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest('[data-tip]');
      if (!el) return;
      current = el;
      tip.textContent = el.getAttribute('data-tip');
      tip.classList.add('is-on');
    });

    document.addEventListener('mousemove', function (e) {
      if (!current) return;
      var pad = 14;
      var x = Math.min(e.clientX + pad, window.innerWidth - tip.offsetWidth - 8);
      var y = e.clientY - tip.offsetHeight - 10;
      if (y < 8) y = e.clientY + pad;
      tip.style.left = Math.max(8, x) + 'px';
      tip.style.top = y + 'px';
    });

    document.addEventListener('mouseout', function (e) {
      if (!current) return;
      if (e.target.closest('[data-tip]') === current) {
        current = null;
        tip.classList.remove('is-on');
      }
    });
  }
})();
