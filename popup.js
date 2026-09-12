(() => {
  "use strict";
  const PREFIX = "siteGain:v5:";
  const slider = document.getElementById("factorSlider");
  const input = document.getElementById("factorInput");
  const status = document.getElementById("status");
  const history = document.getElementById("historyList");
  const reset = document.getElementById("resetSite");
  const clearAll = document.getElementById("clearAll");
  let tabId = null;
  let hostname = null;
  let generation = 0;
  let pending = 0;
  let polling = false;

  function percent(value) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 100;
  }
  function format(value) {
    return `${Math.round(value * 1000) / 10}%`;
  }
  function controls(gain) {
    slider.value = String(Math.round(gain * 100));
    input.value = slider.value;
    document.getElementById("factorReadout").textContent = format(gain);
    document.getElementById("zeroHint").hidden = gain !== 0;
  }
  function supported(value) {
    slider.disabled = !value;
    input.disabled = !value;
    reset.disabled = !value;
  }
  async function message(request) {
    try { return await chrome.runtime.sendMessage(request); } catch (_error) { return null; }
  }

  async function refresh() {
    if (tabId === null || polling) return;
    polling = true;
    const currentGeneration = generation;
    try {
      const state = await message({ action: "getGainTabState", tabId, hostname });
      if (!state?.ok) {
        document.getElementById("playbackState").textContent = "無法讀取目前狀態，請重新開啟面板";
        return;
      }
      if (pending === 0 && currentGeneration === generation && document.activeElement !== input && document.activeElement !== slider) {
        controls(state.factor);
      }
      const media = state.media;
      document.getElementById("playerReadout").textContent = media ? format(media.playerVolume) : "—";
      document.getElementById("outputReadout").textContent = media ? format(media.outputVolume) : "—";
      document.getElementById("playbackState").textContent = !state.connected
        ? "請重新整理影音頁面，讓新版開始控制音量"
        : !state.bridgeReady ? "此頁面未能啟用音量倍率，請重新整理"
        : state.initializationError ? "倍率讀取失敗，目前暫時靜音；請重新整理或再設定一次倍率"
        : state.initializing ? "正在讀取網站倍率，暫時靜音…"
        : !media ? "尚未偵測到播放器；播放後會顯示音量"
        : `${media.muted ? "播放器已靜音" : media.playing ? "正在播放" : "目前暫停"}${state.mediaCount > 1 ? " · 顯示其中一個播放器" : ""}`;
    } finally { polling = false; }
  }

  async function update(value) {
    const gain = percent(value) / 100;
    const current = ++generation;
    controls(gain);
    pending++;
    status.textContent = "正在記住網站倍率…";
    const result = await message({ action: "setSiteGain", hostname, gain });
    pending--;
    if (current !== generation) return;
    status.textContent = result?.ok
      ? `已記住 ${format(gain)}，同網站分頁皆適用`
      : "倍率儲存失敗，尚未確認套用；請重試";
    await refresh();
  }

  async function renderHistory() {
    const values = await chrome.storage.local.get(null);
    const records = Object.entries(values).filter(([key, value]) => key.startsWith(PREFIX)
      && typeof value?.gain === "number" && Number.isFinite(value.gain) && value.gain >= 0 && value.gain <= 1)
      .map(([key, value]) => ({ ...value, hostname: key.slice(PREFIX.length) }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    history.replaceChildren();
    clearAll.disabled = records.length === 0;
    if (records.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "尚未設定網站倍率";
      history.append(empty);
    }
    for (const record of records) {
      const row = document.createElement("div");
      row.className = "history-item";
      const name = document.createElement("div");
      name.className = "history-site";
      name.textContent = record.hostname;
      const gain = document.createElement("div");
      gain.className = "history-volume";
      gain.textContent = format(record.gain);
      const remove = document.createElement("button");
      remove.className = "delete-record";
      remove.dataset.hostname = record.hostname;
      remove.textContent = "×";
      remove.title = "刪除倍率，恢復原音量";
      remove.setAttribute("aria-label", `刪除 ${record.hostname} 的倍率`);
      row.append(name, gain, remove);
      history.append(row);
    }
  }

  async function removeSite(site) {
    ++generation;
    pending++;
    const result = await message({ action: "deleteSiteGain", hostname: site });
    pending--;
    status.textContent = result?.ok ? "網站倍率已移除，恢復 100%" : "刪除失敗，請重試";
    if (result?.ok && site === hostname) controls(1);
    await renderHistory();
    await refresh();
  }
  slider.addEventListener("input", (event) => update(event.target.value));
  input.addEventListener("input", (event) => { if (event.target.value !== "") update(event.target.value); });
  input.addEventListener("change", (event) => {
    const next = String(percent(event.target.value));
    if (next !== slider.value || event.target.value === "") update(next);
    else input.value = next;
  });
  reset.addEventListener("click", () => removeSite(hostname).catch(() => { status.textContent = "操作失敗，請重試"; }));
  history.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-hostname]");
    if (button) removeSite(button.dataset.hostname).catch(() => { status.textContent = "刪除失敗，請重試"; });
  });
  clearAll.addEventListener("click", async () => {
    if (!window.confirm("清除全部網站倍率，恢復各網站原音量？")) return;
    ++generation;
    const result = await message({ action: "clearSiteGains" });
    status.textContent = result?.ok ? "全部網站倍率已清除" : "清除失敗，請重試";
    if (result?.ok) controls(1);
    await renderHistory().catch(() => {});
    await refresh();
  });
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") renderHistory().catch(() => { status.textContent = "無法讀取網站倍率，請重新開啟面板"; });
  });

  async function initialize() {
    supported(false);
    await renderHistory();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ? new URL(tab.url) : null;
    if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname) {
      document.getElementById("currentSite").textContent = "此頁面不支援音量倍率";
      return;
    }
    tabId = tab.id;
    hostname = url.hostname.toLowerCase();
    document.getElementById("currentSite").textContent = hostname;
    const values = await chrome.storage.local.get(PREFIX + hostname);
    const gain = values[PREFIX + hostname]?.gain;
    controls(typeof gain === "number" && Number.isFinite(gain) && gain >= 0 && gain <= 1 ? gain : 1);
    supported(true);
    status.textContent = "調整倍率會自動保存；平常使用網頁音量滑桿即可";
    await refresh();
    const timer = setInterval(refresh, 500);
    window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  }
  initialize().catch(() => {
    status.textContent = "初始化失敗，請重新載入擴充功能";
    supported(false);
  });
})();
