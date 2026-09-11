(() => {
  "use strict";

  const SITE_PREFIX = "siteVolume:v4:";
  // Older entries may contain player-generated values, including 100 over a
  // saved default of zero. Only extension-controlled entries are reused.
  const TAB_PREFIX = "tabVolume:v4:extension:";

  function clampVolume(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.min(1, Math.max(0, number));
  }

  function tabStorageKey(tabId) {
    return `${TAB_PREFIX}${tabId}`;
  }

  async function getVolumeState(tabId, hostname) {
    const tabKey = tabStorageKey(tabId);
    const siteKey = `${SITE_PREFIX}${hostname}`;
    const [tabValues, localValues] = await Promise.all([
      chrome.storage.session.get(tabKey),
      chrome.storage.local.get([siteKey, hostname])
    ]);
    const tabRecord = tabValues[tabKey];
    const tabVolume = tabRecord?.hostname === hostname
      ? clampVolume(tabRecord.volume)
      : null;
    let defaultVolume = clampVolume(localValues[siteKey]?.volume);

    // v2/v3 stored the volume directly under the hostname.
    if (defaultVolume === null) defaultVolume = clampVolume(localValues[hostname]);

    return {
      tabVolume,
      defaultVolume,
      volume: tabVolume ?? defaultVolume,
      source: tabVolume !== null ? "tab" : (defaultVolume !== null ? "site" : null)
    };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) return;

    if (request?.action === "getTabVolume") {
      getVolumeState(tabId, String(request.hostname || "").toLowerCase())
        .then((state) => sendResponse({ ok: true, ...state }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (request?.action === "saveTabVolume") {
      if (request.source !== "extension") {
        sendResponse({ ok: false });
        return;
      }
      const volume = clampVolume(request.volume);
      if (volume === null) {
        sendResponse({ ok: false });
        return;
      }
      chrome.storage.session.set({
        [tabStorageKey(tabId)]: {
          hostname: String(request.hostname || "").toLowerCase(),
          volume,
          updatedAt: Number(request.updatedAt) || Date.now()
        }
      }).then(() => sendResponse({ ok: true, tabId, volume }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (request?.action === "clearTabVolume") {
      chrome.storage.session.remove(tabStorageKey(tabId))
        .then(() => sendResponse({ ok: true, tabId }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(tabStorageKey(tabId));
  });
})();
