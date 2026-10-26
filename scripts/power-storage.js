// 기능 전원 상태를 chrome.storage에서 읽어 store에 넣고, 팝업에서 바뀌면 따라가는 모듈
// (브라우저 저장소를 아는 코드는 이 파일에만 둔다)

// 전원 저장소 연결을 만든다. env는 테스트에서 가짜 chrome 저장소를 넣기 위한 선택 인자
export function createPowerStorage({ store, config, env = {} }) {
  const area = env.storage || chrome.storage.local;
  const changeEvent = env.onChanged || chrome.storage.onChanged;
  const key = config.power.storageKey;

  let started = false;
  let synced = false;      // 변경 알림이나 첫 읽기로 값을 이미 반영했는지 (늦게 도착한 옛 값이 덮어쓰지 않게 함)
  let listener = null;

  // 저장된 값을 true/false로 바꾼다 (값이 없거나 이상하면 기본값)
  function toPower(value) {
    return typeof value === 'boolean' ? value : config.power.defaultOn;
  }

  // 시작: 변경 알림을 구독하고 저장된 값을 한 번 읽어 store에 넣는다 (멱등)
  function start() {
    if (started) return;
    started = true;
    synced = false;

    // 팝업에서 전원을 바꾸면 알림이 와서 바로 반영한다
    listener = (changes, areaName) => {
      if (areaName !== 'local' || !changes[key]) return;
      synced = true;
      store.set({ powerOn: toPower(changes[key].newValue) });
    };
    changeEvent.addListener(listener);

    area.get(key).then((result) => {
      if (!started || synced) return;
      synced = true;
      store.set({ powerOn: toPower(result[key]) });
    }).catch(() => {
      // 읽기에 실패하면 기본값으로 둔다
      if (started && !synced) store.set({ powerOn: config.power.defaultOn });
    });
  }

  // 정지: 구독을 해제한다 (멱등)
  function stop() {
    if (!started) return;
    started = false;
    if (listener) changeEvent.removeListener(listener);
    listener = null;
  }

  return { start, stop };
}
