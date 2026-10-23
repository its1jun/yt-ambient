# Ambient Light for YouTube — 설계 문서 (ARCHITECTURE)

> 상태: **현재 구조**. `src/`가 실제 동작 코드이고 `npm run build`로 `dist/content.js`를 만든다. 레거시(`js/`, `css/`)는 삭제됐다. 작업 순서와 완료 기준은 `docs/HANDOFF.md`, 진행 상황은 `docs/PROGRESS.md`, 확인 결과는 `docs/VERIFICATION.md`를 본다.

## 3. 설계

### 3-1. 원칙

1. 상태는 `store` 한 곳에만 둔다. 나머지는 파생.
2. "지금 돌아야 하는가"는 순수 함수 `deriveRunState(state)` 하나로 판정한다.
3. 모든 start에는 짝이 되는 stop이 있다. 리스너는 `AbortController` signal로 일괄 해제.
4. YouTube를 아는 코드(선택자, 이벤트명, 모드 판독)는 `src/yt/`에만 둔다.
5. 계산(순수)과 부수효과(DOM)를 분리한다. 레이아웃 계산은 DOM 없이 테스트한다.
6. 폴링 금지. 재시도는 횟수 제한된 백오프만.
7. 꺼진 상태의 비용은 0 (리스너/옵저버/프레임 콜백 모두 해제).

### 3-2. 모듈 구성

```text
src/
  main.js              진입점: 중복 주입 가드, 모듈 생성, controller.start()
  config.js            모든 기본값의 단일 출처
  yt/selectors.js      선택자/속성명 상수 전부
  yt/adapter.js        YouTube 사실(facts) 관측 → onChange 콜백
  core/store.js        상태 보관 + deriveRunState (순수)
  core/layout.js       computeLayout (순수)
  core/controller.js   reconcile 상태 머신, 옵저버/렌더러/마운트 조율
  render/renderer.js   단일 canvas 렌더 루프 (YouTube 모름)
  dom/mount.js         wrapper+canvas 생성/제거, 스타일 적용(diff), 루트 속성 토글
  styles/ambient.css
  styles/yt-overrides.css   모든 규칙이 html[data-yt-ambient="on"] 하위로 스코프됨
docs/                  ARCHITECTURE / HANDOFF / PROGRESS / VERIFICATION / BASELINE / TEST_CHECKLIST
manifest.json          dist/content.js + src/styles/*.css 로드
```

### 3-3. 실행 상태 머신 (controller가 소유)

| 상태 | 조건 (store 기준) | 살아 있는 것 |
| --- | --- | --- |
| `IDLE` | `!isWatchPage` 또는 `player/video/mountParent` 중 하나라도 null | adapter의 `yt-navigate-finish` 리스너 등 최소한 |
| `ARMED` | 요소 모두 있음 이고 (`mode==='default'` 또는 `!tabVisible`) | adapter 모드 관측. wrapper는 있으면 `display:none` |
| `RUNNING` | 요소 모두 있음 이고 `mode!=='default'` 이고 `tabVisible` | + ResizeObserver, 렌더 루프, wrapper 표시, 루트 속성 ON |

- **일시정지(FROZEN)는 컨트롤러 상태가 아니라 renderer 내부 동작**이다: `pause` 시 rVFC 재등록 중단, `play` 시 재개, `seeked` 시 1프레임 갱신.
- 전이 시 동작:
  - `→IDLE`: renderer.stop+detach, RO disconnect, 루트 속성 OFF, mount.unmount
  - `→ARMED`: renderer.stop, RO disconnect, 루트 속성 OFF, wrapper 숨김(있으면)
  - `→RUNNING`: (없으면)mount, 루트 속성 ON, 표시, (video 바뀌었으면)attach, RO observe, relayout, renderer.start
- `reconcile()`는 **멱등**: `applied = { state, player, video, parent }` 스냅샷과 비교해 같으면 아무것도 안 한다. RUNNING 중 player/video 요소 참조가 바뀌면 재바인딩한다.

### 3-3b. 설계 결정(확정)

| 항목 | 결정 |
| --- | --- |
| 빌드 | esbuild 번들 (`src/` ES modules → `dist/content.js`). CSS는 번들하지 않고 manifest가 `src/styles/*.css`를 직접 로드 |
| 적용 범위 | `location.pathname === '/watch'`의 극장/전체화면만. Shorts/임베드/미니플레이어 제외 |
| fps 상한 | 기본 30 (`config.maxFps`) |
| 시각 결과 | 현재와 **동일하게 유지**. 변경은 내부 구조/비용에 한정 |
| rVFC | 필수로 가정(폴백 rAF 없음). 미지원이면 동작하지 않고 `console.warn` 1회 |
| scroll 리스너 | 기본 **없음**. VERIFICATION의 V4가 "필요"로 확정되면 RUNNING 중에만 rAF 병합 형태로 추가 |
| 설정 단일 출처 | JS `config.js`. wrapper에 CSS 변수(`--ambient-blur` 등)로 주입. `variables.css`는 제거됨 |

