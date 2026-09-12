(() => {
  "use strict";

  const POLICY_EVENT = "marumaru-volume-v5:policy";
  const QUERY_EVENT = "marumaru-volume-v5:query";
  const STATE_EVENT = "marumaru-volume-v5:state";
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
  if (!descriptor?.get || !descriptor?.set || !descriptor.configurable) return;

  let factor = 0; // Keep startup quiet until the site's saved factor is known.
  const records = new WeakMap();
  const references = new Set();
  const roots = new WeakSet();
  const validationMedia = document.createElement("audio");
  const cleanup = new FinalizationRegistry((reference) => references.delete(reference));

  function apply(media, record) {
    record.output = record.player * factor;
    if (descriptor.get.call(media) !== record.output) descriptor.set.call(media, record.output);
  }

  function readNativeChange(media, record) {
    const current = descriptor.get.call(media);
    if (current !== record.output) {
      // Browser controls and other isolated scripts bypass the page-world setter.
      record.player = current;
      record.touched = performance.now();
      apply(media, record);
    }
  }

  function track(media) {
    if (!(media instanceof HTMLMediaElement)) return null;
    let record = records.get(media);
    if (record) return record;
    record = { player: descriptor.get.call(media), output: descriptor.get.call(media), touched: 0 };
    records.set(media, record);
    const reference = new WeakRef(media);
    references.add(reference);
    cleanup.register(media, reference);
    media.addEventListener("volumechange", (event) => {
      const target = event.currentTarget;
      readNativeChange(target, records.get(target));
    }, true);
    for (const name of ["loadedmetadata", "play", "playing"]) {
      media.addEventListener(name, (event) => {
        const target = event.currentTarget;
        const state = records.get(target);
        readNativeChange(target, state);
        state.touched = performance.now();
        apply(target, state);
      }, true);
    }
    apply(media, record);
    return record;
  }

  function scan(root) {
    track(root);
    if (root.shadowRoot) observeRoot(root.shadowRoot);
    if (!root.querySelectorAll) return;
    for (const element of root.querySelectorAll("*")) {
      track(element);
      if (element.shadowRoot) observeRoot(element.shadowRoot);
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) scan(node);
  });
  function observeRoot(root) {
    if (roots.has(root)) return;
    roots.add(root);
    observer.observe(root, { childList: true, subtree: true });
    scan(root);
  }

  function eachMedia(callback) {
    for (const reference of references) {
      const media = reference.deref();
      if (media) callback(media, records.get(media));
      else references.delete(reference);
    }
  }

  document.addEventListener(POLICY_EVENT, (event) => {
    const next = Number(event.detail);
    if (event.detail === "" || !Number.isFinite(next) || next < 0 || next > 1) return;
    // Reconcile external writes under the old policy before changing the factor.
    eachMedia(readNativeChange);
    factor = next;
    eachMedia(apply);
  }, true);

  Object.defineProperty(HTMLMediaElement.prototype, "volume", {
    ...descriptor,
    get() {
      descriptor.get.call(this); // Preserve native receiver validation.
      const record = track(this);
      readNativeChange(this, record);
      return record.player;
    },
    set(value) {
      descriptor.get.call(this);
      // Let the browser perform WebIDL conversion and range validation exactly once.
      descriptor.set.call(validationMedia, value);
      const next = descriptor.get.call(validationMedia);
      const record = track(this);
      const changed = record.player !== next;
      const previousOutput = descriptor.get.call(this);
      record.player = next;
      record.touched = performance.now();
      apply(this, record);
      // At factor zero a logical change produces no native volumechange event.
      if (changed && previousOutput === record.output) {
        queueMicrotask(() => this.dispatchEvent(new Event("volumechange")));
      }
    }
  });

  function wrapMethod(prototype, name, wrapper) {
    const original = Object.getOwnPropertyDescriptor(prototype, name);
    if (original?.value && original.configurable) {
      Object.defineProperty(prototype, name, { ...original, value: wrapper(original.value) });
    }
  }
  wrapMethod(HTMLMediaElement.prototype, "play", (nativePlay) => function (...args) {
    const record = track(this);
    if (record) { readNativeChange(this, record); apply(this, record); }
    return Reflect.apply(nativePlay, this, args);
  });
  for (const name of ["createElement", "createElementNS"]) {
    wrapMethod(Document.prototype, name, (nativeMethod) => function (...args) {
      const element = Reflect.apply(nativeMethod, this, args);
      track(element);
      return element;
    });
  }
  wrapMethod(Element.prototype, "attachShadow", (nativeAttach) => function (...args) {
    const root = Reflect.apply(nativeAttach, this, args);
    if (root.mode === "open") observeRoot(root);
    return root;
  });
  window.Audio = new Proxy(window.Audio, {
    construct(target, args, newTarget) {
      const media = Reflect.construct(target, args, newTarget);
      track(media);
      return media;
    },
    apply(target, receiver, args) {
      const media = Reflect.apply(target, receiver, args);
      track(media);
      return media;
    }
  });

  document.addEventListener(QUERY_EVENT, () => {
    let selected = null;
    let count = 0;
    eachMedia((media, record) => {
      if (!media.isConnected && media.paused && !media.currentSrc) return;
      count++;
      readNativeChange(media, record);
      const playing = !media.paused && !media.ended;
      const score = (playing ? 4 : 0) + (!media.muted ? 2 : 0) + (media.isConnected ? 1 : 0);
      if (!selected || score > selected.score || (score === selected.score && record.touched > selected.touched)) {
        selected = { score, touched: record.touched, playerVolume: record.player,
          outputVolume: media.muted ? 0 : descriptor.get.call(media), muted: media.muted, playing };
      }
    });
    document.dispatchEvent(new CustomEvent(STATE_EVENT, {
      detail: JSON.stringify({ factor, mediaCount: count, media: selected })
    }));
  }, true);

  observeRoot(document);
})();
