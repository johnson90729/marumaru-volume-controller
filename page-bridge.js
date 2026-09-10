(() => {
  "use strict";

  const VOLUME_POLICY_EVENT = "marumaru-volume-control-v4:policy";
  const USER_VOLUME_CHANGE_EVENT = "marumaru-volume-control-v4:user-change";
  const USER_GESTURE_WINDOW_MS = 300;
  const VOLUME_EPSILON = 0.001;

  let lockedVolume = null;
  let allowUserVolumeUntil = Number.NEGATIVE_INFINITY;
  let volumePointerActive = false;

  function clampVolume(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.min(1, Math.max(0, number));
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

  function allowUserVolumeChange() {
    allowUserVolumeUntil = performance.now() + USER_GESTURE_WINDOW_MS;
  }

  document.addEventListener(VOLUME_POLICY_EVENT, (event) => {
    lockedVolume = event.detail === "" ? null : clampVolume(event.detail);
  }, true);

  document.addEventListener("pointerdown", (event) => {
    volumePointerActive = eventTargetsVolumeControl(event);
    if (volumePointerActive) allowUserVolumeChange();
  }, true);

  document.addEventListener("pointermove", () => {
    if (volumePointerActive) allowUserVolumeChange();
  }, true);

  ["pointerup", "pointercancel"].forEach((eventName) => {
    document.addEventListener(eventName, () => {
      if (volumePointerActive) allowUserVolumeChange();
      volumePointerActive = false;
    }, true);
  });

  document.addEventListener("keydown", (event) => {
    if (
      eventTargetsVolumeControl(event)
      || event.key === "ArrowUp"
      || event.key === "ArrowDown"
    ) {
      allowUserVolumeChange();
    }
  }, true);

  document.addEventListener("wheel", (event) => {
    if (eventTargetsVolumeControl(event)) allowUserVolumeChange();
  }, { capture: true, passive: true });

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

        const userIsAdjusting = performance.now() <= allowUserVolumeUntil;
        const volumeToApply = lockedVolume !== null && !userIsAdjusting
          ? lockedVolume
          : requested;

        const currentVolume = descriptor.get.call(this);
        if (Math.abs(currentVolume - volumeToApply) <= VOLUME_EPSILON) return;

        const result = descriptor.set.call(this, volumeToApply);
        if (userIsAdjusting) {
          const appliedVolume = descriptor.get.call(this);
          this.dispatchEvent(new CustomEvent(USER_VOLUME_CHANGE_EVENT, {
            bubbles: true,
            composed: true,
            detail: String(appliedVolume)
          }));
        }
        return result;
      }
    });
  } catch (_error) {
    // 若瀏覽器或網站禁止覆寫 prototype，隔離世界的保護邏輯仍會運作。
  }
})();
