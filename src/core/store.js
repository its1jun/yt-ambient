// 앱 전체 상태를 한 곳에 보관하는 저장소 (상태 변경 알림과 "지금 실행해야 하는가" 판정을 담당)

import { CONFIG } from '../config.js';

// 처음 상태: 시청 페이지가 아니며 요소도 없음
const DEFAULT_STATE = Object.freeze({
  isWatchPage: false,
  mode: 'default',        // 'default' | 'theater' | 'fullscreen'
  mountParent: null,
  player: null,
  video: null,
  tabVisible: true,
});

// 상태를 보고 실행 단계를 판정한다 (순수 함수)
// IDLE: 요소가 없거나 시청 페이지가 아님 / ARMED: 준비됐지만 표시 안 함 / RUNNING: 앰비언트 표시
export function deriveRunState(state) {
  if (!state.isWatchPage || !state.mountParent || !state.player || !state.video) return 'IDLE';
  const isAllowedMode = CONFIG.enabledModes.includes(state.mode);
  if (!isAllowedMode || !state.tabVisible) return 'ARMED';
  return 'RUNNING';
}

// 저장소를 만든다. set()은 값이 실제로 바뀐 경우에만 구독자에게 알린다.
export function createStore(initial) {
  let state = Object.freeze({ ...DEFAULT_STATE, ...initial });
  const listeners = new Set();

  // 현재 상태를 돌려준다 (읽기 전용 객체)
  function get() {
    return state;
  }

  // 일부 값을 바꾼다. 하나도 바뀌지 않았으면 알림 없이 끝낸다.
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
    // 알리는 도중 구독 해제된 함수는 건너뛴다
    for (const fn of [...listeners]) {
      if (listeners.has(fn)) fn(state);
    }
  }

  // 상태 변경을 구독한다. 반환값을 호출하면 구독이 해제된다.
  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe에는 함수가 필요합니다');
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  return { get, set, subscribe };
}
