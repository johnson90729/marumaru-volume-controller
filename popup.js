(() => {
  "use strict";

  const STORAGE_PREFIX = "siteVolume:v4:";
  const slider = document.getElementById("volumeSlider");
  const input = document.getElementById("volumeInput");
  const currentSiteLabel = document.getElementById("currentSite");
  const status = document.getElementById("status");
  const historyList = document.getElementById("historyList");
  const clearAllButton = document.getElementById("clearAll");
  const setSiteDefaultButton = document.getElementById("setSiteDefault");

  let activeTabId = null;
  let currentSiteKey = null;

  function clampPercent(value) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return 0;
    return Math.min(100, Math.max(0, number));
  }

  function storageKeyFor(siteKey) {
    return `${STORAGE_PREFIX}${siteKey}`;
  }

  function isVolumeRecord(value) {
    return value
      && typeof value === "object"
      && value.volume !== null && value.volume !== "" && value.volume !== undefined
      && Number.isFinite(Number(value.volume));
  }

  function setControls(percent) {
    const normalized = clampPercent(percent);
    slider.value = String(normalized);
    input.value = String(normalized);
  }

  function setSupported(supported) {
    slider.disabled = !supported;
    input.disabled = !supported;
    setSiteDefaultButton.disabled = !supported;
  }

  function formatUpdatedAt(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return "時間未知";

    return new Intl.DateTimeFormat("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  async function sendToActiveTab(message) {
    if (activeTabId === null) return null;

    try {
      return await chrome.tabs.sendMessage(activeTabId, message);
    } catch (_error) {
      return null;
    }
  }

  async function renderHistory() {
    const allValues = await chrome.storage.local.get(null);
    const records = Object.entries(allValues)
      .filter(([key, value]) => key.startsWith(STORAGE_PREFIX) && isVolumeRecord(value))
      .map(([key, value]) => ({ key, ...value }))
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));

    historyList.replaceChildren();

    if (records.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "尚未記錄任何網站音量";
      historyList.append(empty);
      clearAllButton.disabled = true;
      return;
    }

    clearAllButton.disabled = false;

    for (const record of records) {
      const row = document.createElement("div");
      row.className = "history-item";

      const details = document.createElement("div");
      const hostname = document.createElement("div");
      const updatedAt = document.createElement("div");
      const volume = document.createElement("div");
      const remove = document.createElement("button");

      hostname.className = "history-site";
      hostname.textContent = record.hostname || record.key.slice(STORAGE_PREFIX.length);

      updatedAt.className = "history-time";
      updatedAt.textContent = `更新：${formatUpdatedAt(record.updatedAt)}`;

      volume.className = "history-volume";
      volume.textContent = `${Math.round(Number(record.volume) * 100)}%`;

      remove.type = "button";
      remove.className = "delete-record";
      remove.dataset.storageKey = record.key;
      remove.setAttribute("aria-label", `刪除 ${hostname.textContent} 的記錄`);
      remove.title = "刪除記錄";
      remove.textContent = "×";

      details.append(hostname, updatedAt);
      row.append(details, volume, remove);
      historyList.append(row);
    }
  }

  async function updateFromControl(value) {
    const percent = clampPercent(value);
    const updatedAt = Date.now();
    setControls(percent);
    status.textContent = `目前分頁音量：${percent}%`;
    const response = await sendToActiveTab({ action: "setVolume", volume: percent / 100, updatedAt });
    if (!response?.ok) status.textContent = "尚未套用，請重新整理影片頁面後再調整音量";
  }

  setSiteDefaultButton.addEventListener("click", async () => {
    if (!currentSiteKey) return;
    const percent = clampPercent(input.value);
    const key = storageKeyFor(currentSiteKey);
    await chrome.storage.local.set({
      [key]: {
        hostname: currentSiteKey,
        volume: percent / 100,
        updatedAt: Date.now(),
        source: "popup-default"
      }
    });
    const response = await sendToActiveTab({ action: "setVolume", volume: percent / 100, updatedAt: Date.now() });
    status.textContent = response?.ok
      ? `網站預設與目前分頁已設為 ${percent}%`
      : `預設已存為 ${percent}%；目前分頁尚未套用，請重新整理影片頁面`;
    await renderHistory();
  });

  slider.addEventListener("input", (event) => {
    updateFromControl(event.target.value);
  });

  input.addEventListener("input", (event) => {
    if (event.target.value === "") return;
    updateFromControl(event.target.value);
  });

  input.addEventListener("change", (event) => {
    updateFromControl(event.target.value);
  });

  historyList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-storage-key]");
    if (!button) return;

    const key = button.dataset.storageKey;
    await chrome.storage.local.remove(key);

    if (key === storageKeyFor(currentSiteKey)) {
      status.textContent = "已清除目前網站的記錄";
      await sendToActiveTab({ action: "clearSiteVolume" });
    }

    await renderHistory();
  });

  clearAllButton.addEventListener("click", async () => {
    const allValues = await chrome.storage.local.get(null);
    const keys = Object.keys(allValues).filter((key) => key.startsWith(STORAGE_PREFIX));
    if (keys.length === 0) return;

    if (!window.confirm(`確定要清除 ${keys.length} 個網站的音量記錄嗎？`)) return;

    await chrome.storage.local.remove(keys);
    status.textContent = "已清除全部網站記錄";
    await sendToActiveTab({ action: "clearSiteVolume" });
    await renderHistory();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (Object.keys(changes).some((key) => key.startsWith(STORAGE_PREFIX))) {
      renderHistory();
    }
  });

  async function initialize() {
    setSupported(false);
    await renderHistory();

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id || !activeTab.url) {
      currentSiteLabel.textContent = "無法取得目前分頁";
      currentSiteLabel.classList.add("unsupported");
      return;
    }

    let url;
    try {
      url = new URL(activeTab.url);
    } catch (_error) {
      currentSiteLabel.textContent = "此頁面不支援音量控制";
      currentSiteLabel.classList.add("unsupported");
      return;
    }

    if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname) {
      currentSiteLabel.textContent = "此頁面不支援音量控制";
      currentSiteLabel.classList.add("unsupported");
      return;
    }

    activeTabId = activeTab.id;
    currentSiteKey = url.hostname.toLowerCase();
    currentSiteLabel.textContent = currentSiteKey;
    setSupported(true);

    const key = storageKeyFor(currentSiteKey);
    const result = await chrome.storage.local.get([key, currentSiteKey]);
    let record = result[key];

    // 相容 v2/v3 直接以 hostname 當 key 的資料格式。
    if (!isVolumeRecord(record) && result[currentSiteKey] !== null && result[currentSiteKey] !== "" && Number.isFinite(Number(result[currentSiteKey]))) {
      const percent = Math.round(Number(result[currentSiteKey]) * 100);
      record = { hostname: currentSiteKey, volume: percent / 100, updatedAt: Date.now(), source: "migration" };
      await chrome.storage.local.set({
        [key]: record
      });
    }

    const state = await sendToActiveTab({ action: "getSiteState" });
    const controlledVolume = state?.savedVolume ?? state?.currentVolume;
    if (controlledVolume !== null && controlledVolume !== undefined && Number.isFinite(Number(controlledVolume))) {
      setControls(Math.round(Number(controlledVolume) * 100));
      status.textContent = "由擴充功能控制此分頁音量；影片滑桿不會覆蓋設定";
      return;
    }
    if (isVolumeRecord(record)) {
      const percent = Math.round(Number(record.volume) * 100);
      setControls(percent);
      status.textContent = `網站預設音量：${percent}%`;
      return;
    }
    status.textContent = "尚無網站預設；可先調整再設為預設值";
  }

  initialize().catch(() => {
    currentSiteLabel.textContent = "擴充功能初始化失敗";
    currentSiteLabel.classList.add("unsupported");
    status.textContent = "請重新載入擴充功能後再試一次";
    setSupported(false);
  });
})();
