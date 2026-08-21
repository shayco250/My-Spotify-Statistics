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
    // Hand the typed arrays over rather than copying them. Collected by
    // walking the payload so a renamed or added array can never be missed.
    var transfer = [];
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      if (ArrayBuffer.isView(value)) {
        if (transfer.indexOf(value.buffer) === -1) transfer.push(value.buffer);
        return;
      }
      Object.keys(value).forEach(function (key) { collect(value[key]); });
    }
    collect(dataset);

    self.postMessage({ type: 'done', dataset: dataset }, transfer);
  }).catch(function (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  });
};
