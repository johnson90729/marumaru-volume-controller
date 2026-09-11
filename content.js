(() => {
  "use strict";

  const STORAGE_PREFIX = "siteVolume:v4:";
  const VOLUME_POLICY_EVENT = "marumaru-volume-control-v4:policy";
  const MEDIA_SELECTOR = "video, audio";
  const VOLUME_EPSILON = 0.001;
  const REAPPLY_DELAYS_MS = [0, 50, 150, 400, 1000, 2000];

  let savedVolume = null;
  let savedUpdatedAt = 0;
  let reapplyGeneration = 0;


  function clampVolume(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.min(1, Math.max(0, number));
  }

  function normalizeUpdatedAt(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function nextUpdatedAt() {
    return Math.max(Date.now(), savedUpdatedAt + 1);
  }

  function normalizeHostname(hostname) {
    return String(hostname || "").trim().toLowerCase();
  }

  function getTopLevelHostname() {
    if (window.top === window) {
      return normalizeHostname(window.location.hostname);
    }

    const origins = window.location.ancestorOrigins;
    if (origins && origins.length > 0) {
      try {
        return normalizeHostname(new URL(origins[origins.length - 1]).hostname);
      } catch (_error) {
        // 繼續嘗試下一種方式。
      }
    }

    try {
      if (document.referrer) {
        return normalizeHostname(new URL(document.referrer).hostname);
      }
    } catch (_error) {
      // document.referrer 可能不是有效網址。
    }

    return normalizeHostname(window.location.hostname);
  }

  const siteKey = getTopLevelHostname();
  if (!siteKey) return;

  function isMediaElement(value) {
    return value instanceof HTMLMediaElement;
  }

  function getMediaElements(root = document) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    return root.querySelectorAll(MEDIA_SELECTOR);
  }

  function publishVolumePolicy(volume) {
    const normalized = clampVolume(volume);
    document.dispatchEvent(new CustomEvent(VOLUME_POLICY_EVENT, {
      detail: normalized === null ? "" : String(normalized)
    }));
  }

  function applyVolume(media, volume = savedVolume) {
    if (!isMediaElement(media)) return;
    const normalized = clampVolume(volume);
    if (normalized === null) return;
    // Zero is exact: even a tiny nonzero volume must be silenced.
    if (normalized === 0 ? media.volume === 0 : Math.abs(media.volume - normalized) <= VOLUME_EPSILON) return;
    try {
      media.volume = normalized;
    } catch (_error) {
      // A detached or inaccessible media element may reject a write.
    }
  }

  function applyVolumeToAll() {
    if (savedVolume === null) return;
    getMediaElements().forEach((media) => applyVolume(media));
  }

  function scheduleReapplyBurst() {
    const generation = ++reapplyGeneration;
    for (const delay of REAPPLY_DELAYS_MS) {
      window.setTimeout(() => {
        if (generation !== reapplyGeneration || savedVolume === null) return;
        publishVolumePolicy(savedVolume);
        applyVolumeToAll();
      }, delay);
    }
  }

  function createRecord(volume, source, updatedAt = nextUpdatedAt()) {
    return {
      hostname: siteKey,
      volume,
      updatedAt,
      source
    };
  }

  async function loadSavedVolume() {
    // Start both reads together. Service-worker startup must not delay the
    // default; subsequent user/popup changes must win over either read.
    const tabStatePromise = Promise.resolve().then(() => chrome.runtime.sendMessage({
      action: "getTabVolume",
      hostname: siteKey
    })).catch(() => null);

    try {
      const storageKey = `${STORAGE_PREFIX}${siteKey}`;
      const localValues = await chrome.storage.local.get([storageKey, siteKey]);
      const storedDefault = clampVolume(localValues[storageKey]?.volume);
      const defaultVolume = storedDefault ?? clampVolume(localValues[siteKey]);

      if (savedUpdatedAt === 0 && defaultVolume !== null) {
        savedVolume = defaultVolume;
        publishVolumePolicy(defaultVolume);
        applyVolumeToAll();
        scheduleReapplyBurst();
      }

      if (storedDefault === null && defaultVolume !== null) {
        chrome.storage.local.set({
          [storageKey]: createRecord(defaultVolume, "migration")
        }).catch(() => {});
      }
    } catch (_error) {
      // Session volume is still usable if reading local storage failed.
    }

    const state = await tabStatePromise;
    if (savedUpdatedAt > 0) return;
    const volume = clampVolume(state?.tabVolume) ?? savedVolume;
    if (volume !== null) {
      savedVolume = volume;
      savedUpdatedAt = Date.now();
      publishVolumePolicy(volume);
      applyVolumeToAll();
      scheduleReapplyBurst();
    } else {
      publishVolumePolicy(null);
    }
  }

  // The extension is authoritative, including during slider/keyboard gestures.
  // Never record a player's own volume as an extension setting.
  document.addEventListener("volumechange", (event) => {
    if (savedVolume !== null) applyVolume(event.target);
  }, true);

  ["loadedmetadata", "play", "playing"].forEach((eventName) => {
    document.addEventListener(eventName, (event) => {
      if (isMediaElement(event.target) && savedVolume !== null) {
        applyVolume(event.target);
        scheduleReapplyBurst();
      }
    }, true);
  });

  // YouTube and similar SPA sites initialize their player after navigation and
  // may restore their own volume after the media element already exists.
  ["yt-navigate-finish", "yt-page-data-updated", "popstate"].forEach((eventName) => {
    window.addEventListener(eventName, scheduleReapplyBurst, true);
  });

  const observer = new MutationObserver((mutations) => {
    if (savedVolume === null) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (isMediaElement(node)) {
          applyVolume(node);
          scheduleReapplyBurst();
        } else {
          const mediaElements = getMediaElements(node);
          mediaElements.forEach((media) => applyVolume(media));
          if (mediaElements.length > 0) scheduleReapplyBurst();
        }
      }
    }
  });

  observer.observe(document, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.action === "setVolume") {
      const nextVolume = clampVolume(request.volume);
      if (nextVolume !== null) {
        const requestedUpdatedAt = normalizeUpdatedAt(request.updatedAt) || nextUpdatedAt();
        if (requestedUpdatedAt < savedUpdatedAt) {
          sendResponse({ ok: true, siteKey, volume: savedVolume, stale: true });
          return;
        }

        savedVolume = nextVolume;
        savedUpdatedAt = requestedUpdatedAt;
        publishVolumePolicy(nextVolume);
        applyVolumeToAll();
        chrome.runtime.sendMessage({
          action: "saveTabVolume",
          hostname: siteKey,
          volume: nextVolume,
          updatedAt: requestedUpdatedAt,
          source: "extension"
        }).catch(() => {});
        sendResponse({ ok: true, siteKey, volume: nextVolume });
      } else {
        sendResponse({ ok: false, siteKey });
      }
      return;
    }

    if (request?.action === "clearSiteVolume") {
      savedVolume = null;
      savedUpdatedAt = nextUpdatedAt();
      publishVolumePolicy(null);
      chrome.runtime.sendMessage({ action: "clearTabVolume" }).catch(() => {});
      sendResponse({ ok: true, siteKey });
      return;
    }

    if (request?.action === "getSiteState") {
      const media = getMediaElements()[0] || null;
      sendResponse({
        ok: true,
        siteKey,
        savedVolume,
        currentVolume: media ? media.volume : null
      });
    }
  });

  loadSavedVolume();
})();
