/* =============================================================================
 * worker.js — runs the import off the main thread so the page stays responsive
 * while a few hundred megabytes of listening history are parsed.
 * ========================================================================== */
/* global importScripts, SpotifyProcessing */
importScripts('processing.js');

self.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.type !== 'process') return;

  SpotifyProcessing.processFiles(msg.files, {
    deezerProxy: msg.deezerProxy || null,
    onProgress: function (info) { self.postMessage({ type: 'progress', info: info }); }
  }).then(function (dataset) {
    // Hand the typed arrays over rather than copying them.
    var transfer = [
      dataset.ts.buffer, dataset.sec.buffer, dataset.trackId.buffer,
      dataset.dayNum.buffer, dataset.year.buffer, dataset.month.buffer,
      dataset.hour.buffer, dataset.dow.buffer, dataset.platformId.buffer,
      dataset.reasonId.buffer, dataset.flags.buffer,
      dataset.trackArtistId.buffer, dataset.trackAlbumId.buffer
    ];
    self.postMessage({ type: 'done', dataset: dataset }, transfer);
  }).catch(function (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  });
};