### 3-4. 단일 canvas 렌더링 (레거시 시각 효과 재현 방식)

**canvas 1개**에 바깥 층부터 안쪽 층 순으로 `drawImage(capture → canvas)`를 N회 그린다. i번째 층 = **영상 박스를 사방으로 **`layerGapPx × i`** px씩 넓힌 박스**. 그래서 계단 한 칸의 폭은 영상 크기와 방향(가로/세로)에 상관없이 항상 `layerGapPx`이다. (이전 방식은 영상 크기 × `scaleStep` 비율로 키워서 영상이 클수록, 가로가 세로보다 계단이 넓었다.)

- canvas의 CSS 박스(`canvasBox`) = **플레이어 박스 ∪ 가장 바깥 층 박스**의 외접 사각형. 플레이어 박스 기준 상대 좌표이며 음수 오프셋이 가능하다.
- 층 개수는 영상 박스가 플레이어 안쪽으로 떨어진 거리(왼/오/위/아래) 중 가장 큰 값으로 정한다: `N = min(40, max(1, ceil(가장 큰 거리 / layerGapPx)))`. (덮을 수 있는 최대 거리 = `40 × layerGapPx`)
- 가장자리 투명 폭은 `edgeFeatherPx`(px)이며, `computeLayout`이 영상 크기 대비 비율(`feather.x`, `feather.y`)로 바꿔 renderer에 넘긴다. 투명 처리는 capture 이미지에 한 번만 하므로 바깥 층일수록 화면에서는 조금 더 넓어진다.
- blur/saturate는 canvas 요소(또는 wrapper)에 CSS `filter`로 1회 적용.

---

## 4. 모듈 계약 (변경 금지)

모든 모듈은 ES module, `export function createXxx(...)` 형태의 팩토리. 모듈 최상위 가변 상태 금지.

### 4-1. `config.js`

```js
export const CONFIG = Object.freeze({
  blurPx: 20,
  saturate: 1.4,
  layerGapPx: 40,         // 층 하나가 사방으로 넓어지는 폭 (CSS px)
  maxFps: 30,
  captureLongSide: 256,   // 영상 샘플링 canvas 긴 변
  canvasLongSide: 256,    // 앰비언트 canvas 내부 해상도 긴 변
  edgeFeatherPx: 40,      // 층 가장자리가 투명해지는 폭 (CSS px, 0 이하면 끔)
  drmErrorLimit: 3,       // 연속 drawImage 예외 허용 횟수
  retry: { maxAttempts: 10, intervalMs: 300 },
  wrapperId: 'ambient-light-wrapper',
  rootAttr: 'data-yt-ambient',   // 값 'on' | 없음
  debug: false,
});
```

### 4-2. `yt/selectors.js`

```js
export const SEL = Object.freeze({
  mountParent: '#content.ytd-app',
  watchRoot:   'ytd-watch-flexy, ytd-watch-fixie, ytd-watch-grid',
  player:      '#movie_player',            // Uncertain: V5로 확인. 실패 시 watchRoot 내부 '.html5-video-player'로 대체
  video:       'video.html5-main-video',
  modeAttrs:   ['theater', 'full-bleed-player'],
  watchPath:   '/watch',
});
```

선택자는 **watchRoot 하위에서 탐색**한다(문서 전역 `.html5-video-player` 금지).

### 4-3. `yt/adapter.js`

```js
// Facts: YouTube에서 관측한 사실. 판단(표시 여부)은 하지 않는다.
// {
//   isWatchPage: boolean,
//   mode: 'default' | 'theater' | 'fullscreen',   // fullscreen 우선, 그다음 theater
//   mountParent: Element | null,
//   player: Element | null,
//   video: HTMLVideoElement | null,
// }
export function createAdapter({ onChange /* (facts) => void */, config, selectors }): {
  start(): void,      // 리스너/옵저버 등록, 즉시 1회 refresh
  stop(): void,       // 전부 해제(AbortController, MutationObserver, 재시도 타이머)
  getFacts(): Facts,
}
```

