(() => {
  "use strict";

  const VOLUME_POLICY_EVENT = "marumaru-volume-control-v4:policy";
  let lockedVolume = null;

  function clampVolume(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.min(1, Math.max(0, number));
  }

  document.addEventListener(VOLUME_POLICY_EVENT, (event) => {
    lockedVolume = event.detail === "" ? null : clampVolume(event.detail);
  }, true);

  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
  if (!descriptor?.get || !descriptor?.set || descriptor.configurable === false) return;

  try {
    Object.defineProperty(HTMLMediaElement.prototype, "volume", {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(requestedVolume) {
        const requested = clampVolume(requestedVolume);
        if (requested === null) {
          return descriptor.set.call(this, requestedVolume);
        }

        // Player sliders and keyboard shortcuts cannot override the extension.
        // The isolated-world script can still apply a new popup setting.
        const volumeToApply = lockedVolume ?? requested;
        if (descriptor.get.call(this) === volumeToApply) return;
        return descriptor.set.call(this, volumeToApply);
      }
    });
  } catch (_error) {
    // 若瀏覽器或網站禁止覆寫 prototype，隔離世界的保護邏輯仍會運作。
  }
})();
