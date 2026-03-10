document.addEventListener('DOMContentLoaded', () => {
    const slider = document.getElementById('volumeSlider');
    const input = document.getElementById('volumeInput');
    const domainLabel = document.getElementById('domainLabel');

    // 1. 取得目前活躍分頁的網域
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        const currentTab = tabs[0];
        const url = new URL(currentTab.url);
        const domain = url.hostname;

        domainLabel.textContent = `目前網域：${domain}`;

        // 2. 從擴充功能專屬資料庫，讀取這個網域的記憶音量
        chrome.storage.local.get([domain], (result) => {
            let savedVolume = result[domain];
            if (savedVolume !== undefined) {
                // 將 0.05 轉換回 5 顯示在介面上
                const percent = Math.round(savedVolume * 100);
                slider.value = percent;
                input.value = percent;
            }
        });

        // 3. 定義「當你調整音量時」要觸發的連動動作
        const syncAndUpdateVolume = (percentValue) => {
            // 確保數值不會超過 0~100 的合理範圍
            let percent = parseInt(percentValue);
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;

            // 讓滑桿和輸入框的數字保持同步
            slider.value = percent;
            input.value = percent;

            // 轉換為系統底層需要的 0.0 ~ 1.0 真實音量
            const realVolume = percent / 100;

            // 將新音量存入資料庫 (以網域為鑰匙)
            let data = {};
            data[domain] = realVolume;
            chrome.storage.local.set(data);

            // 直接發送廣播給網頁底層的 content.js，命令它立刻改變音量
            chrome.tabs.sendMessage(currentTab.id, {
                action: "updateVolume", 
                volume: realVolume
            }).catch(() => {
                // 防止在不支援的系統頁面 (如擴充功能管理頁) 報錯
            });
        };

        // 4. 綁定監聽器：只要滑桿被拖曳，或輸入框數字改變，就立刻觸發更新
        slider.addEventListener('input', (e) => syncAndUpdateVolume(e.target.value));
        input.addEventListener('change', (e) => syncAndUpdateVolume(e.target.value));
    });
});
