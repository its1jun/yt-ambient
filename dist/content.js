(() => {
  // src/config.js
  var CONFIG = Object.freeze({
    blurPx: 20,
    // 흐림 정도 (CSS px)
    saturate: 1,
    // 채도 배율 (1 = 원본)
    maxFps: 15,
    // 초당 그리기 상한 (0 이하면 제한 없음)
    layerGapPx: 64,
    // 층 하나가 사방으로 넓어지는 폭 (CSS px). 계단 한 칸의 실제 폭. 작을수록 층이 늘어 비용 증가 (권장 24~64)
    captureLongSide: 128,
    // 영상 샘플링 canvas의 긴 변 (px)
    canvasLongSide: 256,
    // 앰비언트 canvas 내부 해상도의 긴 변 (px)
    drmErrorLimit: 3,
    // drawImage가 연속으로 실패해도 허용하는 횟수 (넘으면 그 영상은 중단)
    retry: {
      maxAttempts: 10,
      // 요소를 못 찾았을 때 재시도 최대 횟수
      intervalMs: 300
      // 재시도 간격 (ms)
    },
    wrapperId: "ambient-light-wrapper",
    // 앰비언트를 담는 div의 id
    rootAttr: "data-yt-ambient",
    // <html>에 붙이는 속성 이름 (값 'on' 또는 속성 없음)
    debug: false,
    // true면 콘솔에 상태 변화를 출력
    // 앰비언트 실행을 허용할 화면 모드 
    // ['default','theater','fullscreen']
    enabledModes: ["theater"]
  });

  // src/yt/selectors.js
  var SEL = Object.freeze({
    mountParent: "#content.ytd-app",
    // 앰비언트 div를 넣을 부모
    watchRoot: "ytd-watch-flexy, ytd-watch-fixie, ytd-watch-grid",
    // 시청 화면 최상위 요소
    // Uncertain: 실제 존재 여부는 VERIFICATION.md의 V5로 확인 필요.
    // 없으면 watchRoot 안의 '.html5-video-player'로 바꾼다.
    player: "#movie_player",
    video: "video.html5-main-video",
    // 실제 영상 요소
    modeAttrs: ["theater", "full-bleed-player"],
    // watchRoot의 극장 모드 판단 속성
    watchPath: "/watch"
    // 앰비언트를 적용할 주소 경로
  });

  // src/core/store.js
  var DEFAULT_STATE = Object.freeze({
    isWatchPage: false,
    mode: "default",
    // 'default' | 'theater' | 'fullscreen'
    mountParent: null,
    player: null,
    video: null,
    tabVisible: true
  });
  function deriveRunState(state) {
    if (!state.isWatchPage || !state.mountParent || !state.player || !state.video) return "IDLE";
    const isAllowedMode = CONFIG.enabledModes.includes(state.mode);
    if (!isAllowedMode || !state.tabVisible) return "ARMED";
    return "RUNNING";
  }
  function createStore(initial) {
    let state = Object.freeze({ ...DEFAULT_STATE, ...initial });
    const listeners = /* @__PURE__ */ new Set();
    function get() {
      return state;
    }
    function set(partial) {
      if (!partial) return;
      const changed = {};
      let hasChange = false;
      for (const key of Object.keys(partial)) {
        if (!Object.is(state[key], partial[key])) {
          changed[key] = partial[key];
          hasChange = true;
        }
      }
      if (!hasChange) return;
      state = Object.freeze({ ...state, ...changed });
      for (const fn of [...listeners]) {
        if (listeners.has(fn)) fn(state);
      }
    }
    function subscribe(fn) {
      if (typeof fn !== "function") throw new TypeError("subscribe\uC5D0\uB294 \uD568\uC218\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4");
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    }
    return { get, set, subscribe };
  }

  // src/core/layout.js
  var EPSILON = 0.01;
  var MAX_LAYER_COUNT = 40;
  var INVALID_LAYOUT = Object.freeze({
    valid: false,
    wrapperBox: null,
    canvasBox: null,
    canvasPx: null,
    captureSize: null,
    feather: null,
    draws: Object.freeze([])
  });
  function isPositiveNumber(value) {
    return Number.isFinite(value) && value > 0;
  }
  function isSizedRect(rect) {
    return !!rect && Number.isFinite(rect.left) && Number.isFinite(rect.top) && isPositiveNumber(rect.width) && isPositiveNumber(rect.height);
  }
  function isPositionedRect(rect) {
    return !!rect && Number.isFinite(rect.left) && Number.isFinite(rect.top);
  }
  function computeCaptureSize(videoWidth, videoHeight, longSide) {
    const aspect = videoWidth / videoHeight;
    const width = aspect > 1 ? longSide : Math.round(longSide * aspect);
    const height = aspect > 1 ? Math.round(longSide / aspect) : longSide;
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }
  function computeFarthestGap(playerRect, videoRect) {
    return Math.max(
      videoRect.left - playerRect.left,
      playerRect.left + playerRect.width - (videoRect.left + videoRect.width),
      videoRect.top - playerRect.top,
      playerRect.top + playerRect.height - (videoRect.top + videoRect.height)
    );
  }
  function computeLayerCount(playerRect, videoRect, layerGapPx) {
    const needed = Math.ceil(computeFarthestGap(playerRect, videoRect) / layerGapPx - 1e-4);
    return Math.min(MAX_LAYER_COUNT, Math.max(1, needed) + 1);
  }
  function computeFeather(videoRect, layerGapPx) {
    if (!isPositiveNumber(layerGapPx)) return { x: 0, y: 0 };
    return {
      x: Math.min(0.5, layerGapPx / videoRect.width),
      y: Math.min(0.5, layerGapPx / videoRect.height)
    };
  }
  function computeLayout({ playerRect, videoRect, parentRect, config }) {
    const { layerGapPx, captureLongSide, canvasLongSide } = config || {};
    if (!isSizedRect(playerRect) || !isSizedRect(videoRect) || !isPositionedRect(parentRect)) {
      return INVALID_LAYOUT;
    }
    if (!isPositiveNumber(layerGapPx) || !isPositiveNumber(captureLongSide) || !isPositiveNumber(canvasLongSide)) {
      return INVALID_LAYOUT;
    }
    const wrapperBox = {
      left: playerRect.left - parentRect.left,
      top: playerRect.top - parentRect.top,
      width: playerRect.width,
      height: playerRect.height
    };
    const videoLeft = videoRect.left - playerRect.left;
    const videoTop = videoRect.top - playerRect.top;
    const count = computeLayerCount(playerRect, videoRect, layerGapPx);
    const layerBoxes = [];
    for (let i = count; i >= 1; i -= 1) {
      const grow = layerGapPx * i;
      layerBoxes.push({
        left: videoLeft - grow,
        top: videoTop - grow,
        width: videoRect.width + grow * 2,
        height: videoRect.height + grow * 2
      });
    }
    const biggest = layerBoxes[0];
    const boxLeft = Math.min(0, biggest.left);
    const boxTop = Math.min(0, biggest.top);
    const boxRight = Math.max(playerRect.width, biggest.left + biggest.width);
    const boxBottom = Math.max(playerRect.height, biggest.top + biggest.height);
    const canvasBox = {
      left: boxLeft,
      top: boxTop,
      width: boxRight - boxLeft,
      height: boxBottom - boxTop
    };
    const pxPerCss = canvasLongSide / Math.max(canvasBox.width, canvasBox.height);
    const canvasPx = {
      width: Math.max(1, Math.round(canvasBox.width * pxPerCss)),
      height: Math.max(1, Math.round(canvasBox.height * pxPerCss))
    };
    const scaleX = canvasPx.width / canvasBox.width;
    const scaleY = canvasPx.height / canvasBox.height;
    const draws = layerBoxes.map((box) => ({
      dx: (box.left - canvasBox.left) * scaleX,
      dy: (box.top - canvasBox.top) * scaleY,
      dw: box.width * scaleX,
      dh: box.height * scaleY
    }));
    return {
      valid: true,
      wrapperBox,
      canvasBox,
      canvasPx,
      captureSize: computeCaptureSize(videoRect.width, videoRect.height, captureLongSide),
      feather: computeFeather(videoRect, layerGapPx),
      draws
    };
  }
  function near(a, b) {
    return Math.abs(a - b) <= EPSILON;
  }
  function rectEquals(a, b) {
    return near(a.left, b.left) && near(a.top, b.top) && near(a.width, b.width) && near(a.height, b.height);
  }
  function sizeEquals(a, b) {
    return near(a.width, b.width) && near(a.height, b.height);
  }
  function featherEquals(a, b) {
    return Math.abs(a.x - b.x) <= 1e-4 && Math.abs(a.y - b.y) <= 1e-4;
  }
  function layoutEquals(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.valid !== b.valid) return false;
    if (!a.valid) return true;
    if (!rectEquals(a.wrapperBox, b.wrapperBox)) return false;
    if (!rectEquals(a.canvasBox, b.canvasBox)) return false;
    if (!sizeEquals(a.canvasPx, b.canvasPx)) return false;
    if (!sizeEquals(a.captureSize, b.captureSize)) return false;
    if (!featherEquals(a.feather, b.feather)) return false;
    if (a.draws.length !== b.draws.length) return false;
    return a.draws.every((d, i) => near(d.dx, b.draws[i].dx) && near(d.dy, b.draws[i].dy) && near(d.dw, b.draws[i].dw) && near(d.dh, b.draws[i].dh));
  }

  // src/core/controller.js
  function emptyApplied() {
    return { state: "IDLE", player: null, video: null, parent: null };
  }
  function createController({ adapter, store, mount, renderer, config, computeLayout: computeLayout2, env = {} }) {
    const doc = env.doc || document;
    const raf = env.requestAnimationFrame || ((cb) => requestAnimationFrame(cb));
    const caf = env.cancelAnimationFrame || ((id) => cancelAnimationFrame(id));
    const ResizeObserverImpl = env.ResizeObserver || (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
    let started = false;
    let applied = emptyApplied();
    let bound = { video: null, canvas: null };
    let resizeObserver = null;
    let rafId = null;
    let lastLayout = null;
    let unsubscribe = null;
    let abort = null;
    function cancelRelayout() {
      if (rafId !== null) caf(rafId);
      rafId = null;
    }
    function disconnectObserver() {
      if (resizeObserver) resizeObserver.disconnect();
    }
    function relayout() {
      rafId = null;
      if (applied.state !== "RUNNING") return;
      const playerRect = applied.player.getBoundingClientRect();
      const videoRect = applied.video.getBoundingClientRect();
      const parentRect = applied.parent.getBoundingClientRect();
      const next = computeLayout2({ playerRect, videoRect, parentRect, config });
      if (lastLayout && layoutEquals(lastLayout, next)) return;
      lastLayout = next;
      mount.applyLayout(next);
      renderer.setLayout(next);
    }
    function scheduleRelayout() {
      if (rafId !== null) return;
      rafId = raf(relayout);
    }
    function observeElements(player, video) {
      if (!ResizeObserverImpl) return;
      if (!resizeObserver) resizeObserver = new ResizeObserverImpl(scheduleRelayout);
      resizeObserver.disconnect();
      resizeObserver.observe(player);
      resizeObserver.observe(video);
    }
    function leaveRunning() {
      renderer.stop();
      disconnectObserver();
      cancelRelayout();
      mount.setRootAttr(false);
    }
    function enterIdle() {
      if (applied.state === "RUNNING") leaveRunning();
      renderer.detach();
      bound = { video: null, canvas: null };
      mount.unmount();
      lastLayout = null;
      applied = emptyApplied();
    }
    function enterArmed(s) {
      if (applied.state === "RUNNING") leaveRunning();
      mount.setVisible(false);
      applied = { state: "ARMED", player: s.player, video: s.video, parent: s.mountParent };
    }
    function enterRunning(s) {
      const parentChanged = applied.parent !== s.mountParent;
      const { canvas } = mount.mount(s.mountParent);
      mount.setRootAttr(true);
      mount.setVisible(true);
      if (bound.video !== s.video || bound.canvas !== canvas) {
        renderer.attach(s.video, canvas);
        bound = { video: s.video, canvas };
      }
      applied = { state: "RUNNING", player: s.player, video: s.video, parent: s.mountParent };
      if (parentChanged) lastLayout = null;
      observeElements(s.player, s.video);
      cancelRelayout();
      relayout();
      renderer.start();
    }
    function reconcile() {
      if (!started) return;
      const s = store.get();
      const next = deriveRunState(s);
      if (next === "IDLE") {
        if (applied.state !== "IDLE") enterIdle();
        return;
      }
      const same = applied.state === next && applied.player === s.player && applied.video === s.video && applied.parent === s.mountParent;
      if (same) return;
      if (next === "ARMED") enterArmed(s);
      else enterRunning(s);
    }
    function onVisibilityChange() {
      store.set({ tabVisible: !doc.hidden });
    }
    function start() {
      if (started) return;
      started = true;
      abort = new AbortController();
      unsubscribe = store.subscribe(reconcile);
      doc.addEventListener("visibilitychange", onVisibilityChange, { signal: abort.signal });
      store.set({ tabVisible: !doc.hidden });
      adapter.start();
      reconcile();
    }
    function stop() {
      if (!started) return;
      adapter.stop();
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (abort) abort.abort();
      abort = null;
      enterIdle();
      renderer.destroy();
      mount.setRootAttr(false);
      resizeObserver = null;
      started = false;
    }
    return { start, stop };
  }

  // src/yt/adapter.js
  var INITIAL_FACTS = Object.freeze({
    isWatchPage: false,
    mode: "default",
    mountParent: null,
    player: null,
    video: null
  });
  var FACT_KEYS = ["isWatchPage", "mode", "mountParent", "player", "video"];
  function readMode({ fullscreenElement, watchRoot, modeAttrs }) {
    if (fullscreenElement) return "fullscreen";
    if (watchRoot && modeAttrs.some((attr) => watchRoot.hasAttribute(attr))) return "theater";
    return "default";
  }
  function readFacts({ doc, pathname, selectors }) {
    if (pathname !== selectors.watchPath) return INITIAL_FACTS;
    const watchRoot = doc.querySelector(selectors.watchRoot);
    return {
      isWatchPage: true,
      mode: readMode({
        fullscreenElement: doc.fullscreenElement,
        watchRoot,
        modeAttrs: selectors.modeAttrs
      }),
      mountParent: doc.querySelector(selectors.mountParent),
      player: watchRoot ? watchRoot.querySelector(selectors.player) : null,
      video: watchRoot ? watchRoot.querySelector(selectors.video) : null
    };
  }
  function factsEqual(a, b) {
    return FACT_KEYS.every((key) => Object.is(a[key], b[key]));
  }
  function hasAllElements(facts) {
    return !!(facts.mountParent && facts.player && facts.video);
  }
  function createAdapter({ onChange, config, selectors, env = {} }) {
    let doc = null;
    let getPathname = null;
    let MutationObserverImpl = null;
    let abortController = null;
    let observer = null;
    let observedRoot = null;
    let retryTimer = null;
    let retryCount = 0;
    let facts = INITIAL_FACTS;
    function clearRetry() {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    }
    function scheduleRetry(next) {
      if (!next.isWatchPage || hasAllElements(next)) {
        clearRetry();
        retryCount = 0;
        return;
      }
      if (retryTimer !== null || retryCount >= config.retry.maxAttempts) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        retryCount += 1;
        refresh();
      }, config.retry.intervalMs);
    }
    function syncObserver() {
      const root = doc.querySelector(selectors.watchRoot);
      if (root === observedRoot) return;
      if (observer) observer.disconnect();
      observedRoot = root;
      if (!root) return;
      if (!observer) observer = new MutationObserverImpl(refresh);
      observer.observe(root, { attributes: true, attributeFilter: [...selectors.modeAttrs] });
    }
    function refresh() {
      if (abortController === null) return;
      const next = readFacts({ doc, pathname: getPathname(), selectors });
      if (!factsEqual(facts, next)) {
        facts = next;
        if (config.debug) console.debug("[yt-ambient]", facts);
        onChange(facts);
      }
      syncObserver();
      scheduleRetry(next);
    }
    function handleNavigate() {
      clearRetry();
      retryCount = 0;
      refresh();
    }
    function start() {
      if (abortController !== null) return;
      doc = env.doc ?? globalThis.document;
      getPathname = env.getPathname ?? (() => globalThis.location.pathname);
      MutationObserverImpl = env.MutationObserver ?? globalThis.MutationObserver;
      abortController = new AbortController();
      const { signal } = abortController;
      doc.addEventListener("yt-navigate-finish", handleNavigate, { signal });
      doc.addEventListener("fullscreenchange", refresh, { signal });
      refresh();
    }
    function stop() {
      if (abortController === null) return;
      abortController.abort();
      abortController = null;
      if (observer) observer.disconnect();
      observer = null;
      observedRoot = null;
      clearRetry();
      retryCount = 0;
      facts = INITIAL_FACTS;
    }
    function getFacts() {
      return facts;
    }
    return { start, stop, getFacts };
  }

  // src/dom/mount.js
  function px(value) {
    return `${value}px`;
  }
  function createMount({ config, env = {} }) {
    const doc = env.doc || document;
    let wrapper = null;
    let canvas = null;
    let applied = {};
    function setStyle(el, cacheKey, prop, value) {
      if (applied[cacheKey] === value) return;
      el.style[prop] = value;
      applied[cacheKey] = value;
    }
    function removeStaleWrapper() {
      const found = doc.getElementById(config.wrapperId);
      if (found && found !== wrapper) found.remove();
    }
    function create() {
      applied = {};
      wrapper = doc.createElement("div");
      wrapper.id = config.wrapperId;
      wrapper.setAttribute("aria-hidden", "true");
      wrapper.style.pointerEvents = "none";
      wrapper.style.zIndex = "-1";
      wrapper.style.setProperty("--ambient-blur", px(config.blurPx));
      wrapper.style.setProperty("--ambient-saturate", String(config.saturate));
      setStyle(wrapper, "display", "display", "none");
      canvas = doc.createElement("canvas");
      canvas.style.position = "absolute";
      canvas.style.display = "block";
      wrapper.appendChild(canvas);
    }
    function mount(parent) {
      removeStaleWrapper();
      if (!wrapper) create();
      if (wrapper.parentNode !== parent) parent.prepend(wrapper);
      return { wrapper, canvas };
    }
    function applyLayout(layout) {
      if (!wrapper || !canvas || !layout || !layout.valid) return;
      const { wrapperBox, canvasBox } = layout;
      setStyle(wrapper, "wLeft", "left", px(wrapperBox.left));
      setStyle(wrapper, "wTop", "top", px(wrapperBox.top));
      setStyle(wrapper, "wWidth", "width", px(wrapperBox.width));
      setStyle(wrapper, "wHeight", "height", px(wrapperBox.height));
      setStyle(canvas, "cLeft", "left", px(canvasBox.left));
      setStyle(canvas, "cTop", "top", px(canvasBox.top));
      setStyle(canvas, "cWidth", "width", px(canvasBox.width));
      setStyle(canvas, "cHeight", "height", px(canvasBox.height));
    }
    function setVisible(visible) {
      if (!wrapper) return;
      setStyle(wrapper, "display", "display", visible ? "" : "none");
    }
    function setRootAttr(on) {
      const root = doc.documentElement;
      if (on) root.setAttribute(config.rootAttr, "on");
      else root.removeAttribute(config.rootAttr);
    }
    function unmount() {
      if (wrapper) wrapper.remove();
      wrapper = null;
      canvas = null;
      applied = {};
    }
    function getCanvas() {
      return canvas;
    }
    return { mount, applyLayout, setVisible, setRootAttr, unmount, getCanvas };
  }

  // src/render/renderer.js
  var FRAME_SLACK_MS = 2;
  function shouldDrawFrame(nowMs, lastDrawMs, maxFps) {
    if (!Number.isFinite(maxFps) || maxFps <= 0) return true;
    if (!Number.isFinite(lastDrawMs) || lastDrawMs <= 0) return true;
    return nowMs - lastDrawMs >= 1e3 / maxFps - FRAME_SLACK_MS;
  }
  function createRenderer({ config, env = {} }) {
    const createCanvas = env.createCanvas || (() => document.createElement("canvas"));
    const now = env.now || (() => performance.now());
    const logger = env.logger || console;
    let video = null;
    let canvas = null;
    let ctx = null;
    let captureCanvas = null;
    let captureCtx = null;
    let layout = null;
    let featherH = null;
    let featherV = null;
    let featherKey = "";
    let running = false;
    let halted = false;
    let frameHandle = null;
    let mediaAbort = null;
    let errorCount = 0;
    let lastDrawMs = 0;
    let warnedNoRvfc = false;
    function applySizes() {
      if (!layout || !layout.valid) return false;
      let changed = false;
      const { captureSize, canvasPx } = layout;
      if (captureCanvas && (captureCanvas.width !== captureSize.width || captureCanvas.height !== captureSize.height)) {
        captureCanvas.width = captureSize.width;
        captureCanvas.height = captureSize.height;
        changed = true;
      }
      if (canvas && (canvas.width !== canvasPx.width || canvas.height !== canvasPx.height)) {
        canvas.width = canvasPx.width;
        canvas.height = canvasPx.height;
        changed = true;
      }
      return changed;
    }
    function cancelFrame() {
      if (frameHandle !== null && video) video.cancelVideoFrameCallback(frameHandle);
      frameHandle = null;
    }
    function handleDrawError(error) {
      errorCount += 1;
      if (errorCount < Math.max(1, config.drmErrorLimit || 1)) return;
      halted = true;
      stop();
      logger.debug("[yt-ambient] drawImage\uAC00 \uC5F0\uC18D \uC2E4\uD328\uD574 \uB80C\uB354\uB9C1\uC744 \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.", error);
    }
    function buildFeatherGradient(gradient, feather) {
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(feather, "rgba(0,0,0,1)");
      gradient.addColorStop(1 - feather, "rgba(0,0,0,1)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      return gradient;
    }
    function applyFeather() {
      const { width, height } = captureCanvas;
      const featherX = Math.min(0.5, Number(layout.feather && layout.feather.x) || 0);
      const featherY = Math.min(0.5, Number(layout.feather && layout.feather.y) || 0);
      if (featherX <= 0 && featherY <= 0) return;
      const key = `${width}x${height}x${featherX}x${featherY}`;
      if (key !== featherKey) {
        featherKey = key;
        featherH = featherX > 0 ? buildFeatherGradient(captureCtx.createLinearGradient(0, 0, width, 0), featherX) : null;
        featherV = featherY > 0 ? buildFeatherGradient(captureCtx.createLinearGradient(0, 0, 0, height), featherY) : null;
      }
      captureCtx.globalCompositeOperation = "destination-in";
      if (featherH) {
        captureCtx.fillStyle = featherH;
        captureCtx.fillRect(0, 0, width, height);
      }
      if (featherV) {
        captureCtx.fillStyle = featherV;
        captureCtx.fillRect(0, 0, width, height);
      }
      captureCtx.globalCompositeOperation = "source-over";
    }
    function drawFrame(stamp) {
      if (!video || !canvas || !ctx || !captureCtx || halted) return;
      if (!layout || !layout.valid) return;
      try {
        captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
        applyFeather();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const d of layout.draws) {
          ctx.drawImage(captureCanvas, d.dx, d.dy, d.dw, d.dh);
        }
        errorCount = 0;
        lastDrawMs = stamp;
      } catch (error) {
        handleDrawError(error);
      }
    }
    function scheduleFrame() {
      if (frameHandle !== null || !running || halted || !video || video.paused) return;
      frameHandle = video.requestVideoFrameCallback(onFrame);
    }
    function onFrame(frameNow) {
      frameHandle = null;
      if (!running || halted) return;
      scheduleFrame();
      if (shouldDrawFrame(frameNow, lastDrawMs, config.maxFps)) drawFrame(frameNow);
    }
    function onPlay() {
      scheduleFrame();
    }
    function onPause() {
      cancelFrame();
    }
    function onSeeked() {
      if (video && video.paused) drawFrame(now());
    }
    function attach(nextVideo, nextCanvas) {
      detach();
      video = nextVideo;
      canvas = nextCanvas;
      ctx = canvas.getContext("2d", { alpha: false });
      if (!captureCanvas) {
        captureCanvas = createCanvas();
        captureCtx = captureCanvas.getContext("2d");
      }
      halted = false;
      errorCount = 0;
      lastDrawMs = 0;
      applySizes();
    }
    function setLayout(nextLayout) {
      layout = nextLayout || null;
      applySizes();
      if (running) drawFrame(now());
    }
    function start() {
      if (running || halted || !video || !canvas) return;
      if (typeof video.requestVideoFrameCallback !== "function") {
        if (!warnedNoRvfc) {
          warnedNoRvfc = true;
          logger.warn("[yt-ambient] \uC774 \uBE0C\uB77C\uC6B0\uC800\uB294 requestVideoFrameCallback\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC544 \uB3D9\uC791\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
        }
        return;
      }
      running = true;
      mediaAbort = new AbortController();
      const options = { signal: mediaAbort.signal };
      video.addEventListener("play", onPlay, options);
      video.addEventListener("pause", onPause, options);
      video.addEventListener("seeked", onSeeked, options);
      drawFrame(now());
      scheduleFrame();
    }
    function stop() {
      if (mediaAbort) {
        mediaAbort.abort();
        mediaAbort = null;
      }
      cancelFrame();
      running = false;
    }
    function detach() {
      stop();
      video = null;
      canvas = null;
      ctx = null;
    }
    function destroy() {
      detach();
      captureCanvas = null;
      captureCtx = null;
      layout = null;
    }
    return { attach, setLayout, start, stop, detach, destroy };
  }

  // src/main.js
  function boot() {
    if (window.__ytAmbientBooted) return;
    window.__ytAmbientBooted = true;
    const store = createStore();
    const adapter = createAdapter({
      onChange: (facts) => store.set(facts),
      config: CONFIG,
      selectors: SEL
    });
    const mount = createMount({ config: CONFIG });
    const renderer = createRenderer({ config: CONFIG });
    const controller = createController({
      adapter,
      store,
      mount,
      renderer,
      config: CONFIG,
      computeLayout
    });
    controller.start();
  }
  boot();
})();
