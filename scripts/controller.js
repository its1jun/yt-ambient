// 상태(store)를 보고 adapter / mount / renderer를 조율하는 상태 머신 (IDLE / ARMED / RUNNING)
import { deriveRunState } from './store.js';
import { layoutEquals, scaleRectAboutCenter } from './layout.js';

// 아무것도 적용하지 않은 처음 상태
// boundVideo/boundCanvas = renderer에 연결해 둔 요소. ARMED로 가도 GPU 자원과 함께 유지되고, IDLE로 갈 때만 비운다
// (그래서 ARMED 중에 video가 바뀌어도 video와 boundVideo는 다를 수 있다)
function emptyApplied() {
  return { state: 'IDLE', player: null, video: null, parent: null, boundVideo: null, boundCanvas: null };
}

// 컨트롤러를 만든다. env는 테스트에서 가짜 document/rAF/ResizeObserver를 넣기 위한 선택 인자
export function createController({ adapter, store, mount, renderer, config, computeLayout, env = {} }) {
  const doc = env.doc || document;
  const raf = env.requestAnimationFrame || ((cb) => requestAnimationFrame(cb));
  const caf = env.cancelAnimationFrame || ((id) => cancelAnimationFrame(id));
  const getStyle = env.getComputedStyle || ((el) => getComputedStyle(el));
  const ResizeObserverImpl = env.ResizeObserver || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);

  let started = false;
  let applied = emptyApplied();   // 지금 실제로 적용된 상태 (reconcile이 같은 입력이면 아무것도 안 하게 하는 기준)
  let resizeObserver = null;
  let bars = { x: 0, y: 0 };   // 렌더러가 확정한 검은 띠 크기 (영상 대비 한쪽 %, 0이면 띠 없음)
  let rafId = null;
  let lastLayout = null;
  const barCache = new Map();   // 영상(src)별로 확정된 검은 띠. 탭을 바꿨다 돌아와도 다시 측정하지 않고 이 값을 쓴다 (영상당 1회)
  let unsubscribe = null;
  let abort = null;

  // 예약된 레이아웃 계산을 취소한다
  function cancelRelayout() {
    if (rafId !== null) caf(rafId);
    rafId = null;
  }

  // ResizeObserver를 끊는다
  function disconnectObserver() {
    if (resizeObserver) resizeObserver.disconnect();
  }

  // 영상 요소에 지금 실제로 적용된 CSS 확대 배율을 읽는다 (없으면 1). getBoundingClientRect는 이 배율이 반영된 값이라 되돌릴 때 쓴다
  function readVideoScale(video) {
    const value = parseFloat(getStyle(video).scale);   // 'none'이면 NaN
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  // 어떤 스크롤 위치에서도 절대 보이지 않는 바깥의 경계를 화면 기준 좌표(getBoundingClientRect와 같은 좌표)로 읽는다
  // 문서의 왼쪽/위쪽 끝보다 바깥과 문서 폭보다 오른쪽은 스크롤해도 보이지 않는다. 아래쪽은 스크롤하면 보이므로 제한하지 않는다
  // 문서 기준이라 스크롤해도 canvas 안의 같은 곳이 가리키므로, 스크롤할 때 다시 계산하지 않아도 된다
  function readViewportBounds() {
    const view = doc.defaultView;
    const root = doc.documentElement;
    const scrollX = view ? Number(view.scrollX) || 0 : 0;
    const scrollY = view ? Number(view.scrollY) || 0 : 0;
    const width = root ? Math.max(Number(root.clientWidth) || 0, Number(root.scrollWidth) || 0) : 0;   // 가로로 넘치는 내용이 있으면 그만큼은 제한하지 않는다
    return { left: -scrollX, top: -scrollY, right: width > 0 ? width - scrollX : null };
  }

  // 지금 영상을 구분하는 키 (영상이 바뀌면 달라진다)
  function videoKey(video) {
    return video ? String(video.currentSrc || video.src || '') : '';
  }

  // 레이아웃을 지금 계산해 적용한다. 읽기(rect 3개, 영상 확대 배율)를 먼저 모두 하고, 이전과 같으면 아무것도 쓰지 않는다
  function relayout() {
    rafId = null;
    if (applied.state !== 'RUNNING') return;
    const playerRect = applied.player.getBoundingClientRect();
    // 확대가 적용된 영상 사각형을 확대 전으로 되돌린다 (배율은 computeLayout이 다시 정한다)
    const videoRect = scaleRectAboutCenter(applied.video.getBoundingClientRect(), 1 / readVideoScale(applied.video));
    const parentRect = applied.parent.getBoundingClientRect();
    const videoParent = applied.video.parentElement;
    const videoParentRect = videoParent ? videoParent.getBoundingClientRect() : playerRect;   // 세로 마스크 기준(확대되지 않는 영상 부모)
    const bounds = readViewportBounds();
    const next = computeLayout({ playerRect, videoRect, parentRect, bounds, bars, config });

    // INVALID_LAYOUT에는 videoBox가 없다. 그 상태에서 좌표를 읽으면 relayout 전체가 예외로 끝나
    // 이후의 탭 복귀/리사이즈 재계산까지 막힐 수 있다. 기존 화면은 유지하고 다음 계산을 허용한다.
    if (!next || !next.valid || !next.videoBox) {
      lastLayout = null;
      return;
    }

    if (lastLayout && layoutEquals(lastLayout, next)) return;
    lastLayout = next;
    mount.applyLayout(next, { top: next.videoBox.top - videoParentRect.top, height: next.videoBox.height });
    renderer.setLayout(next);
  }

  // 레이아웃 계산을 다음 화면 갱신 때 한 번만 하도록 예약한다 (여러 번 불려도 1회로 합쳐짐)
  function scheduleRelayout() {
    if (rafId !== null) return;
    rafId = raf(relayout);
  }

  // RUNNING 중 플레이어/영상 크기 변화를 지켜본다 (요소가 바뀌면 다시 연결)
  function observeElements(player, video) {
    if (!ResizeObserverImpl) return;
    if (!resizeObserver) resizeObserver = new ResizeObserverImpl(scheduleRelayout);
    resizeObserver.disconnect();
    resizeObserver.observe(player);
    resizeObserver.observe(video);
  }

  // 렌더러가 띠 크기를 확정/초기화하면 받아서 배치를 다시 계산하도록 예약한다 (단위: %)
  function handleBars(next) {
    const x = Number(next && next.x) || 0;
    const y = Number(next && next.y) || 0;
    const key = videoKey(applied.video);
    // 이 영상의 띠가 이미 확정돼 있으면 렌더러의 재측정/초기화 결과는 무시한다
    if (key && barCache.has(key)) return;
    if (key && (x > 0 || y > 0)) barCache.set(key, { x, y });
    if (bars.x === x && bars.y === y) return;
    bars = { x, y };
    if (applied.state === 'RUNNING') scheduleRelayout();
  }

  // RUNNING에서 나갈 때 공통 정리: 렌더 정지, 옵저버 해제, 예약 취소, 띠 초기화, 루트 속성 끄기
  function leaveRunning() {
    renderer.stop();
    bars = { x: 0, y: 0 };   // 돌아올 때 enterRunning이 barCache에서 복원한다
    disconnectObserver();
    cancelRelayout();
    mount.setRootAttr(false);
  }

  // → IDLE: 렌더러 연결 해제, wrapper 제거
  function enterIdle() {
    if (applied.state === 'RUNNING') leaveRunning();
    renderer.detach();
    mount.unmount();
    lastLayout = null;
    applied = emptyApplied();
  }

  // → ARMED: 렌더 정지, wrapper는 있으면 숨김
  function enterArmed(s) {
    if (applied.state === 'RUNNING') leaveRunning();
    mount.setVisible(false);
    applied = { ...applied, state: 'ARMED', player: s.player, video: s.video, parent: s.mountParent };
  }

  // → RUNNING (또는 RUNNING 중 요소 참조가 바뀐 경우의 재연결)
  function enterRunning(s) {
    const parentChanged = applied.parent !== s.mountParent;
    const { canvas } = mount.mount(s.mountParent);

    // 영상이나 canvas가 바뀐 경우에만 renderer를 새로 연결한다 (attach는 내부에서 stop도 한다)
    if (applied.boundVideo !== s.video || applied.boundCanvas !== canvas) renderer.attach(s.video, canvas);
    applied = { state: 'RUNNING', player: s.player, video: s.video, parent: s.mountParent, boundVideo: s.video, boundCanvas: canvas };

    // WebGL을 얻지 못했으면 앰비언트를 켜지 않는다 (<html> 속성이 없으면 영상 페더링 등 화면 변경도 적용되지 않는다)
    if (!renderer.hasGl()) {
      mount.setRootAttr(false);
      mount.setVisible(false);
      return;
    }
    mount.setRootAttr(true);
    mount.setVisible(true);
    const cachedBars = barCache.get(videoKey(s.video));
    if (cachedBars) bars = { ...cachedBars };   // 확정된 띠가 있으면 첫 배치부터 바로 적용한다
    if (parentChanged) lastLayout = null;   // 부모가 바뀌면 좌표 기준이 달라지므로 다시 적용

    observeElements(s.player, s.video);
    cancelRelayout();
    relayout();            // 첫 프레임 전에 배치를 먼저 잡는다
    renderer.start();      // 멱등
  }

  // 현재 상태에 맞게 화면을 맞춘다. 같은 입력이면 아무것도 하지 않는다(멱등)
  function reconcile() {
    if (!started) return;
    const s = store.get();
    const next = deriveRunState(s);

    if (next === 'IDLE') {
      if (applied.state !== 'IDLE') enterIdle();
      return;
    }
    const same = applied.state === next
      && applied.player === s.player
      && applied.video === s.video
      && applied.parent === s.mountParent;
    if (same) return;

    if (next === 'ARMED') enterArmed(s);
    else enterRunning(s);
  }

  // 탭 표시 여부를 store에 알린다
  function onVisibilityChange() {
    store.set({ tabVisible: !doc.hidden });
  }

  // 설정이 바뀐 뒤 화면에 다시 반영한다
  // 이전과 같은 배치로 판정돼 건너뛰는 것을 막기 위해 기억해 둔 배치를 비우고, 실행 중이면 배치를 다시 계산한다
  // resetBars가 true면 검은 띠 측정을 처음부터 다시 한다 (끄면 잘라낸 띠와 확대도 함께 풀린다)
  function refresh({ resetBars = false } = {}) {
    if (resetBars) {
      barCache.clear();
      renderer.resetBars();
    }
    lastLayout = null;
    if (applied.state !== 'RUNNING') return;
    if (renderer.hasGl()) mount.setRootAttr(true);   // --video-feather를 새 값으로 다시 넣는다
    scheduleRelayout();
  }

  // 시작: 구독과 리스너를 등록하고 adapter를 켠다 (멱등)
  function start() {
    if (started) return;
    started = true;
    abort = new AbortController();
    unsubscribe = store.subscribe(reconcile);
    renderer.onBarsChange(handleBars);
    doc.addEventListener('visibilitychange', onVisibilityChange, { signal: abort.signal });
    // 창 크기가 바뀌면 화면 오른쪽 바깥 경계가 달라지므로 배치를 다시 계산한다
    if (doc.defaultView) doc.defaultView.addEventListener('resize', scheduleRelayout, { signal: abort.signal });
    store.set({ tabVisible: !doc.hidden });
    adapter.start();   // 즉시 1회 관측 → onChange → store.set → reconcile
    reconcile();
  }

  // 정지: start에서 만든 것을 모두 해제하고 IDLE로 되돌린다 (멱등)
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

  return { start, stop, refresh };
}
