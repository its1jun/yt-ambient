# Ambient Light for YouTube — 설계 문서 (ARCHITECTURE)

> 상태: **현재 구조**. `scripts/`가 실제 동작 코드이고 `npm run build`로 `dist/content.js`를 만든다. 레거시(`js/`, `css/`)는 삭제됐다. 작업 순서와 완료 기준은 `docs/HANDOFF.md`, 확인 결과는 `docs/VERIFICATION.md`를 본다.
> 문서와 코드가 다르면 **코드가 사실**이다.

## 3. 설계

### 3-1. 원칙

1. 상태는 `store` 한 곳에만 둔다. 나머지는 파생.
2. "지금 돌아야 하는가"는 순수 함수 `deriveRunState(state)` 하나로 판정한다.
3. 모든 start에는 짝이 되는 stop이 있다. 리스너는 `AbortController` signal로 일괄 해제.
4. YouTube를 아는 코드(선택자, 이벤트명, 모드 판독)는 `scripts/selectors.js`와 `scripts/adapter.js`에만 둔다. `renderer`는 YouTube를 모른다.
5. 계산(순수)과 부수효과(DOM, GPU)를 분리한다. 레이아웃 계산(`computeLayout`)은 DOM 없이 숫자만으로 돌아간다.
6. 폴링 금지. 재시도는 횟수가 제한된 것만 허용한다 (`config.retry`).
7. 꺼진 상태의 비용은 0에 가깝다 (옵저버, 프레임 콜백 모두 해제).
8. 숫자 설정값은 `config.js`가 단일 출처다. 다른 파일에 새 숫자를 직접 쓰지 않는다.
9. 모듈은 `createXxx(...)` 팩토리 함수 형태이며, 모듈 최상위에 바뀌는 상태를 두지 않는다.

### 3-2. 모듈 구성

```text
scripts/
  main.js            진입점: 중복 실행 가드, 모듈 생성, controller.start()
  config.js          모든 설정값의 단일 출처
  selectors.js       YouTube 선택자/속성명 상수 전부
  adapter.js         YouTube 사실(facts) 관측 → onChange 콜백
  store.js           상태 보관 + deriveRunState (순수)
  layout.js          computeLayout, layoutEquals (순수)
  controller.js      reconcile 상태 머신, 옵저버/렌더러/마운트 조율
  mount.js           wrapper+canvas 생성/제거, 스타일 적용(diff), 루트 속성 토글, 띠 CSS 변수
  renderer.js        프레임 루프: fps 제한, 재생/일시정지/시크, 연속 오류 중단 (YouTube 모름)
  gl-pipeline.js     WebGL 자원, 그리기 4단계, 컨텍스트 유실/복구
  shaders.js         셰이더(GLSL) 문자열과 셰이더 상수만
  letterbox.js       검은 띠 분석(순수) + 측정 + 안정화
styles/
  ambient.css        wrapper 스타일, 영상 가장자리 페더링, 띠 clip
  yt-overrides.css   YouTube 배경 투명화/숨김. 모든 규칙이 html[data-yt-ambient="on"] 하위로 스코프됨
docs/                ARCHITECTURE / HANDOFF / VERIFICATION
manifest.json        dist/content.js + styles/*.css 로드
package.json         빌드 스크립트 (esbuild)
```

### 3-3. 실행 상태 머신 (controller가 소유)

| 상태 | 조건 (store 기준) | 살아 있는 것 |
| --- | --- | --- |
| `IDLE` | `!isWatchPage` 또는 `player/video/mountParent` 중 하나라도 null | adapter의 관측만 (`yt-navigate-finish`, `fullscreenchange` 리스너, watchRoot 속성 MutationObserver) |
| `ARMED` | 요소 모두 있음 이고 (`mode`가 `config.enabledModes`에 없음 또는 `!tabVisible`) | adapter 관측. renderer는 정지하지만 연결과 GPU 자원은 유지. wrapper는 있으면 `display:none` |
| `RUNNING` | 요소 모두 있음 이고 `mode`가 `config.enabledModes`에 있음 이고 `tabVisible` | + ResizeObserver, 렌더 루프, wrapper 표시, 루트 속성 ON |

