(() => {
  "use strict";

  const STORAGE_PREFIX = "siteVolume:v4:";
  const VOLUME_POLICY_EVENT = "marumaru-volume-control-v4:policy";
  const USER_VOLUME_CHANGE_EVENT = "marumaru-volume-control-v4:user-change";
  const MEDIA_SELECTOR = "video, audio";
  const VOLUME_EPSILON = 0.001;
  const EXPECTED_VOLUME_TIMEOUT_MS = 1600;
  const USER_GESTURE_WINDOW_MS = 300;
  const SAVE_DEBOUNCE_MS = 150;
  const RESTORE_RAMP_MS = 16;
  const RESTORE_STEP_MS = 4;

  let savedVolume = null;
  let savedUpdatedAt = 0;
  let lastUserGestureAt = Number.NEGATIVE_INFINITY;
  let pendingRecord = null;
  let saveTimer = null;
  let volumePointerActive = false;

  const expectedVolumes = new WeakMap();
  const restoreTimers = new WeakMap();

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

  const storageKey = `${STORAGE_PREFIX}${siteKey}`;

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

  function setExpectedVolume(media, volume) {
    expectedVolumes.set(media, volume);

    window.setTimeout(() => {
      if (expectedVolumes.get(media) === volume) {
        expectedVolumes.delete(media);
      }
    }, EXPECTED_VOLUME_TIMEOUT_MS);
  }

  function cancelRestoreVolume(media) {
    const timer = restoreTimers.get(media);
    if (timer !== undefined) {
      window.clearInterval(timer);
      restoreTimers.delete(media);
    }
  }

  function applyVolume(media, volume = savedVolume) {
    if (!isMediaElement(media)) return;

    const normalized = clampVolume(volume);
    if (normalized === null) return;

    cancelRestoreVolume(media);
    if (Math.abs(media.volume - normalized) <= VOLUME_EPSILON) return;

    setExpectedVolume(media, normalized);
    try {
      media.volume = normalized;
    } catch (_error) {
      expectedVolumes.delete(media);
    }
  }

  function restoreVolumeSmoothly(media, volume = savedVolume) {
    if (!isMediaElement(media)) return;

    const normalized = clampVolume(volume);
    if (normalized === null) return;

    cancelRestoreVolume(media);

    const startVolume = media.volume;
    const difference = Math.abs(startVolume - normalized);
    if (difference <= VOLUME_EPSILON) return;

    // 背景頁面的短計時器可能被節流；大幅爆音也應優先立即壓低。
    if (document.hidden || difference >= 0.35) {
      applyVolume(media, normalized);
      return;
    }

    const startedAt = performance.now();
    const step = () => {
      if (isRecentUserGesture()) {
        cancelRestoreVolume(media);
        return;
      }

      const progress = Math.min(1, (performance.now() - startedAt) / RESTORE_RAMP_MS);
      const nextVolume = startVolume + ((normalized - startVolume) * progress);

      setExpectedVolume(media, nextVolume);
      try {
        media.volume = nextVolume;
      } catch (_error) {
        expectedVolumes.delete(media);
        cancelRestoreVolume(media);
        return;
      }

      if (progress >= 1) cancelRestoreVolume(media);
    };

    const timer = window.setInterval(step, RESTORE_STEP_MS);
    restoreTimers.set(media, timer);
    step();
  }

  function applyVolumeToAll() {
    if (savedVolume === null) return;
    getMediaElements().forEach((media) => applyVolume(media));
  }

  function createRecord(volume, source, updatedAt = nextUpdatedAt()) {
    return {
      hostname: siteKey,
      volume,
      updatedAt,
      source
    };
  }

  function cancelPendingSave() {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    pendingRecord = null;
  }

  function saveObservedVolume(volume) {
    const normalized = clampVolume(volume);
    if (normalized === null) return;

    const record = createRecord(normalized, "page");
    savedVolume = normalized;
    savedUpdatedAt = record.updatedAt;
    pendingRecord = record;
    publishVolumePolicy(normalized);

    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
    }

    saveTimer = window.setTimeout(async () => {
      const recordToSave = pendingRecord;
      saveTimer = null;

      if (recordToSave === null || !chrome.runtime?.id) return;

      try {
        await chrome.storage.local.set({
          [storageKey]: recordToSave
        });
      } catch (_error) {
        // 擴充功能重新載入時，舊 content script 可能暫時失效。
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function isRecentUserGesture() {
    return performance.now() - lastUserGestureAt <= USER_GESTURE_WINDOW_MS;
  }

  function rememberUserGesture() {
    lastUserGestureAt = performance.now();
  }

  function elementLooksLikeVolumeControl(element) {
    if (!(element instanceof Element)) return false;

    const classHint = typeof element.className === "string" ? element.className : "";
    const hints = [
      element.id,
      classHint,
      element.getAttribute("name"),
      element.getAttribute("aria-label"),
      element.getAttribute("aria-valuetext"),
      element.getAttribute("title"),
      element.getAttribute("data-tooltip-text"),
      element.getAttribute("data-title-no-tooltip")
    ].filter(Boolean).join(" ");

    return /(volume|audio|sound|mute|音量|聲音)/i.test(hints);
  }

  function eventTargetsVolumeControl(event) {
    const path = typeof event.composedPath === "function"
      ? event.composedPath()
      : [event.target];

    return path.some(elementLooksLikeVolumeControl);
  }

  function keyboardCanAdjustVolume(event) {
    return eventTargetsVolumeControl(event)
      || event.key === "ArrowUp"
      || event.key === "ArrowDown";
  }

  async function loadSavedVolume() {
    try {
      // 同時讀取 v4 記錄與 v2/v3 使用的舊網域數值。
      const result = await chrome.storage.local.get([storageKey, siteKey]);
      const record = result[storageKey];

      if (record && typeof record === "object") {
        const volume = clampVolume(record.volume);
        if (volume !== null) {
          const recordUpdatedAt = normalizeUpdatedAt(record.updatedAt);
          if (recordUpdatedAt < savedUpdatedAt) return;

          savedVolume = volume;
          savedUpdatedAt = recordUpdatedAt;
          publishVolumePolicy(volume);
          applyVolumeToAll();
          return;
        }
      }

      // 等待 storage 期間若使用者已調整音量，不讓較舊的空結果覆蓋它。
      if (savedUpdatedAt > 0) return;

      const legacyVolume = clampVolume(result[siteKey]);
      if (legacyVolume !== null) {
        const migrationRecord = createRecord(legacyVolume, "migration");
        savedVolume = legacyVolume;
        savedUpdatedAt = migrationRecord.updatedAt;
        publishVolumePolicy(legacyVolume);
        await chrome.storage.local.set({
          [storageKey]: migrationRecord
        });
        applyVolumeToAll();
      } else {
        publishVolumePolicy(null);
      }
    } catch (_error) {
      // 擴充功能重新載入時，舊 content script 可能暫時失效。
    }
  }

  document.addEventListener("pointerdown", (event) => {
    volumePointerActive = eventTargetsVolumeControl(event);
    if (volumePointerActive) rememberUserGesture();
  }, true);

  document.addEventListener("pointermove", () => {
    if (volumePointerActive) rememberUserGesture();
  }, true);

  ["pointerup", "pointercancel"].forEach((eventName) => {
    document.addEventListener(eventName, () => {
      if (volumePointerActive) rememberUserGesture();
      volumePointerActive = false;
    }, true);
  });

  document.addEventListener("keydown", (event) => {
    if (keyboardCanAdjustVolume(event)) rememberUserGesture();
  }, true);

  document.addEventListener("wheel", (event) => {
    if (eventTargetsVolumeControl(event)) rememberUserGesture();
  }, {
    capture: true,
    passive: true
  });

  // 主執行環境已確認這次 setter 來自明確的音量控制操作時，直接保存。
  // 不等待 volumechange，避免瀏覽器延遲派送事件超過短操作窗口。
  document.addEventListener(USER_VOLUME_CHANGE_EVENT, (event) => {
    const media = event.target;
    if (!isMediaElement(media)) return;

    const volume = clampVolume(event.detail);
    if (volume === null) return;

    rememberUserGesture();
    cancelRestoreVolume(media);
    saveObservedVolume(volume);
  }, true);

  document.addEventListener("volumechange", (event) => {
    const media = event.target;
    if (!isMediaElement(media)) return;

    const currentVolume = clampVolume(media.volume);
    if (currentVolume === null) return;

    const expected = expectedVolumes.get(media);
    if (expected !== undefined && Math.abs(currentVolume - expected) <= VOLUME_EPSILON) {
      expectedVolumes.delete(media);
      return;
    }

    // muted 改變也會觸發 volumechange；音量數字沒變時不重寫記錄。
    if (savedVolume !== null && Math.abs(currentVolume - savedVolume) <= VOLUME_EPSILON) {
      return;
    }

    // 只有明確的音量控制操作可以更新記錄。網站腳本自行修改音量時，
    // 不採用該數值，並把播放器恢復成使用者最後保存的音量。
    if (isRecentUserGesture()) {
      cancelRestoreVolume(media);
      saveObservedVolume(currentVolume);
      return;
    }

    if (savedVolume !== null) {
      restoreVolumeSmoothly(media);
    }
  }, true);

  ["loadedmetadata", "play"].forEach((eventName) => {
    document.addEventListener(eventName, (event) => {
      if (isMediaElement(event.target) && savedVolume !== null) {
        applyVolume(event.target);
      }
    }, true);
  });

  const observer = new MutationObserver((mutations) => {
    if (savedVolume === null) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (isMediaElement(node)) {
          applyVolume(node);
        } else {
          getMediaElements(node).forEach((media) => applyVolume(media));
        }
      }
    }
  });

  observer.observe(document, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[storageKey]) return;

    const nextRecord = changes[storageKey].newValue;
    if (!nextRecord) {
      cancelPendingSave();
      savedVolume = null;
      savedUpdatedAt = nextUpdatedAt();
      publishVolumePolicy(null);
      return;
    }

    const nextVolume = clampVolume(nextRecord.volume);
    if (nextVolume === null) return;

    const nextRecordUpdatedAt = normalizeUpdatedAt(nextRecord.updatedAt);
    if (nextRecordUpdatedAt < savedUpdatedAt) return;

    savedVolume = nextVolume;
    savedUpdatedAt = nextRecordUpdatedAt;
    publishVolumePolicy(nextVolume);
    applyVolumeToAll();
  });

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
        sendResponse({ ok: true, siteKey, volume: nextVolume });
      } else {
        sendResponse({ ok: false, siteKey });
      }
      return;
    }

    if (request?.action === "clearSiteVolume") {
      cancelPendingSave();
      savedVolume = null;
      savedUpdatedAt = nextUpdatedAt();
      publishVolumePolicy(null);
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