- 구독: `yt-navigate-finish`, `fullscreenchange`, watchRoot 속성 MutationObserver(`SEL.modeAttrs` 필터; watchRoot 요소가 바뀌면 재연결).
- 요소가 비어 있고 `isWatchPage`이면 `config.retry`만큼만 재시도 후 포기. 다음 `yt-navigate-finish`에서 재시도 카운터 리셋.
- facts가 **이전과 얕은 비교로 동일하면 **`onChange`**를 호출하지 않는다.**
- `start()` 중복 호출은 무시(멱등).
- 구현 메모: `createAdapter`는 테스트용 선택 인자 `env`(`{ doc, getPathname, MutationObserver }`)를 받는다. `readMode`, `readFacts`, `factsEqual`을 추가로 export한다. 시청 페이지가 아니면 요소를 조회하지 않는다.

### 4-4. `core/store.js`

```js
// state = { ...Facts, tabVisible: boolean }
export function createStore(initial): {
  get(): State,
  set(partial): void,                 // 얕은 비교로 변경 없으면 notify 안 함
  subscribe(fn): () => void,          // unsubscribe 반환
}
export function deriveRunState(state): 'IDLE' | 'ARMED' | 'RUNNING'   // 순수 함수. §3-3 표 그대로
```

### 4-5. `core/layout.js` (순수, DOM 접근 금지)

```js
// Rect = { left, top, width, height }  (뷰포트 기준 getBoundingClientRect 값)
export function computeLayout({ playerRect, videoRect, parentRect, config }): Layout
// Layout = {
//   valid: boolean,                       // video/player 크기가 0이거나 NaN이면 false (나머지 필드 무의미)
//   wrapperBox: Rect,                     // mountParent 기준 상대 좌표. 플레이어 박스와 일치
//   canvasBox: Rect,                      // wrapper 기준 상대 좌표. 플레이어 ∪ 최대 레이어 박스 (음수 가능)
//   canvasPx: { width, height },          // 내부 해상도 (긴 변 = config.canvasLongSide, 비율 = canvasBox 비율)
//   captureSize: { width, height },       // 영상 샘플링 크기 (긴 변 = config.captureLongSide, 영상 비율)
//   feather: { x, y },                    // 가장자리 투명 폭 (영상 크기 대비 비율, 0~0.5. config.edgeFeatherPx에서 환산)
//   draws: Array<{ dx, dy, dw, dh }>,     // canvasPx 좌표계. 바깥 층 → 안쪽 층 순서(painter's)
// }
export function layoutEquals(a, b): boolean   // 동일하면 DOM/렌더러 갱신 생략용
```

- 층 목록: `N = min(40, max(1, ceil(가장 큰 거리 / layerGapPx)))`, i번째 층 = 영상 박스를 사방으로 `layerGapPx × i` px 넓힌 박스 (i = 1..N).
- 구현 메모: N에는 안전 상한 40이 있고, `layoutEquals`는 0.01px 이내 오차를 같은 값으로 본다(`feather` 비율은 0.0001 이내). `valid:false`일 때 `draws`는 빈 배열이다.

### 4-6. `dom/mount.js`

```js
export function createMount({ config }): {
  mount(parent: Element): { wrapper: HTMLElement, canvas: HTMLCanvasElement },  // 이미 있으면 기존 반환(멱등)
  applyLayout(layout): void,     // 변경된 스타일만 씀(이전 값 캐시와 비교)
  setVisible(v: boolean): void,  // display 토글
  setRootAttr(on: boolean): void,// <html data-yt-ambient="on"> 설정/제거
  unmount(): void,               // wrapper 제거, 참조 해제
  getCanvas(): HTMLCanvasElement | null,
}
```

- wrapper에 CSS 변수 `--ambient-blur`, `--ambient-saturate`를 `config`에서 주입. `pointer-events:none`, `z-index:-1`.
- 구현 메모: `env.doc`(테스트용 선택 인자)를 받는다. wrapper는 **처음에 `display:none`**이며 controller가 `setVisible(true)`로 보여 준다. 같은 id의 이전 wrapper가 있으면 지운다. `position`/`filter`는 `styles/ambient.css`가 담당한다. `unmount()`는 `<html>` 속성을 건드리지 않는다.

### 4-7. `render/renderer.js` (YouTube를 모른다)

```js
export function createRenderer({ config }): {
  attach(video: HTMLVideoElement, canvas: HTMLCanvasElement): void,  // 이전 attach가 있으면 먼저 detach
  setLayout(layout): void,       // captureSize/canvasPx/draws 반영. 크기가 바뀔 때만 canvas.width/height 대입
  start(): void,                 // rVFC 루프 시작(멱등). 재생 중이면 즉시 1프레임
  stop(): void,                  // cancelVideoFrameCallback, 미디어 이벤트 해제(멱등)
  detach(): void,
  destroy(): void,
}
export function shouldDrawFrame(nowMs, lastDrawMs, maxFps): boolean   // 순수. 테스트 대상
```