- `config.enabledModes` 기본값은 `['theater']`다. 그래서 기본 모드와 전체화면에서는 `ARMED`다. (화면 모드 판독 코드 자체는 `default`/`theater`/`fullscreen` 셋 다 유지한다.)
- `deriveRunState`는 `store.js`에서 `CONFIG`를 직접 읽어 판정한다.
- **일시정지(FROZEN)는 컨트롤러 상태가 아니라 renderer 내부 동작**이다: `pause` 시 프레임 콜백 예약 취소, `play` 시 재개, `seeked` 시 일시정지 상태면 1프레임 갱신.
- 전이 시 동작:
  - `→IDLE`: (RUNNING에서 왔으면 아래 "RUNNING 나가기" 먼저) renderer.detach, mount.unmount, 마지막 배치 기록 초기화, 적용 기록 초기화
  - `→ARMED`: (RUNNING에서 왔으면 아래 "RUNNING 나가기" 먼저) wrapper 숨김. renderer 연결과 GPU 자원은 유지
  - `→RUNNING`: wrapper 마운트 → (영상/canvas가 바뀌었을 때만) renderer.attach → **WebGL을 얻지 못했으면 앰비언트를 켜지 않고 루트 속성 OFF, wrapper 숨김 후 끝** → 루트 속성 ON, 표시 → (부모가 바뀌었으면 마지막 배치 기록 초기화) → RO observe → `relayout()` 동기 1회 → renderer.start
  - **RUNNING 나가기**(IDLE/ARMED로 갈 때 공통): renderer.stop, 띠 크기 0으로 초기화, RO disconnect, 예약된 relayout 취소, 루트 속성 OFF
- `reconcile()`은 **멱등**: `applied = { state, player, video, parent, boundVideo, boundCanvas }` 기록과 비교해 (state, player, video, parent가) 같으면 아무것도 안 한다. RUNNING 중 player/video 요소 참조가 바뀌면 다시 연결한다.
  - `boundVideo`/`boundCanvas`는 renderer에 연결해 둔 요소다. ARMED로 가도 유지되고 IDLE로 갈 때만 비운다. 그래서 ARMED 중에 영상이 바뀌어도 `video`와 `boundVideo`는 다를 수 있고, RUNNING으로 돌아올 때 다를 때만 다시 attach한다.

### 3-3b. 설계 결정(확정)

| 항목 | 결정 |
| --- | --- |
| 빌드 | esbuild 번들 (`scripts/main.js` → `dist/content.js`, `--target=es2022`). CSS는 번들하지 않고 manifest가 `styles/*.css`를 직접 로드 |
| 적용 범위 | 주소 경로가 `/watch`인 시청 페이지에서만 동작한다. Shorts(`/shorts/...`)와 임베드(`/embed/...`)는 경로가 달라 제외된다. 미니플레이어는 경로로 가리지 않는다 (Uncertain). 화면 모드는 `config.enabledModes`(기본 `['theater']`)로 정한다 |
| fps 상한 | 기본 15 (`config.maxFps`). 0 이하면 제한 없음 |
| 시각 결과 | 구조 정리는 화면 결과를 **그대로 유지**한다 (색, 블러, 계단 폭, 가장자리 투명도, 성능 특성) |
| rVFC | 필수로 가정(폴백 rAF 없음). 미지원이면 동작하지 않고 `console.warn` 1회 |
| scroll 리스너 | 기본 **없음**. VERIFICATION의 V4가 "필요"로 확정되면 RUNNING 중에만 rAF 병합 형태로 추가 |
| 설정 단일 출처 | JS `config.js`. CSS가 필요한 값은 `<html>`의 CSS 변수로 넣는다 (`--video-feather`, `--ambient-clip-inset-x`, `--ambient-clip-inset-y`) |
| 그리기 4단계 | 축소(capture) → 층 합성(composite) → 가로 블러 → 세로 블러. 이 확장의 화면 모습 자체이므로 알고리즘을 바꾸지 않는다 |
| 부채꼴 샘플링 | 유지 (`fanAngleDeg` 기본 15). 층의 색을 중심에서 ±각도 안에서 여러 곳 읽어 평균내어 방사형 줄무늬를 흐린다. 0이면 끈다 |
| 검은 띠 자동 제거 | 유지. `letterbox.js`가 담당한다 (§3-5) |
| `yt-overrides.css` 선택자 | 삭제 금지. 필요 여부가 모두 미확인이다 (V8) |

