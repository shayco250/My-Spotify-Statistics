/* =============================================================================
 * charts.js — hand-rolled SVG charts.
 *
 * No charting library: every mark is drawn here, so the page carries no
 * megabyte-sized dependency and the charts inherit the site's own colour
 * tokens in both light and dark themes.
 *
 * All renderers return an SVG string. Elements carrying a data-tip attribute
 * are picked up by the shared tooltip in app.js.
 * ========================================================================== */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtNum(n, digits) {
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0
    });
  }

  function niceCeil(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var norm = v / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  /* ---------------------------------------------------------------------
   * Vertical bar chart with a highlighted peak
   * ------------------------------------------------------------------ */

  function barChart(opts) {
    var labels = opts.labels || [];
    var values = opts.values || [];
    var n = values.length;
    if (!n) return emptyState('Nothing to show for this range.');

    var W = 900, H = opts.height || 300;
    var padL = 46, padR = 12, padT = 22, padB = opts.labelAngle ? 62 : 34;
    var plotW = W - padL - padR, plotH = H - padT - padB;

    var max = Math.max.apply(null, values);
    var top = niceCeil(max * 1.12) || 1;
    var peak = values.indexOf(max);

    var slot = plotW / n;
    var barW = Math.max(2, Math.min(slot * 0.72, 56));
    var digits = opts.decimals == null ? 0 : opts.decimals;

    var parts = [];

    // horizontal guides
    for (var g = 0; g <= 4; g++) {
      var gv = top * g / 4;
      var gy = padT + plotH - (gv / top) * plotH;
      parts.push('<line class="grid" x1="' + padL + '" y1="' + gy.toFixed(1) +
        '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '"/>');
      parts.push('<text class="axis" x="' + (padL - 8) + '" y="' + (gy + 4).toFixed(1) +
        '" text-anchor="end">' + esc(fmtNum(gv, gv < 10 && digits ? digits : 0)) + '</text>');
    }

    for (var i = 0; i < n; i++) {
      var v = values[i];
      var h = top > 0 ? (v / top) * plotH : 0;
      var x = padL + slot * i + (slot - barW) / 2;
      var y = padT + plotH - h;
      var isPeak = i === peak && max > 0;
      var tip = (opts.tips && opts.tips[i]) || (labels[i] + ' — ' + fmtNum(v, digits) + ' ' + (opts.unit || ''));

      // Mutually exclusive classes: two rules painting the same SVG element
      // from custom properties can go stale when the colour scheme flips.
      parts.push('<rect class="' + (isPeak ? 'bar-peak' : 'bar') + '" x=' +
        '"' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) +
        '" height="' + Math.max(0, h).toFixed(1) + '" rx="3" data-tip="' + esc(tip) + '"/>');

      if (opts.showValues !== false && n <= 26 && v > 0) {
        parts.push('<text class="bar-value" x="' + (x + barW / 2).toFixed(1) +
          '" y="' + (y - 6).toFixed(1) + '" text-anchor="middle">' +
          esc(fmtNum(v, digits)) + '</text>');
      }

      var lx = padL + slot * i + slot / 2;
      var ly = padT + plotH + 18;
      // A year's worth of months fits comfortably; several years of them do
      // not, so the labels shrink rather than collide.
      var axisClass = n > 14 ? 'axis axis-dense' : 'axis';
      if (opts.labelAngle) {
        parts.push('<text class="' + axisClass + '" x="' + lx.toFixed(1) + '" y="' + ly +
          '" text-anchor="end" transform="rotate(-45 ' + lx.toFixed(1) + ' ' + ly + ')">' +
          esc(labels[i]) + '</text>');
      } else if (n <= 32 || i % Math.ceil(n / 24) === 0) {
        parts.push('<text class="' + axisClass + '" x="' + lx.toFixed(1) + '" y="' + ly +
          '" text-anchor="middle">' + esc(labels[i]) + '</text>');
      }
    }

    return svgWrap(W, H, parts.join(''));
  }

  /* ---------------------------------------------------------------------
   * Area / line chart
   * ------------------------------------------------------------------ */

  function areaChart(opts) {
    var labels = opts.labels || [];
    var values = opts.values || [];
    var n = values.length;
    if (!n) return emptyState('No plays in this range.');
    if (n === 1) {
      return barChart({ labels: labels, values: values, height: opts.height || 220, unit: opts.unit });
    }

    var W = 900, H = opts.height || 240;
    var padL = 44, padR = 14, padT = 18, padB = 34;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var max = Math.max.apply(null, values);
    var top = niceCeil(max * 1.15) || 1;

    var pts = values.map(function (v, i) {
      return {
        x: padL + (plotW * i) / (n - 1),
        y: padT + plotH - (top ? (v / top) * plotH : 0),
        v: v, label: labels[i]
      };
    });

    var line = pts.map(function (p, i) {
      return (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
    }).join(' ');
    var area = line + ' L' + pts[n - 1].x.toFixed(1) + ' ' + (padT + plotH) +
      ' L' + pts[0].x.toFixed(1) + ' ' + (padT + plotH) + ' Z';

    var parts = [];
    for (var g = 0; g <= 3; g++) {
      var gv = top * g / 3;
      var gy = padT + plotH - (gv / top) * plotH;
      parts.push('<line class="grid" x1="' + padL + '" y1="' + gy.toFixed(1) +
        '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '"/>');
      parts.push('<text class="axis" x="' + (padL - 8) + '" y="' + (gy + 4).toFixed(1) +
        '" text-anchor="end">' + esc(fmtNum(gv)) + '</text>');
    }

    parts.push('<path class="area-fill" d="' + area + '"/>');
    parts.push('<path class="area-line" d="' + line + '"/>');

    var everyLabel = Math.ceil(n / 12);
    pts.forEach(function (p, i) {
      parts.push('<circle class="area-dot" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) +
        '" r="' + (n > 40 ? 2 : 3.5) + '" data-tip="' +
        esc(p.label + ' — ' + fmtNum(p.v) + ' ' + (opts.unit || 'plays')) + '"/>');
      if (i % everyLabel === 0 || i === n - 1) {
        parts.push('<text class="axis" x="' + p.x.toFixed(1) + '" y="' + (padT + plotH + 18) +
          '" text-anchor="middle">' + esc(p.label) + '</text>');
      }
    });

    return svgWrap(W, H, parts.join(''));
  }

  /* ---------------------------------------------------------------------
   * Calendar heatmap — one column per week, one cell per day
   * ------------------------------------------------------------------ */

  var DAY_MS = 86400000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
                  'Thursday', 'Friday', 'Saturday'];

  /* Fixed play-count bands, so a colour means the same thing whichever year
     you are looking at and the legend can state real numbers. */
  var HEAT_BANDS = [
    { min: 0,   max: 0,        label: '0' },
    { min: 1,   max: 20,       label: '1–20' },
    { min: 21,  max: 50,       label: '21–50' },
    { min: 51,  max: 70,       label: '51–70' },
    { min: 71,  max: 99,       label: '71–99' },
    { min: 100, max: 149,      label: '100–149' },
    { min: 150, max: Infinity, label: '150+' }
  ];

  function heatLevel(plays) {
    for (var i = HEAT_BANDS.length - 1; i > 0; i--) {
      if (plays >= HEAT_BANDS[i].min) return i;
    }
    return 0;
  }

  /**
   * One row per month, one column per day of the month: the shape of a wall
   * calendar, so a month's character reads across a single line.
   *
   * `year` may be null, meaning every year stacked onto one calendar.
   */
  function calendarHeatmap(opts) {
    var year = opts.year;                 // null = all time
    var counts = opts.counts;             // Map<month * 32 + day, plays>
    var CELL = 22, GAP = 4, TOPPAD = 24, LEFTPAD = 40;

    var parts = [];

    // Day-of-month scale along the top.
    for (var dnum = 1; dnum <= 31; dnum++) {
      parts.push('<text class="axis" x="' +
        (LEFTPAD + (dnum - 1) * (CELL + GAP) + CELL / 2) + '" y="' + (TOPPAD - 8) +
        '" text-anchor="middle">' + dnum + '</text>');
    }

    for (var m = 0; m < 12; m++) {
      var y = TOPPAD + m * (CELL + GAP);
      parts.push('<text class="axis" x="' + (LEFTPAD - 10) + '" y="' + (y + CELL / 2 + 4) +
        '" text-anchor="end">' + MONTHS[m] + '</text>');

      // Across all years, 29 February exists somewhere.
      var daysInMonth = year == null
        ? [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m]
        : new Date(year, m + 1, 0).getDate();

      for (var day = 1; day <= 31; day++) {
        var x = LEFTPAD + (day - 1) * (CELL + GAP);
        if (day > daysInMonth) {
          // Keep the grid rectangular but show that the day does not exist.
          parts.push('<rect class="hm-void" x="' + x + '" y="' + y + '" width="' + CELL +
            '" height="' + CELL + '" rx="4"/>');
          continue;
        }

        var v = counts.get(m * 32 + day) || 0;
        var tip;
        if (year == null) {
          tip = day + ' ' + MONTHS[m] + ', every year — ' +
            (v === 0 ? 'no plays' : fmtNum(v) + (v === 1 ? ' play' : ' plays'));
        } else {
          tip = day + ' ' + MONTHS[m] + ' ' + year + ', ' +
            WEEKDAYS[new Date(year, m, day).getDay()] + ' — ' +
            (v === 0 ? 'no plays' : fmtNum(v) + (v === 1 ? ' play' : ' plays'));
        }

        parts.push('<rect class="hm-cell" data-level="' + heatLevel(v) + '" x="' + x +
          '" y="' + y + '" width="' + CELL + '" height="' + CELL +
          '" rx="4" data-tip="' + esc(tip) + '"/>');
      }
    }

    var W = LEFTPAD + 31 * (CELL + GAP);
    var H = TOPPAD + 12 * (CELL + GAP);
    return '<svg class="chart heatmap" width="' + W + '" height="' + H +
      '" viewBox="0 0 ' + W + ' ' + H + '" role="img">' + parts.join('') + '</svg>';
  }

  /* ---------------------------------------------------------------------
   * Donut
   * ------------------------------------------------------------------ */

  /**
   * Proportional rectangles across the full width: each block is sized by its
   * share, so the comparison is a length you read directly rather than an
   * angle you estimate. Built from HTML rather than SVG because the blocks
   * have to stretch while their labels stay the right size and shape.
   */
  function shareBlocks(opts) {
    var items = opts.items || [];
    var total = items.reduce(function (s, i) { return s + i.count; }, 0);
    if (!total) return emptyState('No plays in this range.');

    var shown = items.slice(0, 6);
    var shownTotal = shown.reduce(function (s, i) { return s + i.count; }, 0);

    var blocks = shown.map(function (item, i) {
      var share = item.count / shownTotal;
      var pct = Math.round(item.share * 100);
      var label = pct < 1 ? '<1%' : pct + '%';

      return '<div class="share-block" data-c="' + i + '" style="flex-grow:' +
        share.toFixed(5) + '" data-tip="' +
        esc(item.name + ' — ' + label + ' (' + fmtNum(item.count) + ' plays)') + '">' +
        '<span class="share-pct">' + label + '</span>' +
        '<span class="share-name">' + esc(item.name) + '</span>' +
        (item.detail ? '<span class="share-detail">' + esc(item.detail) + '</span>' : '') +
        '</div>';
    }).join('');

    return '<div class="share-blocks">' + blocks + '</div>';
  }

  function donut(opts) {
    var items = opts.items || [];
    var total = items.reduce(function (s, i) { return s + i.count; }, 0);
    if (!total) return emptyState('No plays in this range.');

    var size = opts.size || 168, r = size / 2 - 14, cx = size / 2, cy = size / 2, sw = 22;
    var angle = -90;
    var parts = [];

    items.slice(0, 6).forEach(function (item, i) {
      var sweep = (item.count / total) * 360;
      if (sweep <= 0) return;
      parts.push(arc(cx, cy, r, angle, angle + Math.min(sweep, 359.99), sw, i,
        item.name + ' — ' + Math.round(item.share * 100) + '% (' + fmtNum(item.count) + ' plays)'));
      angle += sweep;
    });

    parts.push('<text class="donut-total" x="' + cx + '" y="' + (cy - 2) +
      '" text-anchor="middle">' + esc(items[0] ? Math.round(items[0].share * 100) + '%' : '') + '</text>');
    parts.push('<text class="donut-caption" x="' + cx + '" y="' + (cy + 16) +
      '" text-anchor="middle">' + esc(items[0] ? items[0].name : '') + '</text>');

    return '<svg class="chart donut" width="' + size + '" height="' + size +
      '" viewBox="0 0 ' + size + ' ' + size + '" role="img">' + parts.join('') + '</svg>';
  }

  function arc(cx, cy, r, a0, a1, sw, colorIndex, tip) {
    var rad = function (deg) { return deg * Math.PI / 180; };
    var x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0));
    var x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1));
    var large = (a1 - a0) > 180 ? 1 : 0;
    return '<path class="slice" data-c="' + colorIndex + '" d="M ' + x0.toFixed(2) + ' ' + y0.toFixed(2) +
      ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) +
      '" stroke-width="' + sw + '" fill="none" data-tip="' + esc(tip) + '"/>';
  }

  /* ---------------------------------------------------------------------
   * Shared plumbing
   * ------------------------------------------------------------------ */

  function svgWrap(W, H, inner) {
    // Scales with the container while keeping text undistorted.
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img">' + inner + '</svg>';
  }

  function emptyState(message) {
    return '<p class="empty">' + esc(message) + '</p>';
  }

  global.SpotifyCharts = {
    barChart: barChart,
    areaChart: areaChart,
    calendarHeatmap: calendarHeatmap,
    shareBlocks: shareBlocks,
    donut: donut,
    HEAT_BANDS: HEAT_BANDS,
    esc: esc,
    fmtNum: fmtNum
  };
})(typeof self !== 'undefined' ? self : this);