- 프레임당: `drawImage(video → captureCanvas)` 1회 → `canvas.clear` 후 `layout.draws`를 순서대로 `drawImage(captureCanvas → canvas, dx,dy,dw,dh)`.
- `maxFps` 초과 프레임은 건너뛴다(콜백은 계속 재등록하되 draw만 생략).
- 미디어 이벤트: `play`(재개), `pause`(재등록 중단), `seeked`(일시정지 상태면 1프레임 갱신), `emptied`/`loadstart`(레이아웃 재계산은 controller 몫이므로 여기선 무시).
- `drawImage` 예외가 `config.drmErrorLimit`회 연속이면 해당 video에 대해 **루프 중단**하고 `console.debug` 1회. 새 `attach` 시 카운터 리셋. (DRM이 예외가 아니라 **검은 프레임**일 수 있음 → V2, Uncertain)
- `visibilitychange`/표시 판단은 하지 않는다(controller가 start/stop으로 제어).
- 구현 메모: `env`(`createCanvas`, `now`, `logger`)는 테스트용 선택 인자. `detach()`는 `stop()`을 포함하므로 `attach()` 뒤에는 `start()`를 다시 불러야 한다. `start()`는 일시정지 상태여도 1프레임을 그리고, `setLayout()`은 실행 중이면 바로 다시 그린다. `shouldDrawFrame`은 지터 여유 2ms를 두며 `maxFps<=0`은 제한 없음, `lastDrawMs<=0`은 처음을 뜻한다. 연속 실패로 중단되면 새 `attach()` 전까지 `start()`를 무시한다.

### 4-8. `core/controller.js`

```js
export function createController({ adapter, store, mount, renderer, config, computeLayout }): {
  start(): void,   // adapter.start(), store.subscribe(reconcile), visibilitychange 리스너
  stop(): void,    // 전부 해제 후 IDLE 전이
}
```

- `onChange(facts)` → `store.set(facts)`. `visibilitychange` → `store.set({ tabVisible: !document.hidden })`.
- `relayout()`은 **rAF로 병합**. 읽기(rect 3개)를 먼저 모두 수행 → `computeLayout` → `layoutEquals`로 비교 → 변경 시에만 `mount.applyLayout` + `renderer.setLayout`.
- ResizeObserver는 RUNNING일 때만 `player`와 `video`를 observe한다. (RO 초기 콜백은 상태 진입 시 1회뿐이므로 허용.)
- 구현 메모: `env`(`doc`, `requestAnimationFrame`, `cancelAnimationFrame`, `ResizeObserver`)는 테스트용 선택 인자. RUNNING 진입 시 `renderer.start()` 전에 `relayout()`을 동기로 1회 실행한다.

### 4-9. `main.js`

```js
// 중복 주입 가드: if (window.__ytAmbientBooted) return; window.__ytAmbientBooted = true;
// store, adapter, mount, renderer, controller 생성 → controller.start()
```

---

## 7. 불변식 (모든 Phase에서 유지)

1. 앰비언트는 영상의 복제본이며 영상 위에 오버레이하지 않는다. 영상 품질/컨트롤에 영향 없음.
2. YouTube의 DOM 구조/크기를 바꾸지 않는다. 추가하는 것은 `mountParent` 안의 wrapper 하나와 `<html>`의 속성 하나뿐.
3. "보여야 하는가"는 `deriveRunState`만 판단한다.
4. 비표시(IDLE/ARMED) 상태의 비용은 0에 수렴해야 한다(옵저버/프레임 콜백 없음).
5. 레이아웃을 바꾸는 CSS는 앰비언트 CSS에만, YouTube 오버라이드는 **투명화/숨김만** 담당한다.

---

## 8. 알려진 제약 / 미확정 (Uncertain)

- **V1~V7 대부분 **`Unverified`: 전체화면 시 mountParent 표시, DRM 영상 동작(예외인지 검은 프레임인지), scroll 리스너 필요 여부, `#movie_player` 존재 등은 `docs/VERIFICATION.md`에 사람이 확인한 결과만 근거로 삼는다.
- scroll 리스너는 없다. 스크롤 시 wrapper가 어긋나면 V4를 "필요"로 기록하고 RUNNING 중에만 rAF 병합 리스너를 추가한다.
- 앰비언트 canvas는 `alpha:false`라서, 가장 큰 배율 박스가 플레이어를 덮지 못하는 배치에서는 빈 영역이 검게 보일 수 있다.
- adapter는 페이지 이동 없이 `<video>` 요소만 교체되는 경우를 즉시 알아채지 못할 수 있다.
- `yt-overrides.css` 선택자의 필요 여부 분류는 추정이다 (V8 표).
- fps 제한의 실제 체감 값, 튜닝 후보(`maxFps`, 해상도, blur)의 채택은 사람이 측정/육안 확인한 뒤 `config.js`에 반영한다.