### 3-4. 단일 canvas 렌더링

**canvas 1개**에 바깥 층부터 안쪽 층 순으로 capture 텍스처를 N개 층으로 합성한다(WebGL2, 화면 전체 사각형 1장을 그리고 층 계산은 셰이더가 픽셀마다 한다). i번째 층 = **띠를 뺀 영상 영역을 사방으로 `layerGapPx × i` px씩 넓힌 박스**. 그래서 계단 한 칸의 폭은 영상 크기와 방향(가로/세로)에 상관없이 항상 `layerGapPx`이다. (검은 띠가 없으면 띠를 뺀 영역은 영상 박스와 같다.)

- canvas의 CSS 박스(`canvasBox`) = **플레이어 박스 ∪ 가장 바깥 층 박스**의 외접 사각형. 플레이어 박스 기준 상대 좌표이며 음수 오프셋이 가능하다.
- 층 개수는 영역이 플레이어 안쪽으로 떨어진 거리(왼/오/위/아래) 중 가장 큰 값으로 정한다: `N = min(maxLayers, max(1, ceil(가장 큰 거리 / layerGapPx − 0.0001)) + 1)`. 맨 끝의 `+1`은 여분의 한 층이다. `maxLayers`(기본 40)는 `config.js`에만 있고, 셰이더의 층 배열 크기도 이 값으로 정해진다.
- 가장자리 투명 폭은 `layerGapPx`와 같은 px이며, `computeLayout`이 띠를 뺀 영역 크기 대비 비율(`feather.x`, `feather.y`, 0~0.5)로 바꿔 renderer에 넘긴다. 투명 처리는 층마다 셰이더가 자기 사각형 가장자리에서 하며, 바깥 층일수록 화면에서는 조금 더 넓어진다.
- 그리기 4단계 (매 프레임):
  1. **capture**: 영상 프레임을 `videoTexture`에 올리고(mipmap은 만들지 않는다), `captureSize` 크기의 `captureTexture`에 격자 평균으로 줄여 옮긴다.
  2. **composite**: 화면 전체 사각형 1장으로 모든 층을 합성해 `sceneTexture`에 그린다. 안쪽 층부터 앞→뒤로 쌓고 불투명해지면 바깥 층 읽기를 건너뛴다. 읽는 영역은 `layout.crop`(띠를 뺀 영역)이다.
  3. **가로 블러**: `sceneTexture` → `blurTexture`. 표준편차 = `blurPx × (canvasPx.width / canvasBox.width)` (canvas 내부 px).
  4. **세로 블러**: `blurTexture` → canvas. 채도(`saturate`)는 이 마지막 패스에서 한 번만 적용한다.
- 블러와 채도는 CSS `filter`가 아니라 셰이더가 처리한다.
- 원본 영상(`.html5-main-video`)의 가장자리는 CSS 마스크로 부드럽게 투명화한다 (`styles/ambient.css`, 폭은 `videoFeatherPercent`).

### 3-5. 검은 띠(레터박스) 흐름

한 번 확정되면 이후 측정하지 않는다. 값은 아래 순서로 한 바퀴 돈다.

1. `renderer`가 그리기에 성공할 때마다 `detector.sample(video, stamp)`를 부른다. 확정 전에만 실제로 측정한다 (`measureIntervalMs` 간격, 첫 측정은 바로).
2. `letterbox.js`가 영상 세로 스캔라인 `scanColumns`개를 작은 2D canvas로 읽어 `analyzeBarStrip`으로 띠 크기를 구하고, `createBarStabilizer`가 같은 값(오차 `stableTolerance` 이내)이 `stableCount`번 연속이면 확정한다. 확정되면 `{ x: 0, y: 확정값 }`(영상 대비 한쪽 %)을 알리고 측정용 canvas를 버린다.
3. 알림은 `renderer.onBarsChange`에 등록된 함수로 간다. `controller.handleBars`가 값을 보관하고 RUNNING이면 `relayout`을 예약한다.
4. `computeLayout({ ..., bars })`가 띠를 뺀 영역 기준으로 층/가장자리 투명 폭/`crop`을 계산하고 `layout.bars`에 정리한 띠 크기를 담는다.
5. `mount.applyLayout`이 `<html>`에 `--ambient-clip-inset-x`, `--ambient-clip-inset-y`를 쓴다. `ambient.css`가 이 두 변수로 영상 `clip-path`(띠를 잘라냄)와 영상 가장자리 페더링 시작 위치를 정한다. 띠가 없으면 변수를 지우고, 이때 `clip-path`는 적용되지 않는다.
6. `renderer.setLayout`이 `crop`을 GPU로 넘겨 앰비언트가 띠를 뺀 영역만 읽게 한다.

