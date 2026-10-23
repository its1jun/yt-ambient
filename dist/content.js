(() => {
  // src/config.js
  var CONFIG = Object.freeze({
    blurPx: 20,
    // 흐림 정도 (CSS px)
    saturate: 1,
    // 채도 배율 (1 = 원본)
    maxFps: 15,
    // 초당 그리기 상한 (0 이하면 제한 없음)
    layerGapPx: 32,
    // 층 하나가 사방으로 넓어지는 폭 (CSS px). 계단 한 칸의 실제 폭. 작을수록 층이 늘어 비용 증가 (권장 24~64)
    captureLongSide: 192,
    // 영상 샘플링 canvas의 긴 변 (px)
    canvasLongSide: 288,
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
    // 영상 속 검은 띠(레터박스) 검출/제거. 영상마다 처음에 몇 번 측정해 확정하고, 이후에는 다시 측정하지 않는다
    bars: {
      enabled: true,
      // false면 검출과 제거를 모두 끈다
      blackSumMax: 16,
      // 검은색으로 보는 R+G+B 합의 상한 (0~765)
      blackChannelDiffMax: 3,
      // 검은색으로 보는 R/G/B 채널 사이 차이의 상한 (0~255)
      maxBarPercent: 38,
      // 영상 높이 대비 한쪽 띠 크기의 상한 (%). 넘으면 오검출로 보고 그 측정은 버린다
      minBarPercent: 1,
      // 이보다 작은 띠는 없는 것(0)으로 본다 (%)
      edgeMarginRows: 1,
      // 경계 선이 남지 않도록 띠보다 더 자르는 행 수 (측정 이미지 기준)
      scanColumns: 5,
      // 측정에 쓰는 세로 스캔라인 개수 (가로로 고르게 배치)
      stripHeight: 360,
      // 측정 이미지의 세로 해상도 상한 (px)
      measureIntervalMs: 300,
      // 측정 간격 (ms)
      stableCount: 3,
      // 같은 값이 연속 몇 번 나오면 확정할지
      stableTolerance: 0.5,
      // 같은 값으로 볼 오차 (%p)
      clipVar: "--ambient-clip-inset"
      // <html>에 넣는 CSS 변수 이름 (styles/ambient.css의 이름과 같아야 한다)
    },
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
  var MAX_BAR_PERCENT = 49;
  var INVALID_LAYOUT = Object.freeze({
    valid: false,
    wrapperBox: null,
    canvasBox: null,
    canvasPx: null,
    captureSize: null,
    feather: null,
    crop: null,
    bars: null,
    draws: Object.freeze([])
  });
  function normalizeBarPercent(value) {
    return Number.isFinite(value) && value > 0 ? Math.min(MAX_BAR_PERCENT, value) : 0;
  }
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
  function computeLayout({ playerRect, videoRect, parentRect, bars, config }) {
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
    const barX = normalizeBarPercent(bars && bars.x);
    const barY = normalizeBarPercent(bars && bars.y);
    const contentRect = {
      left: videoRect.left + videoRect.width * (barX / 100),
      top: videoRect.top + videoRect.height * (barY / 100),
      width: videoRect.width * (1 - barX / 100 * 2),
      height: videoRect.height * (1 - barY / 100 * 2)
    };
    if (!isSizedRect(contentRect)) return INVALID_LAYOUT;
    const videoLeft = contentRect.left - playerRect.left;
    const videoTop = contentRect.top - playerRect.top;
    const count = computeLayerCount(playerRect, contentRect, layerGapPx);
    const layerBoxes = [];
    for (let i = count; i >= 1; i -= 1) {
      const grow = layerGapPx * i;
      layerBoxes.push({
        left: videoLeft - grow,
        top: videoTop - grow,
        width: contentRect.width + grow * 2,
        height: contentRect.height + grow * 2
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
    const captureSize = computeCaptureSize(videoRect.width, videoRect.height, captureLongSide);
    const crop = {
      sx: captureSize.width * (barX / 100),
      sy: captureSize.height * (barY / 100),
      sw: captureSize.width * (1 - barX / 100 * 2),
      sh: captureSize.height * (1 - barY / 100 * 2)
    };
    return {
      valid: true,
      wrapperBox,
      canvasBox,
      canvasPx,
      captureSize,
      feather: computeFeather(contentRect, layerGapPx),
      crop,
      bars: { x: barX, y: barY },
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
  function cropEquals(a, b) {
    return near(a.sx, b.sx) && near(a.sy, b.sy) && near(a.sw, b.sw) && near(a.sh, b.sh);
  }
  function barsEquals(a, b) {
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
    if (!cropEquals(a.crop, b.crop)) return false;
    if (!barsEquals(a.bars, b.bars)) return false;
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
    let bars = { x: 0, y: 0 };
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
      const next = computeLayout2({ playerRect, videoRect, parentRect, bars, config });
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
    function handleBars(next) {
      const x = Number(next && next.x) || 0;
      const y = Number(next && next.y) || 0;
      if (bars.x === x && bars.y === y) return;
      bars = { x, y };
      if (applied.state === "RUNNING") scheduleRelayout();
    }
    function leaveRunning() {
      renderer.stop();
      bars = { x: 0, y: 0 };
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
      renderer.onBarsChange(handleBars);
      doc.addEventListener("visibilitychange", onVisibilityChange, { signal: abort.signal });
      store.set({ tabVisible: !doc.hidden });
      adapter.start();
      reconcile();
    }
    function stop() {
      if (!started) return;
      adapter.stop();
      renderer.onBarsChange(null);
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
    function applyClip(bars) {
      const x = bars ? bars.x : 0;
      const y = bars ? bars.y : 0;
      const inset = x > 0 || y > 0 ? `${+y.toFixed(3)}% ${+x.toFixed(3)}%` : "";
      if (applied.clip === inset) return;
      const rootStyle = doc.documentElement.style;
      if (inset) rootStyle.setProperty(config.bars.clipVar, inset);
      else rootStyle.removeProperty(config.bars.clipVar);
      applied.clip = inset;
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
      applyClip(layout.bars);
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
      doc.documentElement.style.removeProperty(config.bars.clipVar);
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

  // src/core/bars.js
  function isBlackPixel(data, index, sumMax, diffMax) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    if (r + g + b > sumMax) return false;
    return Math.abs(r - g) <= diffMax && Math.abs(g - b) <= diffMax && Math.abs(b - r) <= diffMax;
  }
  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }
  function countBlackRows(data, columns, height, column, options) {
    const { blackSumMax, blackChannelDiffMax } = options;
    const indexOf = (row) => (row * columns + column) * 4;
    let top = 0;
    while (top < height && isBlackPixel(data, indexOf(top), blackSumMax, blackChannelDiffMax)) top += 1;
    let bottom = 0;
    while (bottom < height && isBlackPixel(data, indexOf(height - 1 - bottom), blackSumMax, blackChannelDiffMax)) bottom += 1;
    return { top, bottom };
  }
  function analyzeBarStrip(data, columns, height, options) {
    if (!data || !(columns >= 1) || !(height >= 1)) return { status: "invalid", percent: 0 };
    const tops = [];
    const bottoms = [];
    let blackColumns = 0;
    for (let column = 0; column < columns; column += 1) {
      const { top, bottom } = countBlackRows(data, columns, height, column, options);
      if (top >= height) blackColumns += 1;
      tops.push(top);
      bottoms.push(bottom);
    }
    if (blackColumns === columns) return { status: "black", percent: 0 };
    const rows = Math.min(median(tops), median(bottoms));
    const rawPercent = rows / height * 100;
    if (rawPercent > options.maxBarPercent) return { status: "tooBig", percent: rawPercent };
    if (rawPercent < options.minBarPercent) return { status: "ok", percent: 0 };
    const margin = Math.max(0, Number(options.edgeMarginRows) || 0);
    const percent = Math.min(options.maxBarPercent, (rows + margin) / height * 100);
    return { status: "ok", percent };
  }
  function createBarStabilizer(options) {
    const need = Math.max(1, Math.floor(Number(options && options.stableCount) || 1));
    const tolerance = Math.max(0, Number(options && options.stableTolerance) || 0);
    let anchor = null;
    let count = 0;
    function push(percent) {
      if (anchor !== null && Math.abs(percent - anchor) <= tolerance) {
        count += 1;
      } else {
        anchor = percent;
        count = 1;
      }
      return count >= need ? anchor : null;
    }
    function reset() {
      anchor = null;
      count = 0;
    }
    return { push, reset };
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
    const barOptions = config.bars || { enabled: false };
    const stabilizer = createBarStabilizer(barOptions);
    let barLocked = false;
    let barStrip = null;
    let barStripCtx = null;
    let lastSampleMs = 0;
    let emittedBars = { x: 0, y: 0 };
    let barsListener = null;
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
    function ensureBarStrip(columns, rows) {
      if (!barStrip) {
        barStrip = createCanvas();
        barStripCtx = barStrip.getContext("2d", { willReadFrequently: true });
      }
      if (barStrip.width !== columns) barStrip.width = columns;
      if (barStrip.height !== rows) barStrip.height = rows;
      return barStripCtx;
    }
    function releaseBarStrip() {
      barStrip = null;
      barStripCtx = null;
    }
    function emitBars(next) {
      if (emittedBars.x === next.x && emittedBars.y === next.y) return;
      emittedBars = next;
      if (barsListener) barsListener(next);
    }
    function resetBars() {
      stabilizer.reset();
      barLocked = false;
      lastSampleMs = 0;
      emitBars({ x: 0, y: 0 });
    }
    function sampleBars(stamp) {
      if (!barOptions.enabled || barLocked || !video) return;
      if (lastSampleMs > 0 && stamp - lastSampleMs < barOptions.measureIntervalMs) return;
      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;
      if (!(videoWidth > 0) || !(videoHeight > 0)) return;
      lastSampleMs = stamp;
      try {
        const columns = Math.max(1, Math.floor(barOptions.scanColumns));
        const rows = Math.max(1, Math.min(videoHeight, Math.floor(barOptions.stripHeight)));
        const stripCtx = ensureBarStrip(columns, rows);
        for (let i = 0; i < columns; i += 1) {
          const sx = Math.min(videoWidth - 1, Math.floor(videoWidth * (i + 0.5) / columns));
          stripCtx.drawImage(video, sx, 0, 1, videoHeight, i, 0, 1, rows);
        }
        const { data } = stripCtx.getImageData(0, 0, columns, rows);
        const result = analyzeBarStrip(data, columns, rows, barOptions);
        if (result.status !== "ok") return;
        const locked = stabilizer.push(result.percent);
        if (locked === null) return;
        barLocked = true;
        releaseBarStrip();
        emitBars({ x: 0, y: locked });
      } catch (error) {
      }
    }
    function onSourceChange() {
      resetBars();
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
      const { crop } = layout;
      const featherX = Math.min(0.5, Number(layout.feather && layout.feather.x) || 0);
      const featherY = Math.min(0.5, Number(layout.feather && layout.feather.y) || 0);
      if (featherX <= 0 && featherY <= 0) return;
      const key = `${width}x${height}x${featherX}x${featherY}x${crop.sx}x${crop.sy}x${crop.sw}x${crop.sh}`;
      if (key !== featherKey) {
        featherKey = key;
        featherH = featherX > 0 ? buildFeatherGradient(captureCtx.createLinearGradient(crop.sx, 0, crop.sx + crop.sw, 0), featherX) : null;
        featherV = featherY > 0 ? buildFeatherGradient(captureCtx.createLinearGradient(0, crop.sy, 0, crop.sy + crop.sh), featherY) : null;
      }
      captureCtx.globalCompositeOperation = "destination-in";
      if (featherH) {
        captureCtx.fillStyle = featherH;
        captureCtx.fillRect(crop.sx, crop.sy, crop.sw, crop.sh);
      }
      if (featherV) {
        captureCtx.fillStyle = featherV;
        captureCtx.fillRect(crop.sx, crop.sy, crop.sw, crop.sh);
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
        const { crop } = layout;
        for (const d of layout.draws) {
          ctx.drawImage(captureCanvas, crop.sx, crop.sy, crop.sw, crop.sh, d.dx, d.dy, d.dw, d.dh);
        }
        errorCount = 0;
        lastDrawMs = stamp;
        sampleBars(stamp);
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
      resetBars();
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
      video.addEventListener("loadstart", onSourceChange, options);
      video.addEventListener("emptied", onSourceChange, options);
      resetBars();
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
      releaseBarStrip();
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
    function onBarsChange(listener) {
      barsListener = typeof listener === "function" ? listener : null;
    }
    return { attach, setLayout, start, stop, detach, destroy, onBarsChange };
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
