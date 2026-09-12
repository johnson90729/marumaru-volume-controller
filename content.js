(() => {
  "use strict";
  const PREFIX = "siteGain:v5:";
  const POLICY_EVENT = "marumaru-volume-v5:policy";
  const QUERY_EVENT = "marumaru-volume-v5:query";
  const STATE_EVENT = "marumaru-volume-v5:state";

  function topHostname() {
    if (window.top === window) return location.hostname.toLowerCase();
    const origins = location.ancestorOrigins;
    try { if (origins?.length) return new URL(origins[origins.length - 1]).hostname.toLowerCase(); } catch (_error) {}
    try { if (document.referrer) return new URL(document.referrer).hostname.toLowerCase(); } catch (_error) {}
    return location.hostname.toLowerCase();
  }
  const hostname = topHostname();
  const key = PREFIX + hostname;
  let factor = 0;
  let configured = false;
  let initializing = true;
  let initializationError = false;
  let revision = 0;
  let snapshot = null;

  function applyRecord(record) {
    const value = record?.gain;
    configured = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
    factor = configured ? value : 1;
    initializing = false;
    initializationError = false;
    document.dispatchEvent(new CustomEvent(POLICY_EVENT, { detail: String(factor) }));
  }

  // Page-supplied telemetry is read-only; it never changes saved settings.
  document.addEventListener(STATE_EVENT, (event) => {
    try {
      const value = JSON.parse(event.detail);
      const media = value.media;
      snapshot = {
        mediaCount: Number.isInteger(value.mediaCount) ? Math.max(0, Math.min(10000, value.mediaCount)) : 0,
        media: media && [media.playerVolume, media.outputVolume].every((v) =>
          typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)
          ? { playerVolume: media.playerVolume, outputVolume: media.outputVolume,
            muted: media.muted === true, playing: media.playing === true } : null
      };
    } catch (_error) { snapshot = null; }
  }, true);

  function state() {
    snapshot = null;
    document.dispatchEvent(new Event(QUERY_EVENT));
    return { hostname, factor, configured, initializing, initializationError,
      bridgeReady: snapshot !== null, mediaCount: snapshot?.mediaCount || 0, media: snapshot?.media || null };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.prototype.hasOwnProperty.call(changes, key)) return;
    revision++;
    applyRecord(changes[key].newValue);
  });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.action !== "collectGainState" || typeof request.requestId !== "string") return;
    chrome.runtime.sendMessage({ action: "gainFrameState", requestId: request.requestId, state: state() })
      .then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  });

  async function readWithTimeout() {
    let timer;
    try {
      return await Promise.race([
        chrome.storage.local.get(key),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Storage timeout")), 1500); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function initialize() {
    for (const delay of [0, 250, 1000, 3000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (revision > 0) return;
      try {
        const values = await readWithTimeout();
        if (revision === 0) applyRecord(values[key]);
        return;
      } catch (_error) {}
    }
    if (revision === 0) initializationError = true;
  }
  if (hostname) initialize();
  else applyRecord(null);
})();