- 새 영상(`loadstart`/`emptied`), `attach`, `start` 때는 처음부터 다시 측정하고 `{ x: 0, y: 0 }`을 알린다. RUNNING에서 나갈 때 controller도 띠 값을 0으로 되돌린다.
- 화면 전체가 검거나(`black`) 띠가 너무 큰(`tooBig`) 측정은 버리고 계속한다. 읽을 수 없는 영상(DRM 등)에서 `drawImage`/`getImageData` 예외가 나면 이번 측정만 건너뛴다 (그리기 오류 횟수에 넣지 않는다).
- `bars.enabled: false`이면 측정하지 않는다.

---

## 4. 모듈 계약

모든 모듈은 ES module, `export function createXxx(...)` 형태의 팩토리(순수 계산 함수 제외). 모듈 최상위 가변 상태 금지. 아래 `env`는 외부 객체(document, 시계, 로그 등)를 바꿔 끼우기 위한 **선택 인자**다.

### 4-1. `config.js`

```js
export const CONFIG = Object.freeze({
  blurPx: 24,              // 흐림 정도 (CSS px)
  saturate: 1.0,           // 채도 배율 (1 = 원본)
  videoFeatherPercent: 20, // 원본 영상 가장자리 페더링 폭 (%)
  maxFps: 15,              // 초당 그리기 상한 (0 이하면 제한 없음)
  layerGapPx: 48,          // 층 하나가 사방으로 넓어지는 폭 (CSS px). 가장자리 투명 폭도 같은 값
  captureLongSide: 192,    // 영상 샘플링 canvas의 긴 변 (px)
  canvasLongSide: 288,     // 앰비언트 canvas 내부 해상도의 긴 변 (px)
  maxLayers: 40,           // 층 수 상한. 셰이더의 층 배열 크기도 이 값
  fanAngleDeg: 15,         // 부채꼴 한쪽 각도 (도, 0~60). 0이면 끔
  enabledModes: ['theater'],   // 앰비언트를 켤 화면 모드 ('default' | 'theater' | 'fullscreen')
  drmErrorLimit: 3,        // 그리기 예외가 연속으로 이만큼 나면 그 영상은 중단
  retry: { maxAttempts: 10, intervalMs: 300 },
  wrapperId: 'ambient-light-wrapper',
  rootAttr: 'data-yt-ambient',   // <html> 속성. 값 'on' | 없음
  debug: false,
  bars: {
    enabled: true,           // false면 검출과 제거를 모두 끈다
    blackSumMax: 16,         // 검은색으로 보는 R+G+B 합의 상한
    blackChannelDiffMax: 3,  // 검은색으로 보는 채널 사이 차이의 상한
    maxBarPercent: 38,       // 한쪽 띠 크기 상한 (%). 넘으면 그 측정은 버림
    minBarPercent: 1,        // 이보다 작은 띠는 없는 것으로 봄 (%)
    edgeMarginRows: 1,       // 경계 선이 남지 않게 더 자르는 행 수
    scanColumns: 5,          // 세로 스캔라인 개수
    stripHeight: 360,        // 측정 이미지 세로 해상도 상한 (px)
    measureIntervalMs: 300,  // 측정 간격 (ms)
    stableCount: 3,          // 같은 값이 연속 몇 번 나오면 확정할지
    stableTolerance: 0.5,    // 같은 값으로 볼 오차 (%p)
    clipVar: '--ambient-clip-inset',  // <html> CSS 변수 이름의 앞부분. 실제로는 뒤에 -x, -y가 붙은 두 변수를 쓴다 (ambient.css와 같아야 함)
  },
});
```

위 값은 작성 시점의 기본값이다. 값이 다르면 `config.js`가 사실이다.

### 4-2. `selectors.js`

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

