(() => {
  "use strict";
  const PREFIX = "siteGain:v5:";
  const collections = new Map();
  let sequence = 0;
  let mutations = Promise.resolve();

  function hostnameOf(value) {
    if (typeof value !== "string" || !value || value.length > 253) return null;
    try {
      const url = new URL(`https://${value}`);
      return url.hostname === value.toLowerCase() && !url.port && url.pathname === "/" && !url.search && !url.hash
        && !url.username && !url.password ? url.hostname : null;
    } catch (_error) { return null; }
  }
  function mutate(operation) {
    const pending = mutations.catch(() => {}).then(operation);
    mutations = pending;
    return pending;
  }

  async function getTabState(tabId, hostname) {
    const requestId = `${Date.now()}:${++sequence}`;
    const frames = new Map();
    collections.set(requestId, { tabId, hostname, frames });
    let connected = true;
    try {
      await Promise.race([
        chrome.tabs.sendMessage(tabId, { action: "collectGainState", requestId }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("No frame response")), 1000))
      ]);
      // Each frame reports separately; the tabs API only returns the first reply.
      await new Promise((resolve) => setTimeout(resolve, 60));
    } catch (_error) { connected = false; }
    collections.delete(requestId);
    const values = await chrome.storage.local.get(PREFIX + hostname);
    const saved = values[PREFIX + hostname]?.gain;
    const configured = typeof saved === "number" && Number.isFinite(saved) && saved >= 0 && saved <= 1;
    const states = [...frames.values()];
    const candidates = states.filter((s) => s.media).sort((a, b) =>
      (Number(b.media.playing) * 2 + Number(!b.media.muted)) - (Number(a.media.playing) * 2 + Number(!a.media.muted)));
    return { ok: true, connected: connected && states.length > 0, factor: configured ? saved : 1, configured,
      initializing: states.some((s) => s.initializing), initializationError: states.some((s) => s.initializationError),
      bridgeReady: states.length > 0 && states.every((s) => s.bridgeReady),
      mediaCount: states.reduce((sum, s) => sum + s.mediaCount, 0), media: candidates[0]?.media || null };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action === "gainFrameState") {
      const collection = collections.get(request.requestId);
      if (collection && sender.tab?.id === collection.tabId && request.state?.hostname === collection.hostname) {
        collection.frames.set(sender.frameId, request.state);
      }
      sendResponse({ ok: true });
      return;
    }
    // Only extension pages (the popup), never website content scripts, may save factors.
    if (sender.tab || sender.id !== chrome.runtime.id) return;
    const hostname = hostnameOf(request?.hostname);
    if (request?.action === "getGainTabState" && hostname && Number.isInteger(request.tabId)) {
      getTabState(request.tabId, hostname).then(sendResponse).catch(() => sendResponse({ ok: false }));
      return true;
    }
    let operation;
    if (request?.action === "setSiteGain" && hostname && typeof request.gain === "number"
        && Number.isFinite(request.gain) && request.gain >= 0 && request.gain <= 1) {
      operation = () => chrome.storage.local.set({
        [PREFIX + hostname]: { hostname, gain: request.gain, updatedAt: Date.now() }
      });
    } else if (request?.action === "deleteSiteGain" && hostname) {
      operation = () => chrome.storage.local.remove(PREFIX + hostname);
    } else if (request?.action === "clearSiteGains") {
      operation = async () => {
        const values = await chrome.storage.local.get(null);
        await chrome.storage.local.remove(Object.keys(values).filter((key) => key.startsWith(PREFIX)));
      };
    }
    if (operation) {
      mutate(operation).then(() => sendResponse({ ok: true, persisted: true }))
        .catch(() => sendResponse({ ok: false, persisted: false }));
      return true;
    }
  });
})();
