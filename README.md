# marumaru-volume-controller
一個強行穿透網頁防護，自訂並記憶 Marumaru 與 YouTube 音量的 Chrome 擴充功能。
# Domain Volume Enforcer 🔊

A lightweight, highly aggressive Chrome extension designed to lock and remember custom volume settings for specific websites. 

Originally built to tame websites with unusually loud default audio, this extension successfully bypasses Single Page Application (SPA) volume resets, site-specific JavaScript overrides, and cross-origin iframe restrictions (e.g., embedded YouTube players).

## ✨ Key Features

* **Domain-Specific Memory**: Remembers your preferred volume (e.g., 5%) for specific domains and auto-applies it every time you visit.
* **The "Guardian" Mechanism**: Implements a high-frequency polling mechanism during the first 5 seconds of playback to forcibly block the website's native scripts from resetting the volume to 100%.
* **Zero-Delay Interception**: Uses `document_start` injection and capture-phase event listeners (`addEventListener('play', ..., true)`) to intercept and lower the volume *before* the first frame of audio is even rendered, eliminating sudden audio bleed/bursts.
* **SPA-Aware**: Intelligently tracks the `currentSrc` of media elements to detect song changes in Single Page Applications without relying on page reloads.

## 🚀 Installation (Developer Mode)

Since this extension requires powerful DOM manipulation, it is designed to be run locally:

1. Download or clone this repository to your local machine.
2. Open Google Chrome or Microsoft Edge and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the folder containing these files.
5. Pin the extension, visit a supported website, and use the popup UI to set your desired volume.

## 💡 Extensibility & Future Capabilities

This core architecture—specifically the ability to penetrate iframes and hijack native HTML5 `<video>` and `<audio>` tags—serves as a robust foundation for deep media manipulation. Developers can easily extend this project to achieve the following:

1. **Playback Speed Controller**:
   Modify `media.volume` to `media.playbackRate`. You can create an extension that forces unskippable videos to play at 16x speed, or perfectly sync custom speeds for educational platforms.
2. **Auto-Mute for Ads (Ad-Skipper)**:
   By analyzing the `src` URL or the duration of the media element, the extension can be modified to automatically mute the volume and fast-forward when an ad is detected, then restore the original volume for the main content.
3. **Global Keyboard Shortcuts**:
   By adding the `"commands"` API in `manifest.json`, you can map physical keyboard shortcuts (e.g., `Ctrl + Shift + Up`) to control the volume of background tabs without needing to click the extension popup.
4. **Audio Equalizer (EQ) & Bass Boost**:
   Instead of just changing the volume attribute, the injected script can route the media element's audio through the **Web Audio API** (`AudioContext`), allowing you to build a full-band equalizer or a volume booster that pushes audio beyond the 100% hardware limit.

---
*Disclaimer: This tool is built for personal productivity and UX enhancement.*