플레이어와 영상은 **watchRoot 하위에서 탐색**한다(문서 전역 `.html5-video-player` 금지). `mountParent`만 문서 전체에서 찾는다.

### 4-3. `adapter.js`

```js
// Facts: YouTube에서 관측한 사실. 판단(표시 여부)은 하지 않는다.
// {
//   isWatchPage: boolean,
//   mode: 'default' | 'theater' | 'fullscreen',   // fullscreen 우선, 그다음 theater
//   mountParent: Element | null,
//   player: Element | null,
//   video: HTMLVideoElement | null,
// }
export function createAdapter({ onChange /* (facts) => void */, config, selectors, env }): {
  start(): void,      // 리스너 등록, 즉시 1회 refresh (이미 시작했으면 무시)
  stop(): void,       // 전부 해제(AbortController, MutationObserver, 재시도 타이머). 시작 전이면 무시
}
export function readMode({ fullscreenElement, watchRoot, modeAttrs }): 'default' | 'theater' | 'fullscreen'
export function readFacts({ doc, pathname, selectors }): Facts
export function factsEqual(a, b): boolean
```

- 구독: `yt-navigate-finish`, `fullscreenchange`, watchRoot 속성 MutationObserver(`SEL.modeAttrs` 필터; watchRoot 요소가 바뀌면 새 요소로 옮겨 건다).
- 요소가 비어 있고 `isWatchPage`이면 `config.retry`(간격 `intervalMs`, 최대 `maxAttempts`회)만큼만 재시도 후 포기. 다음 `yt-navigate-finish`에서 재시도 카운터 리셋.
- facts가 **이전과 얕게 비교해 같으면 `onChange`를 호출하지 않는다.** (요소는 같은 객체인지 비교)
- 시청 페이지가 아니면 요소를 조회하지 않는다.
- `env`는 `{ doc, getPathname, MutationObserver }`.

### 4-4. `store.js`

```js
// state = { ...Facts, tabVisible: boolean }
export function createStore(initial): {
  get(): State,
  set(partial): void,                 // 얕은 비교로 변경 없으면 notify 안 함
  subscribe(fn): () => void,          // unsubscribe 반환
}
export function deriveRunState(state): 'IDLE' | 'ARMED' | 'RUNNING'   // 순수 함수. §3-3 표 그대로
```

### 4-5. `layout.js` (순수, DOM 접근 금지)

```js
// Rect = { left, top, width, height }  (뷰포트 기준 getBoundingClientRect 값)
// bars = { x, y }  영상 가로/세로 대비 한쪽 띠 크기(%). x는 좌우, y는 위아래. 없으면 띠 없음
export function computeLayout({ playerRect, videoRect, parentRect, bars, config }): Layout
// Layout = {
//   valid: boolean,                       // 입력이 올바르지 않으면 false (아래 참고). 이때 다른 필드는 null, draws는 빈 배열
//   wrapperBox: Rect,                     // mountParent 기준 상대 좌표. 플레이어 박스와 일치
//   canvasBox: Rect,                      // wrapper 기준 상대 좌표. 플레이어 ∪ 최대 층 박스 (음수 가능)
//   canvasPx: { width, height },          // 내부 해상도 (긴 변 = config.canvasLongSide, 비율 = canvasBox 비율)
//   captureSize: { width, height },       // 영상 샘플링 크기 (긴 변 = config.captureLongSide, 영상 비율)
//   feather: { x, y },                    // 가장자리 투명 폭 (띠를 뺀 영역 크기 대비 비율, 0~0.5. layerGapPx에서 환산)
//   crop: { sx, sy, sw, sh },             // capture 이미지에서 띠를 뺀 영역 (capture px)
//   bars: { x, y },                       // 정리된 띠 크기 (%). 한쪽 최대 49%
//   draws: Array<{ dx, dy, dw, dh }>,     // canvasPx 좌표계. 바깥 층 → 안쪽 층 순서(painter's)
// }
export function layoutEquals(a, b): boolean   // 동일하면 DOM/렌더러 갱신 생략용
```

