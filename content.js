let topDomain = window.location.hostname;
if (window.location.ancestorOrigins && window.location.ancestorOrigins.length > 0) {
    topDomain = new URL(window.location.ancestorOrigins[0]).hostname;
}

let currentSavedVolume = null;
let guardTimers = new WeakMap();

// ==========================================
// 核心武裝：絕對音量壓制函數
// ==========================================
const applyVolume = (media) => {
    if (currentSavedVolume === null) return;
    if (media.volume !== currentSavedVolume) {
        media.volume = currentSavedVolume;
    }
};

// ==========================================
// 任務 1：網頁還沒長出來前，最快速度去提領記憶音量
// ==========================================
chrome.storage.local.get([topDomain], (result) => {
    if (!chrome.runtime?.id) return;
    if (result[topDomain] !== undefined) {
        currentSavedVolume = result[topDomain];
        // 拿到的瞬間，立刻對畫面上所有的播放器執行壓制
        document.querySelectorAll('video, audio').forEach(applyVolume);
    }
});

// ==========================================
// 任務 2：【第一道絕對防線】播放動作攔截網 (捕獲階段)
// ==========================================
// 這裡的 true 非常關鍵！它代表事件在「往下傳遞」時就被我們攔截。
// 在聲音真正播出來的前一微秒，強制把音量鎖在目標值。
document.addEventListener('play', (event) => {
    if (event.target.tagName === 'VIDEO' || event.target.tagName === 'AUDIO') {
        applyVolume(event.target);
        startGuardian(event.target); // 同時啟動 5 秒防覆寫守護
    }
}, true); 

// ==========================================
// 任務 3：【第二道絕對防線】DOM 元素誕生監視器
// ==========================================
// 只要網頁用 SPA 架構偷偷塞了一個新的 <audio> 標籤進來，瞬間抓獲！
const observer = new MutationObserver((mutations) => {
    mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
            if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
                applyVolume(node);
            } else if (node.querySelectorAll) {
                // 如果塞進來的是一個大區塊，尋找裡面有沒有播放器
                node.querySelectorAll('video, audio').forEach(applyVolume);
            }
        });
    });
});
// 監視整個網頁的風吹草動
observer.observe(document.documentElement, { childList: true, subtree: true });

// ==========================================
// 輔助機制：5 秒霸道守護期 (防網站自己的 JS 覆寫)
// ==========================================
function startGuardian(media) {
    if (currentSavedVolume === null) return;
    
    const currentSrc = media.currentSrc || media.src || "unknown_src";
    if (media.dataset.lastSrc !== currentSrc) {
        media.dataset.lastSrc = currentSrc;
        
        if (guardTimers.has(media)) {
            clearInterval(guardTimers.get(media));
        }
        
        let ticks = 0;
        const guardian = setInterval(() => {
            if (!chrome.runtime?.id) {
                clearInterval(guardian);
                return;
            }
            if (media.volume !== currentSavedVolume) {
                media.volume = currentSavedVolume;
            }
            ticks++;
            if (ticks >= 20) {  // 5 秒後解除高頻守護
                clearInterval(guardian);
            }
        }, 250);
        guardTimers.set(media, guardian);
    }
}

// ==========================================
// 任務 4：接收擴充功能 UI 滑桿遙控
// ==========================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateVolume") {
        currentSavedVolume = request.volume;
        document.querySelectorAll('video, audio').forEach(media => {
            media.volume = currentSavedVolume;
            media.dataset.lastSrc = media.currentSrc || media.src || "unknown_src";
        });
    }
});