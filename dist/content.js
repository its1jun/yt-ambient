(() => {
  // scripts/config.js
  var CONFIG = Object.freeze({
    blurPx: 24,
    // 흐림 정도 (CSS px). 층 간격(layerGapPx)의 약 2배 안팎이면 계단이 뭉개져 부드러운 확산광이 된다
    saturate: 1,
    // 채도 배율 (1 = 원본)
    videoFeatherPercent: 20,
    // 유튜브 원본 영상 가장자리 페더링 폭 (%)
    maxFps: 15,
    // 초당 그리기 상한 (0 이하면 제한 없음)
    layerGapPx: 48,
    // 층 하나가 사방으로 넓어지는 폭 (CSS px). 계단 한 칸의 실제 폭. 작을수록 층이 늘어 비용 증가 (권장 24~64)
    captureLongSide: 192,
    // 영상 샘플링 canvas의 긴 변 (px)
    canvasLongSide: 288,
    // 앰비언트 canvas 내부 해상도의 긴 변 (px)
    maxLayers: 40,
    // 한 번에 합성할 수 있는 층 수의 상한. 영상이 비정상적으로 작을 때 그리기가 폭주하는 것을 막고, 셰이더의 층 배열 크기도 이 값으로 정해진다
    fanAngleDeg: 15,
    // 부채꼴 한쪽 각도 (도, 0~60). 층의 색을 중심에서 이 각도 안으로 퍼뜨려 평균내어 방사형 줄무늬를 흐린다. 0이면 끔(기존 모습). 클수록 넓게 퍼진다
    // 앰비언트 실행을 허용할 화면 모드 
    // ['default','theater','fullscreen']
    enabledModes: ["theater"],
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
      // <html>에 넣는 CSS 변수 이름의 앞부분. 실제로는 뒤에 -x, -y가 붙은 두 변수를 쓴다 (styles/ambient.css의 이름과 같아야 한다)
    }
  });

  // scripts/selectors.js
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

  // scripts/store.js
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

  // scripts/layout.js
  var EPSILON = 0.01;
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
  function computeLayerCount(playerRect, videoRect, layerGapPx, maxLayers) {
    const needed = Math.ceil(computeFarthestGap(playerRect, videoRect) / layerGapPx - 1e-4);
    return Math.min(maxLayers, Math.max(1, needed) + 1);
  }
  function computeFeather(videoRect, layerGapPx) {
    if (!isPositiveNumber(layerGapPx)) return { x: 0, y: 0 };
    return {
      x: Math.min(0.5, layerGapPx / videoRect.width),
      y: Math.min(0.5, layerGapPx / videoRect.height)
    };
  }
  function computeLayout({ playerRect, videoRect, parentRect, bars, config }) {
    const { layerGapPx, captureLongSide, canvasLongSide, maxLayers } = config || {};
    if (!isSizedRect(playerRect) || !isSizedRect(videoRect) || !isPositionedRect(parentRect)) {
      return INVALID_LAYOUT;
    }
    if (!isPositiveNumber(layerGapPx) || !isPositiveNumber(captureLongSide) || !isPositiveNumber(canvasLongSide) || !isPositiveNumber(maxLayers)) {
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
    const count = computeLayerCount(playerRect, contentRect, layerGapPx, maxLayers);
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

  // scripts/controller.js
  function emptyApplied() {
    return { state: "IDLE", player: null, video: null, parent: null, boundVideo: null, boundCanvas: null };
  }
  function createController({ adapter, store, mount, renderer, config, computeLayout: computeLayout2, env = {} }) {
    const doc = env.doc || document;
    const raf = env.requestAnimationFrame || ((cb) => requestAnimationFrame(cb));
    const caf = env.cancelAnimationFrame || ((id) => cancelAnimationFrame(id));
    const ResizeObserverImpl = env.ResizeObserver || (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
    let started = false;
    let applied = emptyApplied();
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
      mount.unmount();
      lastLayout = null;
      applied = emptyApplied();
    }
    function enterArmed(s) {
      if (applied.state === "RUNNING") leaveRunning();
      mount.setVisible(false);
      applied = { ...applied, state: "ARMED", player: s.player, video: s.video, parent: s.mountParent };
    }
    function enterRunning(s) {
      const parentChanged = applied.parent !== s.mountParent;
      const { canvas } = mount.mount(s.mountParent);
      if (applied.boundVideo !== s.video || applied.boundCanvas !== canvas) renderer.attach(s.video, canvas);
      applied = { state: "RUNNING", player: s.player, video: s.video, parent: s.mountParent, boundVideo: s.video, boundCanvas: canvas };
      if (!renderer.hasGl()) {
        mount.setRootAttr(false);
        mount.setVisible(false);
        return;
      }
      mount.setRootAttr(true);
      mount.setVisible(true);
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

  // scripts/adapter.js
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
    return { start, stop };
  }

  // scripts/mount.js
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
      const clipVar = config.bars.clipVar;
      if (inset) {
        rootStyle.setProperty(`${clipVar}-x`, `${+x.toFixed(3)}%`);
        rootStyle.setProperty(`${clipVar}-y`, `${+y.toFixed(3)}%`);
      } else {
        rootStyle.removeProperty(`${clipVar}-x`);
        rootStyle.removeProperty(`${clipVar}-y`);
      }
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
      if (on) {
        root.setAttribute(config.rootAttr, "on");
        root.style.setProperty("--video-feather", `${config.videoFeatherPercent}%`);
      } else {
        root.removeAttribute(config.rootAttr);
        root.style.removeProperty("--video-feather");
      }
    }
    function unmount() {
      doc.documentElement.style.removeProperty(`${config.bars.clipVar}-x`);
      doc.documentElement.style.removeProperty(`${config.bars.clipVar}-y`);
      doc.documentElement.style.removeProperty("--video-feather");
      if (wrapper) wrapper.remove();
      wrapper = null;
      canvas = null;
      applied = {};
    }
    return { mount, applyLayout, setVisible, setRootAttr, unmount };
  }

  // scripts/letterbox.js
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
  function createLetterboxDetector({ config, env = {} }) {
    const createCanvas = env.createCanvas || (() => document.createElement("canvas"));
    const barOptions = config.bars || { enabled: false };
    const stabilizer = createBarStabilizer(barOptions);
    let barLocked = false;
    let barStrip = null;
    let barStripCtx = null;
    let lastSampleMs = 0;
    let emittedBars = { x: 0, y: 0 };
    let barsListener = null;
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
    function reset() {
      stabilizer.reset();
      barLocked = false;
      lastSampleMs = 0;
      emitBars({ x: 0, y: 0 });
    }
    function sample(video, stamp) {
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
    function onChange(listener) {
      barsListener = typeof listener === "function" ? listener : null;
    }
    return { sample, reset, release: releaseBarStrip, onChange };
  }

  // scripts/shaders.js
  var FAN_TAPS = 2;
  var CAPTURE_TAPS = 4;
  var MAX_BLUR_RADIUS = 24;
  var VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform vec4 u_rect;
uniform vec4 u_uv;
out vec2 v_local;
out vec2 v_uv;
void main() {
  v_local = a_corner;
  v_uv = u_uv.xy + a_corner * u_uv.zw;
  gl_Position = vec4(u_rect.xy + a_corner * u_rect.zw, 0.0, 1.0);
}`;
  var CAPTURE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
#define CAPTURE_TAPS ${CAPTURE_TAPS}
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_footprint;
out vec4 outColor;
void main() {
  vec3 sum = vec3(0.0);
  for (int y = 0; y < CAPTURE_TAPS; y++) {
    for (int x = 0; x < CAPTURE_TAPS; x++) {
      vec2 offset = (vec2(float(x), float(y)) + 0.5) / float(CAPTURE_TAPS) - 0.5;
      sum += texture(u_tex, v_uv + offset * u_footprint).rgb;
    }
  }
  outColor = vec4(sum / float(CAPTURE_TAPS * CAPTURE_TAPS), 1.0);
}`;
  function buildCompositeSource(maxLayers) {
    return `#version 300 es
precision highp float;
#define MAX_LAYERS ${maxLayers}
#define FAN_TAPS ${FAN_TAPS}
const float OPAQUE_LIMIT = 0.999;  // \uC313\uC778 \uBD88\uD22C\uBA85\uB3C4\uAC00 \uC774 \uAC12 \uC774\uC0C1\uC774\uBA74 \uB354 \uBC14\uAE65 \uCE35\uC740 \uBCF4\uC774\uC9C0 \uC54A\uC73C\uBBC0\uB85C \uC77D\uC9C0 \uC54A\uB294\uB2E4
in vec2 v_local;
uniform sampler2D u_tex;
uniform vec2 u_canvasSize;
uniform vec4 u_crop;
uniform vec2 u_feather;
uniform float u_fanAngle;
uniform int u_layerCount;
uniform vec4 u_boxes[MAX_LAYERS];
out vec4 outColor;

// \uCE35 \uC548\uC758 \uC704\uCE58(local)\uB97C \uCE35 \uC911\uC2EC \uAE30\uC900\uC73C\uB85C angle(\uB77C\uB514\uC548)\uB9CC\uD07C \uB3CC\uB9B0\uB2E4. aspect = \uCE35\uC758 \uAC00\uB85C/\uC138\uB85C \uBE44\uC728 (\uBE44\uC728\uC744 \uBCF4\uC815\uD574\uC57C \uC6D0\uD638\uB85C \uB3C8\uB2E4)
vec2 rotateAroundCenter(vec2 local, float angle, float aspect) {
  vec2 v = (local - 0.5) * vec2(aspect, 1.0);
  float s = sin(angle);
  float c = cos(angle);
  v = vec2(c * v.x - s * v.y, s * v.x + c * v.y);
  return clamp(v / vec2(aspect, 1.0) + 0.5, 0.0, 1.0);
}

// \uBD80\uCC44\uAF34 \uC0D8\uD50C\uB9C1: \uC911\uC2EC\uC5D0\uC11C \uAC19\uC740 \uAC70\uB9AC\uC778 \uC810\uC744 -u_fanAngle ~ +u_fanAngle \uBC94\uC704\uC5D0\uC11C \uC5EC\uB7EC \uACF3 \uC77D\uC5B4 \uD3C9\uADE0\uB0B8\uB2E4
// \uAC00\uC911\uCE58\uB294 \uC911\uC2EC\uC120\uC774 \uAC00\uC7A5 \uD06C\uACE0 \uBD80\uCC44\uAF34 \uB05D\uC73C\uB85C \uAC08\uC218\uB85D 0\uC5D0 \uAC00\uAE4C\uC6CC\uC838, \uAC01\uB3C4 \uBC94\uC704\uC758 \uAC00\uC7A5\uC790\uB9AC\uAC00 \uBD80\uB4DC\uB7FD\uAC8C \uC0AC\uB77C\uC9C4\uB2E4
vec3 sampleFan(vec2 local, float aspect) {
  vec3 sum = vec3(0.0);
  float weightSum = 0.0;
  for (int k = -FAN_TAPS; k <= FAN_TAPS; k++) {
    float t = float(k) / float(FAN_TAPS + 1);
    float w = cos(t * 1.5707963);
    w *= w;
    vec2 p = rotateAroundCenter(local, t * u_fanAngle, aspect);
    sum += textureLod(u_tex, u_crop.xy + p * u_crop.zw, 0.0).rgb * w;
    weightSum += w;
  }
  return sum / weightSum;
}

void main() {
  vec2 pixel = v_local * u_canvasSize;
  vec3 accum = vec3(0.0);   // \uC9C0\uAE08\uAE4C\uC9C0 \uC313\uC778 \uC0C9 (\uBD88\uD22C\uBA85\uB3C4\uB97C \uBBF8\uB9AC \uACF1\uD55C \uAC12)
  float covered = 0.0;      // \uC9C0\uAE08\uAE4C\uC9C0 \uC313\uC778 \uBD88\uD22C\uBA85\uB3C4 (0~1)
  for (int j = 0; j < MAX_LAYERS; j++) {
    if (j >= u_layerCount) break;
    vec4 box = u_boxes[u_layerCount - 1 - j];
    vec2 local = (pixel - box.xy) / box.zw;
    if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) continue;
    vec2 edge = min(local, 1.0 - local);
    float alphaX = u_feather.x > 0.0 ? clamp(edge.x / u_feather.x, 0.0, 1.0) : 1.0;
    float alphaY = u_feather.y > 0.0 ? clamp(edge.y / u_feather.y, 0.0, 1.0) : 1.0;
    float alpha = alphaX * alphaY;
    if (alpha <= 0.0) continue;
    vec3 color = u_fanAngle > 0.0
      ? sampleFan(local, box.z / box.w)
      : textureLod(u_tex, u_crop.xy + local * u_crop.zw, 0.0).rgb;
    accum += (1.0 - covered) * alpha * color;
    covered += (1.0 - covered) * alpha;
    if (covered >= OPAQUE_LIMIT) break;
  }
  outColor = vec4(accum, covered);
}`;
  }
  var BLUR_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
#define MAX_BLUR_RADIUS ${MAX_BLUR_RADIUS}
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_step;
uniform float u_sigma;
uniform float u_saturate;
out vec4 outColor;
void main() {
  vec4 sum = texture(u_tex, v_uv);
  float weightSum = 1.0;
  int radius = min(MAX_BLUR_RADIUS, int(ceil(u_sigma * 3.0)));
  float falloff = u_sigma > 0.0 ? -0.5 / (u_sigma * u_sigma) : 0.0;
  for (int k = 1; k <= MAX_BLUR_RADIUS; k += 2) {
    if (k > radius) break;
    float w0 = exp(float(k * k) * falloff);
    float w1 = (k + 1 <= radius) ? exp(float((k + 1) * (k + 1)) * falloff) : 0.0;
    float w = w0 + w1;
    float shift = w > 0.0 ? w1 / w : 0.0;
    vec2 offset = u_step * (float(k) + shift);
    sum += (texture(u_tex, v_uv + offset) + texture(u_tex, v_uv - offset)) * w;
    weightSum += 2.0 * w;
  }
  vec4 c = sum / weightSum;
  float gray = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 rgb = mix(vec3(gray), c.rgb, u_saturate);
  outColor = vec4(clamp(rgb, 0.0, c.a), c.a);
}`;

  // scripts/gl-pipeline.js
  var MAX_FAN_ANGLE_DEG = 60;
  var MIN_READY_STATE = 2;
  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`shader compile failed: ${log}`);
    }
    return shader;
  }
  function createProgram(gl, vertexSource, fragmentSource) {
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`program link failed: ${log}`);
    }
    return program;
  }
  function createTexture(gl, minFilter) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }
  function createGlPipeline({ config, logger, onRestored, onError }) {
    let canvas = null;
    let layout = null;
    let gl = null;
    let glReady = false;
    let glAbort = null;
    let captureProgram = null;
    let captureUniforms = null;
    let compositeProgram = null;
    let compositeUniforms = null;
    const maxLayers = config.maxLayers;
    const layerBoxes = new Float32Array(maxLayers * 4);
    let layerCount = 0;
    let layoutDirty = true;
    let quadVao = null;
    let quadBuffer = null;
    let videoTexture = null;
    let videoTextureWidth = 0;
    let videoTextureHeight = 0;
    let captureTexture = null;
    let captureFramebuffer = null;
    let captureWidth = 0;
    let captureHeight = 0;
    let blurProgram = null;
    let blurUniforms = null;
    let sceneTexture = null;
    let sceneFramebuffer = null;
    let blurTexture = null;
    let blurFramebuffer = null;
    let targetWidth = 0;
    let targetHeight = 0;
    let warnedNoGl = false;
    function allocateCapture(width, height) {
      gl.bindTexture(gl.TEXTURE_2D, captureTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, captureFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, captureTexture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      captureWidth = width;
      captureHeight = height;
    }
    function allocateTargets(width, height) {
      [[sceneTexture, sceneFramebuffer], [blurTexture, blurFramebuffer]].forEach(([texture, framebuffer]) => {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      targetWidth = width;
      targetHeight = height;
    }
    function buildGlResources() {
      captureProgram = createProgram(gl, VERTEX_SOURCE, CAPTURE_FRAGMENT_SOURCE);
      captureUniforms = {
        rect: gl.getUniformLocation(captureProgram, "u_rect"),
        uv: gl.getUniformLocation(captureProgram, "u_uv"),
        tex: gl.getUniformLocation(captureProgram, "u_tex"),
        footprint: gl.getUniformLocation(captureProgram, "u_footprint")
      };
      compositeProgram = createProgram(gl, VERTEX_SOURCE, buildCompositeSource(maxLayers));
      compositeUniforms = {
        rect: gl.getUniformLocation(compositeProgram, "u_rect"),
        uv: gl.getUniformLocation(compositeProgram, "u_uv"),
        tex: gl.getUniformLocation(compositeProgram, "u_tex"),
        canvasSize: gl.getUniformLocation(compositeProgram, "u_canvasSize"),
        crop: gl.getUniformLocation(compositeProgram, "u_crop"),
        feather: gl.getUniformLocation(compositeProgram, "u_feather"),
        fanAngle: gl.getUniformLocation(compositeProgram, "u_fanAngle"),
        layerCount: gl.getUniformLocation(compositeProgram, "u_layerCount"),
        boxes: gl.getUniformLocation(compositeProgram, "u_boxes")
      };
      blurProgram = createProgram(gl, VERTEX_SOURCE, BLUR_FRAGMENT_SOURCE);
      blurUniforms = {
        rect: gl.getUniformLocation(blurProgram, "u_rect"),
        uv: gl.getUniformLocation(blurProgram, "u_uv"),
        tex: gl.getUniformLocation(blurProgram, "u_tex"),
        step: gl.getUniformLocation(blurProgram, "u_step"),
        sigma: gl.getUniformLocation(blurProgram, "u_sigma"),
        saturate: gl.getUniformLocation(blurProgram, "u_saturate")
      };
      quadVao = gl.createVertexArray();
      gl.bindVertexArray(quadVao);
      quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      videoTexture = createTexture(gl, gl.LINEAR);
      captureTexture = createTexture(gl, gl.LINEAR);
      captureFramebuffer = gl.createFramebuffer();
      sceneTexture = createTexture(gl, gl.LINEAR);
      sceneFramebuffer = gl.createFramebuffer();
      blurTexture = createTexture(gl, gl.LINEAR);
      blurFramebuffer = gl.createFramebuffer();
      targetWidth = 0;
      targetHeight = 0;
      videoTextureWidth = 0;
      videoTextureHeight = 0;
      captureWidth = 0;
      captureHeight = 0;
      layoutDirty = true;
      glReady = true;
    }
    function releaseGlResources() {
      glReady = false;
      if (gl) {
        if (captureProgram) gl.deleteProgram(captureProgram);
        if (compositeProgram) gl.deleteProgram(compositeProgram);
        if (blurProgram) gl.deleteProgram(blurProgram);
        if (quadBuffer) gl.deleteBuffer(quadBuffer);
        if (quadVao) gl.deleteVertexArray(quadVao);
        if (videoTexture) gl.deleteTexture(videoTexture);
        if (captureTexture) gl.deleteTexture(captureTexture);
        if (captureFramebuffer) gl.deleteFramebuffer(captureFramebuffer);
        if (sceneTexture) gl.deleteTexture(sceneTexture);
        if (sceneFramebuffer) gl.deleteFramebuffer(sceneFramebuffer);
        if (blurTexture) gl.deleteTexture(blurTexture);
        if (blurFramebuffer) gl.deleteFramebuffer(blurFramebuffer);
      }
      captureProgram = null;
      captureUniforms = null;
      compositeProgram = null;
      compositeUniforms = null;
      quadVao = null;
      quadBuffer = null;
      videoTexture = null;
      captureTexture = null;
      captureFramebuffer = null;
      videoTextureWidth = 0;
      videoTextureHeight = 0;
      captureWidth = 0;
      captureHeight = 0;
      blurProgram = null;
      blurUniforms = null;
      sceneTexture = null;
      sceneFramebuffer = null;
      blurTexture = null;
      blurFramebuffer = null;
      targetWidth = 0;
      targetHeight = 0;
    }
    function onContextLost(event) {
      event.preventDefault();
      glReady = false;
    }
    function onContextRestored() {
      if (!canvas || !gl) return;
      try {
        buildGlResources();
        applySizes();
        onRestored();
      } catch (error) {
        onError(error);
      }
    }
    function setup(nextCanvas) {
      canvas = nextCanvas;
      gl = canvas.getContext("webgl2", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false
      });
      if (!gl) {
        if (!warnedNoGl) {
          warnedNoGl = true;
          logger.warn("[yt-ambient] WebGL2 is not available, so the ambient light is disabled.");
        }
        return false;
      }
      glAbort = new AbortController();
      const options = { signal: glAbort.signal };
      canvas.addEventListener("webglcontextlost", onContextLost, options);
      canvas.addEventListener("webglcontextrestored", onContextRestored, options);
      try {
        buildGlResources();
      } catch (error) {
        logger.warn("[yt-ambient] Failed to set up WebGL resources.", error);
        releaseGlResources();
        gl = null;
        return false;
      }
      return true;
    }
    function applySizes() {
      if (!layout || !layout.valid) return false;
      let changed = false;
      const { captureSize, canvasPx } = layout;
      if (glReady && (captureWidth !== captureSize.width || captureHeight !== captureSize.height)) {
        allocateCapture(captureSize.width, captureSize.height);
        changed = true;
      }
      if (glReady && (targetWidth !== canvasPx.width || targetHeight !== canvasPx.height)) {
        allocateTargets(canvasPx.width, canvasPx.height);
        changed = true;
      }
      if (canvas && (canvas.width !== canvasPx.width || canvas.height !== canvasPx.height)) {
        canvas.width = canvasPx.width;
        canvas.height = canvasPx.height;
        changed = true;
      }
      return changed;
    }
    function uploadVideoFrame(video) {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (video.readyState < MIN_READY_STATE || !(width > 0) || !(height > 0)) return false;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      if (width !== videoTextureWidth || height !== videoTextureHeight) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        videoTextureWidth = width;
        videoTextureHeight = height;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
      }
      return true;
    }
    function renderCapture() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, captureFramebuffer);
      gl.viewport(0, 0, captureWidth, captureHeight);
      gl.disable(gl.BLEND);
      gl.useProgram(captureProgram);
      gl.bindVertexArray(quadVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.uniform1i(captureUniforms.tex, 0);
      gl.uniform4f(captureUniforms.rect, -1, -1, 2, 2);
      gl.uniform4f(captureUniforms.uv, 0, 0, 1, 1);
      gl.uniform2f(captureUniforms.footprint, 1 / captureWidth, 1 / captureHeight);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function uploadLayoutUniforms() {
      const { crop, captureSize, feather, draws } = layout;
      const u = compositeUniforms;
      layerCount = Math.min(maxLayers, draws.length);
      for (let i = 0; i < layerCount; i += 1) {
        const d = draws[i];
        layerBoxes[i * 4] = d.dx;
        layerBoxes[i * 4 + 1] = d.dy;
        layerBoxes[i * 4 + 2] = d.dw;
        layerBoxes[i * 4 + 3] = d.dh;
      }
      if (layerCount > 0) gl.uniform4fv(u.boxes, layerBoxes.subarray(0, layerCount * 4));
      gl.uniform1i(u.layerCount, layerCount);
      gl.uniform2f(u.canvasSize, canvas.width, canvas.height);
      const halfTexelX = 0.5 / captureSize.width;
      const halfTexelY = 0.5 / captureSize.height;
      gl.uniform4f(
        u.crop,
        crop.sx / captureSize.width + halfTexelX,
        crop.sy / captureSize.height + halfTexelY,
        crop.sw / captureSize.width - halfTexelX * 2,
        crop.sh / captureSize.height - halfTexelY * 2
      );
      gl.uniform2f(
        u.feather,
        Math.min(0.5, Number(feather && feather.x) || 0),
        Math.min(0.5, Number(feather && feather.y) || 0)
      );
      const fanDeg = Math.min(MAX_FAN_ANGLE_DEG, Math.max(0, Number(config.fanAngleDeg) || 0));
      gl.uniform1f(u.fanAngle, fanDeg * Math.PI / 180);
      layoutDirty = false;
    }
    function renderLayers() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFramebuffer);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.BLEND);
      gl.useProgram(compositeProgram);
      gl.bindVertexArray(quadVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, captureTexture);
      gl.uniform1i(compositeUniforms.tex, 0);
      gl.uniform4f(compositeUniforms.rect, -1, -1, 2, 2);
      gl.uniform4f(compositeUniforms.uv, 0, 0, 1, 1);
      if (layoutDirty) uploadLayoutUniforms();
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function renderBlur() {
      const { canvasBox, canvasPx } = layout;
      const blurCssPx = Math.max(0, Number(config.blurPx) || 0);
      const sigma = blurCssPx * (canvasPx.width / canvasBox.width);
      const saturate = Number.isFinite(config.saturate) ? config.saturate : 1;
      const u = blurUniforms;
      gl.useProgram(blurProgram);
      gl.bindVertexArray(quadVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(u.tex, 0);
      gl.uniform4f(u.uv, 0, 0, 1, 1);
      gl.uniform1f(u.sigma, sigma);
      gl.bindFramebuffer(gl.FRAMEBUFFER, blurFramebuffer);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
      gl.uniform4f(u.rect, -1, -1, 2, 2);
      gl.uniform2f(u.step, 1 / canvas.width, 0);
      gl.uniform1f(u.saturate, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, blurTexture);
      gl.uniform4f(u.rect, -1, 1, 2, -2);
      gl.uniform2f(u.step, 0, 1 / canvas.height);
      gl.uniform1f(u.saturate, saturate);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function setLayout(nextLayout) {
      layout = nextLayout || null;
      layoutDirty = true;
      applySizes();
    }
    function draw(video) {
      if (!canvas || !gl || !glReady) return false;
      if (!layout || !layout.valid) return false;
      if (!uploadVideoFrame(video)) return false;
      renderCapture();
      renderLayers();
      renderBlur();
      return true;
    }
    function release() {
      if (glAbort) {
        glAbort.abort();
        glAbort = null;
      }
      releaseGlResources();
      gl = null;
      canvas = null;
    }
    function hasGl() {
      return gl !== null;
    }
    return { setup, setLayout, draw, release, hasGl };
  }

  // scripts/renderer.js
  var FRAME_SLACK_MS = 2;
  function shouldDrawFrame(nowMs, lastDrawMs, maxFps) {
    if (!Number.isFinite(maxFps) || maxFps <= 0) return true;
    if (!Number.isFinite(lastDrawMs) || lastDrawMs <= 0) return true;
    return nowMs - lastDrawMs >= 1e3 / maxFps - FRAME_SLACK_MS;
  }
  function createRenderer({ config, env = {} }) {
    const now = env.now || (() => performance.now());
    const logger = env.logger || console;
    let video = null;
    let canvas = null;
    let layout = null;
    let running = false;
    let halted = false;
    let frameHandle = null;
    let mediaAbort = null;
    let errorCount = 0;
    let lastDrawMs = 0;
    let warnedNoRvfc = false;
    const detector = createLetterboxDetector({ config, env });
    const pipeline = createGlPipeline({
      config,
      logger,
      onRestored: () => {
        if (running) drawFrame(now());
      },
      onError: (error) => handleDrawError(error)
    });
    function onSourceChange() {
      detector.reset();
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
      logger.debug("[yt-ambient] Rendering stopped after consecutive draw failures.", error);
    }
    function drawFrame(stamp) {
      if (!video || !canvas || halted) return;
      try {
        if (!pipeline.draw(video)) return;
        errorCount = 0;
        lastDrawMs = stamp;
        detector.sample(video, stamp);
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
      pipeline.setup(canvas);
      halted = false;
      errorCount = 0;
      lastDrawMs = 0;
      detector.reset();
      pipeline.setLayout(layout);
    }
    function setLayout(nextLayout) {
      layout = nextLayout || null;
      pipeline.setLayout(layout);
      if (running) drawFrame(now());
    }
    function start() {
      if (running || halted || !video || !canvas || !pipeline.hasGl()) return;
      if (typeof video.requestVideoFrameCallback !== "function") {
        if (!warnedNoRvfc) {
          warnedNoRvfc = true;
          logger.warn("[yt-ambient] requestVideoFrameCallback is not supported, so the ambient light is disabled.");
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
      detector.reset();
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
      detector.release();
      pipeline.release();
      video = null;
      canvas = null;
    }
    function hasGl() {
      return pipeline.hasGl();
    }
    function destroy() {
      detach();
      layout = null;
      pipeline.setLayout(null);
    }
    function onBarsChange(listener) {
      detector.onChange(listener);
    }
    return { attach, setLayout, start, stop, detach, destroy, onBarsChange, hasGl };
  }

  // scripts/main.js
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