- `valid:false`가 되는 경우: 플레이어/영상 사각형 크기가 0이거나 숫자가 아님, 부모 위치가 숫자가 아님, `layerGapPx`/`captureLongSide`/`canvasLongSide`/`maxLayers`가 양수가 아님, 띠를 뺀 영역이 남지 않음.
- 층 목록: §3-4의 공식으로 개수 N을 구하고, i번째 층 = 띠를 뺀 영역을 사방으로 `layerGapPx × i` px 넓힌 박스 (i = N..1 순서로 담아 바깥 층이 먼저).
- 띠 크기는 한쪽 49%(`MAX_BAR_PERCENT`)로 제한한다. 양쪽 합이 100%를 넘어 영역이 사라지는 것을 막는 안전장치이며, 오검출 기준인 `config.bars.maxBarPercent`(38)와는 목적이 다르다.
- `layoutEquals`는 0.01px 이내 오차를 같은 값으로 본다 (`feather` 비율과 `bars`는 0.0001 이내).

### 4-6. `mount.js`

```js
export function createMount({ config, env }): {
  mount(parent: Element): { wrapper: HTMLElement, canvas: HTMLCanvasElement },  // 이미 있으면 기존 반환(멱등)
  applyLayout(layout): void,     // 변경된 스타일만 씀(이전 값 캐시와 비교). 띠 CSS 변수도 여기서 쓴다
  setVisible(v: boolean): void,  // display 토글
  setRootAttr(on: boolean): void,// <html data-yt-ambient="on"> 설정/제거 (+ --video-feather 변수)
  unmount(): void,               // wrapper 제거, 참조 해제, <html>의 띠 변수와 --video-feather 제거
}
```

- wrapper는 `aria-hidden`, `pointer-events:none`, `z-index:-1`이며 **처음에 `display:none`**이다. controller가 `setVisible(true)`로 보여 준다. 같은 id의 이전 wrapper가 있으면 지운다. `position`은 `styles/ambient.css`가 담당한다.
- `applyLayout`은 wrapper(`left/top/width/height`)와 canvas(`left/top/width/height`)를 CSS px로 쓰고, `layout.bars`로 `<html>`의 `${clipVar}-x`, `${clipVar}-y`를 쓴다 (띠가 없으면 지운다).
- `unmount()`는 `<html>`의 `data-yt-ambient` 속성을 건드리지 않는다 (속성은 `setRootAttr`가 담당).
- `env`는 `{ doc }`.

### 4-7. `renderer.js` (YouTube를 모른다)

```js
export function createRenderer({ config, env }): {
  attach(video: HTMLVideoElement, canvas: HTMLCanvasElement): void,  // 이전 attach가 있으면 먼저 detach
  setLayout(layout): void,       // 배치 반영. 실행 중이면 바로 다시 그린다
  start(): void,                 // 프레임 루프 시작(멱등). 시작 시 1프레임을 바로 그린다
  stop(): void,                  // 프레임 콜백 취소, 미디어 이벤트 해제(멱등)
  detach(): void,                // stop 포함. GPU 자원과 영상/canvas 참조를 놓는다
  destroy(): void,
  onBarsChange(listener): void,  // 띠 확정/초기화 알림 등록 (null이면 해제). 값은 { x, y } (영상 대비 한쪽 %)
  hasGl(): boolean,              // WebGL2를 얻어 attach가 성공한 상태인지
}
export function shouldDrawFrame(nowMs, lastDrawMs, maxFps): boolean   // 순수
```

- 그리기는 `gl-pipeline.js`가, 띠 측정은 `letterbox.js`가 맡는다. renderer는 `draw`가 성공한 뒤에만 오류 횟수를 0으로 하고 `lastDrawMs`를 기록하고 `detector.sample`을 부른다.
- `maxFps` 초과 프레임은 건너뛴다(콜백은 계속 재등록하되 draw만 생략). `shouldDrawFrame`은 지터 여유 2ms를 두며 `maxFps<=0`은 제한 없음, `lastDrawMs<=0`은 처음을 뜻한다.
- 미디어 이벤트: `play`(재개), `pause`(예약 취소), `seeked`(일시정지 상태면 1프레임 갱신), `loadstart`/`emptied`(새 영상이므로 띠 측정을 처음부터 다시).
- `start()`는 `requestVideoFrameCallback`이 없으면 경고 1회 후 동작하지 않는다. `start()`는 일시정지 상태여도 1프레임을 그린다. `detach()`는 `stop()`을 포함하므로 `attach()` 뒤에는 `start()`를 다시 불러야 한다.
- 그리기 예외가 `config.drmErrorLimit`회 **연속**이면 해당 영상에 대해 루프를 중단하고(`halted`) `logger.debug` 1회. 새 `attach` 전까지 `start()`를 무시한다. 아직 올릴 영상 프레임이 없는 것(`draw`가 `false`)은 오류로 세지 않는다. (DRM이 예외가 아니라 **검은 프레임**일 수 있음 → V2, Uncertain)
- `visibilitychange`/표시 판단은 하지 않는다(controller가 start/stop으로 제어).
- `env`는 `{ createCanvas, now, logger }`. `createCanvas`는 띠 측정용 2D canvas에만 쓰이고, `letterbox.js`로 전달된다.

