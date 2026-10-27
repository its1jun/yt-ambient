// YouTube 화면을 관찰해 "지금 무슨 상황인지(사실)"만 알려주는 모듈.
// 앰비언트를 보일지 말지는 판단하지 않는다. (판단은 store의 deriveRunState가 한다)

// 처음 상태이자 시청 페이지가 아닐 때의 사실
const INITIAL_FACTS = Object.freeze({
  isWatchPage: false,
  mode: 'default',
  mountParent: null,
  player: null,
  video: null,
});

const FACT_KEYS = ['isWatchPage', 'mode', 'mountParent', 'player', 'video'];

// 화면 모드를 읽는다: 전체화면 > 극장 > 기본 순서로 우선한다
export function readMode({ fullscreenElement, watchRoot, modeAttrs }) {
  if (fullscreenElement) return 'fullscreen';
  if (watchRoot && modeAttrs.some((attr) => watchRoot.hasAttribute(attr))) return 'theater';
  return 'default';
}

// 현재 화면에서 사실(facts)을 읽는다. 시청 페이지가 아니면 요소는 모두 null.
// 플레이어와 영상은 시청 화면 최상위 요소(watchRoot) 안에서만 찾는다.
export function readFacts({ doc, pathname, selectors }) {
  if (pathname !== selectors.watchPath) return INITIAL_FACTS;
  const watchRoot = doc.querySelector(selectors.watchRoot);
  return {
    isWatchPage: true,
    mode: readMode({
      fullscreenElement: doc.fullscreenElement,
      watchRoot,
      modeAttrs: selectors.modeAttrs,
    }),
    mountParent: doc.querySelector(selectors.mountParent),
    player: watchRoot ? watchRoot.querySelector(selectors.player) : null,
    video: watchRoot ? watchRoot.querySelector(selectors.video) : null,
  };
}

// 두 facts가 같은 값인지 얕게 비교한다 (요소는 같은 객체인지 비교)
export function factsEqual(a, b) {
  return FACT_KEYS.every((key) => Object.is(a[key], b[key]));
}

// 요소가 모두 준비되었는지 확인
function hasAllElements(facts) {
  return !!(facts.mountParent && facts.player && facts.video);
}

// 어댑터를 만든다. start()/stop()은 여러 번 불러도 안전하다.
// env는 테스트용 선택 항목이다: { doc, getPathname, MutationObserver } (기본값은 실제 브라우저 객체)
export function createAdapter({ onChange, config, selectors, env = {} }) {
  let doc = null;
  let getPathname = null;
  let MutationObserverImpl = null;
  let abortController = null;   // 이벤트 리스너를 한 번에 해제하기 위한 장치
  let observer = null;
  let observedRoot = null;
  let retryTimer = null;
  let retryCount = 0;
  let facts = INITIAL_FACTS;

  // 재시도 타이머를 멈춘다
  function clearRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  // 요소가 아직 없으면 정해진 횟수만큼만 다시 확인한다 (무한 반복 금지)
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

  // 시청 화면 요소가 바뀌었으면 속성 감시를 새 요소로 옮긴다
  function syncObserver() {
    const root = doc.querySelector(selectors.watchRoot);
    if (root === observedRoot) return;
    if (observer) observer.disconnect();
    observedRoot = root;
    if (!root) return;
    if (!observer) observer = new MutationObserverImpl(refresh);
    observer.observe(root, { attributes: true, attributeFilter: [...selectors.modeAttrs] });
  }

  // 현재 사실을 다시 읽고, 바뀐 경우에만 onChange로 알린다
  function refresh() {
    if (abortController === null) return;
    const next = readFacts({ doc, pathname: getPathname(), selectors });
    if (!factsEqual(facts, next)) {
      facts = next;
      if (config.debug) console.debug('[yt-ambient]', facts);
      onChange(facts);
    }
    syncObserver();
    scheduleRetry(next);
  }

  // 페이지 이동이 끝났을 때: 재시도 횟수를 초기화하고 다시 읽는다
  function handleNavigate() {
    clearRetry();
    retryCount = 0;
    refresh();
  }

  // 관찰을 시작한다 (이미 시작했으면 무시)
  function start() {
    if (abortController !== null) return;
    doc = env.doc ?? globalThis.document;
    getPathname = env.getPathname ?? (() => globalThis.location.pathname);
    MutationObserverImpl = env.MutationObserver ?? globalThis.MutationObserver;
    abortController = new AbortController();
    const { signal } = abortController;
    doc.addEventListener('yt-navigate-finish', handleNavigate, { signal });
    doc.addEventListener('fullscreenchange', refresh, { signal });
    refresh();
  }

  // 관찰을 멈추고 모든 것을 해제한다 (시작하지 않았으면 무시)
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
