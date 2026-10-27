// 팝업에서 바꾸는 설정값의 단일 창구: 스키마 + 저장/읽기 + 실행 중인 config에 적용
// (팝업과 콘텐츠 스크립트가 같은 파일을 쓴다. 브라우저 저장소를 아는 코드는 createSettings에만 둔다)
//
// 새 설정을 추가하는 방법 (3단계)
//   1) config.js에 기본값을 넣는다 (키 = config.js 안의 경로, 예: 'blurPx', 'zoom.maxScale')
//   2) 아래 SCHEMA에 한 줄을 추가한다
//   3) popup.html의 컨트롤에 data-setting="<키>"를 붙인다 (range는 숫자, checkbox는 true/false)
import { CONFIG } from './config.js';

// 키: config.js 안의 경로 (저장소에도 이 이름 그대로 저장한다)
//   min / max      숫자 설정의 허용 범위 (벗어나면 범위 안으로 맞춘다)
//   values         (선택) 정해진 값만 고를 수 있는 숫자 설정. 팝업에서는 이 값들을 단계로 가진 슬라이더가 된다 (min/max 대신 사용)
//   type:'boolean' 켜고 끄는 설정 (min/max 대신 사용)
//   reflow         (선택) true면 값이 바뀔 때 배치를 다시 계산한다 (배치나 블러 범위를 계산할 때 읽는 값)
//   resetBars      (선택) true면 값이 바뀔 때 검은 띠 측정을 처음부터 다시 한다
export const SCHEMA = Object.freeze({
  blurPx:              { min: 0,  max: 80, reflow: true },
  videoFeatherPercent: { min: 0,  max: 50, reflow: true },
  maxFps:              { values: [12, 15, 30, 60] },               // 매 프레임 읽으므로 바로 반영된다
  layerGapPx:          { min: 24, max: 64, reflow: true },
  fanAngleDeg:         { min: 0,  max: 60, reflow: true },
  'bars.enabled':      { type: 'boolean', resetBars: true },
});

// ===== 경로 읽기/쓰기 ('zoom.maxScale' 같은 점 경로) =====
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o[k], obj);
  parent[last] = value;
}

// ===== 값 검증 =====
// 스키마에 맞는 값이면 (범위 안으로 맞춘 값을) 돌려주고, 아니면 undefined
function sanitizeValue(rule, value) {
  if (rule.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (rule.values) return rule.values.includes(value) ? value : undefined;
  const lo = Number.isFinite(rule.min) ? rule.min : -Infinity;
  const hi = Number.isFinite(rule.max) ? rule.max : Infinity;
  return Math.min(hi, Math.max(lo, value));
}

// 기본값 주변 이 값 이하로 떨어진 값은 기본값으로 붙인다 (슬라이더 한 칸이 값 1보다 커서 기본값에 정확히 맞추기 어려운 것을 보완)
// 예: blur 기본값이 24면 23, 25도 24가 된다
export const SNAP_TOLERANCE = 1;

// 숫자 설정 값이 기본값(config.js)에서 SNAP_TOLERANCE 이내이면 기본값을 돌려준다. 그 밖의 값과 정해진 값 설정(values)은 그대로 돌려준다
export function snap(key, value, config = CONFIG) {
  const rule = SCHEMA[key];
  if (!rule || rule.values || rule.type === 'boolean') return value;
  const base = getPath(config, key);
  return Number.isFinite(base) && Math.abs(value - base) <= SNAP_TOLERANCE ? base : value;
}

// 저장된 객체에서 스키마에 있고 올바른 값만 골라낸다 (알 수 없는 키, 이상한 값은 버림)
export function sanitize(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const key of Object.keys(SCHEMA)) {
    if (!(key in raw)) continue;
    const value = sanitizeValue(SCHEMA[key], raw[key]);
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

// config.js 기본값 위에 저장된 값을 얹은 최종 값 (스키마의 모든 키가 들어 있다)
export function resolve(stored, config = CONFIG) {
  const values = {};
  for (const key of Object.keys(SCHEMA)) values[key] = getPath(config, key);
  return { ...values, ...sanitize(stored) };
}

// ===== 실행 중인 config에 적용 =====
// 얼려 있는 CONFIG의 복사본 (같은 모양, 값만 바꿀 수 있다). 모듈들이 이 객체(와 그 안의 객체)를 참조로 들고 있으므로 제자리에서 값만 갱신한다
export function createLiveConfig(config = CONFIG) {
  return structuredClone(config);
}

// values를 live config에 반영한다. 값이 바뀐 설정이 요구한 후속 작업을 { reflow, resetBars }로 돌려준다
export function applySettings({ live, values }) {
  const effects = { reflow: false, resetBars: false };
  for (const key of Object.keys(SCHEMA)) {
    const value = values[key];
    if (value === undefined || Object.is(getPath(live, key), value)) continue;
    setPath(live, key, value);
    if (SCHEMA[key].reflow) effects.reflow = true;
    if (SCHEMA[key].resetBars) effects.resetBars = true;
  }
  return effects;
}

// ===== 저장소 =====
// env는 테스트에서 가짜 chrome 저장소를 넣기 위한 선택 인자
export function createSettings({ config = CONFIG, env = {} } = {}) {
  const area = env.storage || chrome.storage.local;
  const changeEvent = env.onChanged || chrome.storage.onChanged;
  const storageKey = config.settingsKey;

  let overrides = {};   // 사용자가 바꾼 값만 (기본값과 같아도 바꾼 적이 있으면 들어 있다)

  // 저장된 값을 읽어 최종 값을 돌려준다 (읽기에 실패해도 던지지 않고 기본값을 돌려준다)
  async function load() {
    try {
      const result = await area.get(storageKey);
      overrides = sanitize(result[storageKey]);
    } catch {
      overrides = {};
    }
    return resolve(overrides, config);
  }

  // 값 하나를 저장한다. 스키마에 없는 키나 이상한 값은 무시한다
  async function save(key, value) {
    const rule = SCHEMA[key];
    if (!rule) return;
    const clean = sanitizeValue(rule, value);
    if (clean === undefined) return;
    overrides = { ...overrides, [key]: clean };
    try {
      await area.set({ [storageKey]: overrides });
    } catch {
      // 저장에 실패해도 화면 동작은 막지 않는다
    }
  }

  // 저장된 값을 모두 지운다 → 기본값(config.js)으로 돌아간다
  async function reset() {
    overrides = {};
    try {
      await area.remove(storageKey);
    } catch {
      // 지우기에 실패해도 화면 동작은 막지 않는다
    }
    return resolve(overrides, config);
  }

  // 다른 곳(팝업, 다른 탭)에서 저장이 바뀌면 최종 값을 넘겨받는다. 반환값을 호출하면 구독이 해제된다
  function onChange(callback) {
    const listener = (changes, areaName) => {
      if (areaName !== 'local' || !changes[storageKey]) return;
      overrides = sanitize(changes[storageKey].newValue);
      callback(resolve(overrides, config));
    };
    changeEvent.addListener(listener);
    return () => changeEvent.removeListener(listener);
  }

  return { load, save, reset, onChange };
}