### 4-7b. `gl-pipeline.js`

```js
export function createGlPipeline({ config, logger, onRestored, onError }): {
  setup(canvas): boolean,    // WebGL2 컨텍스트와 자원 생성. 실패 시 false (WebGL 없음 경고는 1회만). canvas 참조도 여기서 받는다
  setLayout(layout): void,   // 배치 저장 + 크기 반영. 값이 바뀔 때만 canvas.width/height 대입 (대입하면 canvas가 지워진다). null 허용
  draw(video): boolean,      // 그릴 수 없거나 영상 프레임이 아직 없으면 false, 성공하면 true. 그리기 실패는 예외로 던진다
  release(): void,           // 컨텍스트 리스너 해제 + 자원 삭제 + canvas 참조 놓기 (layout은 유지)
  hasGl(): boolean,
}
```

- `onRestored()`: 컨텍스트 복구 후 자원 재생성이 끝나면 부른다. renderer는 실행 중일 때 한 프레임을 바로 그린다.
- `onError(error)`: 복구 중 자원 재생성이 실패하면 부른다. renderer는 연속 오류 처리로 연결한다.
- 컨텍스트 유실 시 `preventDefault()`로 복구가 시도되게 하고, 복구될 때까지 그리지 않는다.
- WebGL 컨텍스트는 `alpha: true`, `premultipliedAlpha: true`로 만든다.
- 영상은 `video.readyState >= 2`이고 크기가 있을 때만 올린다. 영상 크기가 바뀌면 텍스처를 새로 할당하고 같으면 내용만 덮어쓴다.
- 부채꼴 각도는 `config.fanAngleDeg`(도)를 0~60으로 제한해 올린다.

### 4-7c. `shaders.js`

- 내보내는 것: `VERTEX_SOURCE`, `CAPTURE_FRAGMENT_SOURCE`, `buildCompositeSource(maxLayers)`, `BLUR_FRAGMENT_SOURCE`. 셰이더 안에서만 쓰는 상수(`CAPTURE_TAPS` 4, `FAN_TAPS` 2, `MAX_BLUR_RADIUS` 24)도 이 파일에 있다.
- 문자열과 상수만 담는다. GPU 자원 관리와 그리기 순서는 `gl-pipeline.js`가 맡는다.

### 4-7d. `letterbox.js`

```js
export function analyzeBarStrip(data, columns, height, options): { status: 'ok' | 'black' | 'tooBig' | 'invalid', percent }   // 순수
export function createBarStabilizer(options): { push(percent): number | null, reset(): void }                             // 순수
export function createLetterboxDetector({ config, env }): {
  sample(video, nowMs): void,    // 그리기 성공 뒤에만 호출. 확정 전에만 측정. 첫 측정은 바로, 이후 measureIntervalMs 간격
  reset(): void,                 // 처음부터 다시 측정하고 { x: 0, y: 0 }을 알림
  release(): void,               // 측정용 canvas만 버림
  onChange(listener): void,      // 확정/초기화 때 { x, y } 알림. null이면 해제
}
```

- `env.createCanvas`는 측정용 canvas를 만드는 선택 인자다 (기본은 `document.createElement('canvas')`).
- 같은 값이 `stableCount`번 연속(`stableTolerance` 이내)이면 확정하고 그 영상에서는 더 측정하지 않는다.

### 4-8. `controller.js`

