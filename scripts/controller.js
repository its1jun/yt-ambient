// 상태(store)를 보고 adapter / mount / renderer를 조율하는 상태 머신 (IDLE / ARMED / RUNNING)
import { deriveRunState } from './store.js';
import { layoutEquals } from './layout.js';

// 아무것도 적용하지 않은 처음 상태
function emptyApplied() {
  return { state: 'IDLE', player: null, video: null, parent: null };
}

// 컨트롤러를 만든다. env는 테스트에서 가짜 document/rAF/ResizeObserver를 넣기 위한 선택 인자
export function createController({ adapter, store, mount, renderer, config, computeLayout, env = {} }) {
  const doc = env.doc || document;
  const raf = env.requestAnimationFrame || ((cb) => requestAnimationFrame(cb));
  const caf = env.cancelAnimationFrame || ((id) => cancelAnimationFrame(id));
  const ResizeObserverImpl = env.ResizeObserver || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);

  let started = false;
  let applied = emptyApplied();   // 지금 실제로 적용된 상태 (reconcile이 같은 입력이면 아무것도 안 하게 하는 기준)
  let bound = { video: null, canvas: null };  // renderer에 연결해 둔 요소
  let resizeObserver = null;
  let bars = { x: 0, y: 0 };   // 렌더러가 확정한 검은 띠 크기 (영상 대비 한쪽 %, 0이면 띠 없음)
  let rafId = null;
  let lastLayout = null;
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

  // 레이아웃을 지금 계산해 적용한다. 읽기(rect 3개)를 먼저 모두 하고, 이전과 같으면 아무것도 쓰지 않는다
  function relayout() {
    rafId = null;
    if (applied.state !== 'RUNNING') return;
    const playerRect = applied.player.getBoundingClientRect();
    const videoRect = applied.video.getBoundingClientRect();
    const parentRect = applied.parent.getBoundingClientRect();
    const next = computeLayout({ playerRect, videoRect, parentRect, bars, config });
    if (lastLayout && layoutEquals(lastLayout, next)) return;
    lastLayout = next;
    mount.applyLayout(next);
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
    if (bars.x === x && bars.y === y) return;
    bars = { x, y };
    if (applied.state === 'RUNNING') scheduleRelayout();
  }

  // RUNNING에서 나갈 때 공통 정리: 렌더 정지, 옵저버 해제, 예약 취소, 띠 초기화, 루트 속성 끄기
  function leaveRunning() {
    renderer.stop();
    bars = { x: 0, y: 0 };
    disconnectObserver();
    cancelRelayout();
    mount.setRootAttr(false);
  }

  // → IDLE: 렌더러 연결 해제, wrapper 제거
  function enterIdle() {
    if (applied.state === 'RUNNING') leaveRunning();
    renderer.detach();
    bound = { video: null, canvas: null };
    mount.unmount();
    lastLayout = null;
    applied = emptyApplied();
  }

  // → ARMED: 렌더 정지, wrapper는 있으면 숨김
  function enterArmed(s) {
    if (applied.state === 'RUNNING') leaveRunning();
    mount.setVisible(false);
    applied = { state: 'ARMED', player: s.player, video: s.video, parent: s.mountParent };
  }

  // → RUNNING (또는 RUNNING 중 요소 참조가 바뀐 경우의 재연결)
  function enterRunning(s) {
    const parentChanged = applied.parent !== s.mountParent;
    const { canvas } = mount.mount(s.mountParent);

    // 영상이나 canvas가 바뀐 경우에만 renderer를 새로 연결한다 (attach는 내부에서 stop도 한다)
    if (bound.video !== s.video || bound.canvas !== canvas) {
      renderer.attach(s.video, canvas);
      bound = { video: s.video, canvas };
    }
    applied = { state: 'RUNNING', player: s.player, video: s.video, parent: s.mountParent };

    // WebGL을 얻지 못했으면 앰비언트를 켜지 않는다 (<html> 속성이 없으면 영상 페더링 등 화면 변경도 적용되지 않는다)
    if (!renderer.hasGl()) {
      mount.setRootAttr(false);
      mount.setVisible(false);
      return;
    }
    mount.setRootAttr(true);
    mount.setVisible(true);
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

  // 시작: 구독과 리스너를 등록하고 adapter를 켠다 (멱등)
  function start() {
    if (started) return;
    started = true;
    abort = new AbortController();
    unsubscribe = store.subscribe(reconcile);
    renderer.onBarsChange(handleBars);
    doc.addEventListener('visibilitychange', onVisibilityChange, { signal: abort.signal });
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

  return { start, stop };
}