```js
export function createController({ adapter, store, mount, renderer, config, computeLayout, env }): {
  start(): void,   // store.subscribe(reconcile), renderer.onBarsChange(handleBars), visibilitychange 리스너, adapter.start() (멱등)
  stop(): void,    // 전부 해제 후 IDLE 전이, renderer.destroy, 루트 속성 OFF (멱등)
}
```

- `onChange(facts)` → `store.set(facts)`. `visibilitychange` → `store.set({ tabVisible: !document.hidden })`.
- `relayout()`은 **rAF로 병합**. 읽기(rect 3개)를 먼저 모두 수행 → `computeLayout` → `layoutEquals`로 비교 → 달라졌을 때만 `mount.applyLayout` + `renderer.setLayout`.
- ResizeObserver는 RUNNING일 때만 `player`와 `video`를 observe한다. (RO 초기 콜백은 상태 진입 시 1회뿐이므로 허용.)
- RUNNING 진입 시 `renderer.start()` 전에 `relayout()`을 동기로 1회 실행한다.
- `env`는 `{ doc, requestAnimationFrame, cancelAnimationFrame, ResizeObserver }`.

### 4-9. `main.js`

```js
// 중복 실행 가드: if (window.__ytAmbientBooted) return; window.__ytAmbientBooted = true;
// store, adapter(onChange → store.set), mount, renderer, controller(computeLayout 주입) 생성 → controller.start()
```

---

## 7. 불변식 (모든 변경에서 유지)

1. 앰비언트는 영상의 복제본이며 영상 위에 오버레이하지 않는다. 영상 품질/컨트롤에 영향 없음.
2. YouTube의 DOM 구조/크기를 바꾸지 않는다. 추가하는 것은 `mountParent` 안의 wrapper 하나와 `<html>`의 속성 하나뿐이다. (`<html>`의 CSS 변수는 속성이 아니라 style 값이다.)
3. "보여야 하는가"는 `deriveRunState`만 판단한다.
4. 비표시(IDLE/ARMED) 상태의 비용은 0에 수렴해야 한다(옵저버/프레임 콜백 없음).
5. 레이아웃을 바꾸는 CSS는 앰비언트 CSS에만, YouTube 오버라이드는 **투명화/숨김만** 담당한다.

---

## 8. 알려진 제약 / 미확정 (Uncertain)

- **V1~V8은 모두 `Unverified`**: 전체화면 시 mountParent 표시, DRM 영상 동작(예외인지 검은 프레임인지), scroll 리스너 필요 여부, `#movie_player` 존재, `yt-navigate-finish` 최초 발생, `ytd-watch-*` 종류, 오버라이드 선택자 유효성은 `docs/VERIFICATION.md`에 사람이 확인한 결과만 근거로 삼는다.
- 실제 YouTube에서의 동작은 코드를 읽고 추정한 것이다. 브라우저 실행 확인은 사람이 한다 (`docs/HANDOFF.md` §9 체크리스트).
- scroll 리스너는 없다. 스크롤 시 wrapper가 어긋나면 V4를 "필요"로 기록하고 RUNNING 중에만 rAF 병합 리스너를 추가한다.
- WebGL2가 없으면 동작하지 않고 `console.warn` 1회. GPU 컨텍스트가 유실되면 그리기를 멈췄다가 복구 시 자원을 다시 만들어 이어 그린다. **복구가 실제 크롬에서 이전과 같이 동작하는지는 Uncertain.**
- `gl-pipeline.js`의 `setup` 주석에는 "alpha:false(불투명)"이라고 적혀 있지만 코드는 `alpha: true`로 만든다. 코드를 사실로 보며, 주석이 틀렸다. 빈 영역이 검게 보이는지 투명하게 보이는지는 실제 확인 전까지 Uncertain.
- adapter는 페이지 이동 없이 `<video>` 요소만 교체되는 경우를 즉시 알아채지 못할 수 있다.
- `yt-overrides.css` 선택자의 필요 여부 분류는 추정이다 (V8 표).
- `ambient.css`의 `-webkit-mask-*`(접두사 있는 속성)을 지워도 되는 최소 크롬 버전은 모른다. 지금은 지우지 않는다.
- fps 제한의 실제 체감 값, 튜닝 후보(`maxFps`, 해상도, blur)의 채택은 사람이 측정/육안 확인한 뒤 `config.js`에 반영한다.
