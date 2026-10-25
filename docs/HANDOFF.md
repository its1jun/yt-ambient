# HANDOFF — yt-ambient 단순화 작업 인계서

> 이 문서는 **작업 중간에 AI가 바뀌어도 이어갈 수 있게** 만든 인계서다.
> 작업을 시작하기 전에 이 문서를 처음부터 끝까지 읽는다. 작업을 멈출 때는 반드시 **§8 진행 로그**를 먼저 갱신한다.

---

## 0. 시작 절차 (매번 이 순서)

1. 이 문서(`HANDOFF.md`)를 읽는다.
2. `AGENTS.md`를 읽고 따른다. (아래 §2 참고)
3. **§8 진행 로그**에서 마지막으로 끝난 Phase와 "중단 지점"을 확인한다.
4. 이번에 할 Phase(§6)의 "범위" 파일만 읽는다. 보지 않은 코드는 추측하지 않는다. 파일이 필요하면 사용자에게 요청한다.
5. 작업한다.
6. `npm run build`로 `dist/content.js`를 다시 만든다. (**필수.** `manifest.json`이 `dist/content.js`를 직접 읽기 때문에, 소스만 고치고 빌드하지 않으면 크롬에서 바뀐 게 적용되지 않는다.)
7. Phase의 "완료 기준"을 확인한다. 사람이 눈으로 봐야 하는 항목은 사용자에게 요청한다.
8. §8 진행 로그를 갱신한다.
9. 인계물을 낸다: **수정된 프로젝트 전체 zip** + **갱신된 HANDOFF.md**. (zip 이름: `yt-ambient-phaseN.zip`, `node_modules`는 제외, `dist/`는 포함)

---

## 1. 목표

**알고리즘과 코드를 단순화해서, 관리하고 보수하기 쉽게 만든다.**

- 기본은 **화면 결과를 그대로 유지**한다. (색, 블러, 계단 폭, 가장자리 투명도, 성능 특성 모두)
- 줄이는 것은 "구조와 중복"이다. 기능이 아니다. (§3 결정 참고)
- 새 기능을 추가하지 않는다.

---

## 2. 규칙

- `AGENTS.md`를 따른다.
- 코드 주석은 한국어로 쓴다. 변수/함수/클래스/파일 이름은 영어로 쓴다. 기존 이름 규칙을 유지한다.
- 사용자는 비개발자다. 설명은 쉬운 말로 하고, 기술 용어는 짧게 풀어 쓴다.
- 이 문서의 Phase에 없는 구조 변경은 하지 않는다. 필요하다고 판단되면 이유와 범위를 몇 줄로 적어 **사용자 승인을 먼저 받는다.**
- 원인을 확인하지 못한 것은 추측하지 않고 **"Uncertain"** 으로 적는다.
- `AGENTS.md`는 AI가 직접 고치지 않는다. 고칠 곳이 있으면 사용자에게 알린다. (§6 Phase 7 참고)

### 코드 규칙 (현재 코드가 이미 따르고 있는 것. 유지한다)

- 모듈은 `createXxx(...)` 팩토리 함수 형태다. **모듈 최상위에 바뀌는 상태를 두지 않는다.**
- 폴링 금지. 재시도는 횟수 제한이 있는 것만 허용한다.
- 시작(start)에는 짝이 되는 정지(stop)가 있다. 리스너는 `AbortController`로 한꺼번에 해제한다.
- 숫자 설정값은 `config.js`가 단일 출처다. 다른 파일에 새 숫자를 직접 쓰지 않는다. **기본값 자체(blurPx 24 등)는 바꾸지 않는다.**
- YouTube를 아는 코드(선택자, 이벤트 이름, 모드 판독)는 `selectors.js`와 `adapter.js`에만 둔다. `renderer`는 YouTube를 모른다.
- 파일 줄바꿈은 LF다. 그대로 유지한다.

### 불변식 (모든 Phase에서 지킨다)

1. 앰비언트는 영상의 복제본이다. 영상 위에 덮어씌우지 않는다.
2. YouTube의 DOM 구조와 크기를 바꾸지 않는다. 추가하는 것은 `mountParent` 안의 wrapper 1개와 `<html>` 속성 1개뿐이다.
3. "지금 보여야 하는가"는 `deriveRunState(state)`만 판단한다.
4. 보이지 않는 상태(IDLE/ARMED)의 비용은 0에 가깝다. (옵저버, 프레임 콜백 없음)
5. `yt-overrides.css`는 투명화/숨김만 담당한다. 레이아웃을 바꾸는 규칙을 넣지 않는다.

---

## 3. 결정 로그 (사용자가 승인한 것. 바꾸지 않는다)

| # | 결정 | 내용 |
|---|---|---|
| ① | 검은 띠(레터박스) 자동 제거 | **A. 유지**하고 `letterbox.js` 한 파일로 모은다. 기능은 지우지 않는다. |
| ② | 부채꼴 샘플링 (`fanAngleDeg: 15`) | **A. 유지.** Phase 5는 **생략**한다. 셰이더의 `sampleFan`, `rotateAroundCenter`, `FAN_TAPS`, `fanAngleDeg`를 건드리지 않는다. |
| ③ | 테스트 | **`test/` 폴더와 테스트 파일을 만들지 않는다.** `npm test` 스크립트도 만들지 않는다. (실익보다 구조가 지저분해지는 비용이 더 크다는 판단) |
| ④ | 화면 모드 | 현재 구조 유지. (`enabledModes: ['theater']`, 전체화면/기본 모드 판독 코드 유지) |
| ⑤ | 상태 3개 | IDLE / ARMED / RUNNING 유지. ARMED는 모드/탭이 바뀔 때 GPU 자원을 다시 만들지 않게 해 준다. |
| ⑥ | GPU 그리기 4단계 | 축소(capture) → 층 합성(composite) → 가로 블러 → 세로 블러. 유지. 이 확장의 화면 모습 자체이므로 알고리즘을 바꾸지 않는다. |
| ⑦ | `yt-overrides.css` 선택자 | **삭제 금지.** 필요 여부가 모두 미확인이다 (`docs/VERIFICATION.md` V8). 선언을 합치는 것만 허용한다. |
| ⑧ | 폴더 이름 | `scripts/`를 그대로 쓴다. 문서의 `src/` 표기를 코드에 맞춘다. (코드가 사실이다) |

---

## 4. 현재 상태 (작업 시작 전 기준선)

### 4-1. 파일과 줄 수

| 파일 | 줄 수 | 역할 |
|---|---|---|
| `scripts/main.js` | 31 | 진입점, 중복 실행 방지 |
| `scripts/config.js` | 41 | 설정값 단일 출처 |
| `scripts/selectors.js` | 11 | YouTube 선택자 |
| `scripts/store.js` | 63 | 상태 보관 + `deriveRunState` |
| `scripts/adapter.js` | 149 | YouTube 상황 관측 → facts |
| `scripts/controller.js` | 185 | 상태 머신, 옵저버/렌더러/마운트 조율 |
| `scripts/layout.js` | 234 | `computeLayout` (순수 계산) |
| `scripts/mount.js` | 131 | wrapper/canvas 생성·제거, 스타일 적용 |
| `scripts/renderer.js` | **807** | 셰이더, GPU 자원, 프레임 루프, 복구, 띠 측정 (한 파일이 전부 담당) |
| `scripts/bars.js` | 87 | 띠 분석 순수 함수 |
| `styles/ambient.css` | 41 | wrapper 스타일, 영상 가장자리 페더링, 띠 clip |
| `styles/yt-overrides.css` | 72 | YouTube 배경 투명화 |
| `dist/content.js` | 52,661 bytes | 빌드 결과 (소스와 일치 확인됨) |

### 4-2. 알려진 문제 (이 작업으로 해결할 것)

- 문서(`docs/ARCHITECTURE.md`, `README.md`)가 `src/`를 가리키지만 실제 폴더는 `scripts/`다.
- 문서가 언급하는 `docs/HANDOFF.md`(이 문서가 대체), `PROGRESS.md`, `BASELINE.md`, `TEST_CHECKLIST.md`는 없다. README의 `npm test`는 실제로 없다.
- 문서의 설정값(§4-1 `CONFIG`)이 코드와 다르다. 예: `blurPx` 문서 20 / 코드 24, 문서의 `edgeFeatherPx`는 코드에 없다.
- 안 쓰는 코드: `layout.js`의 `isPlayerCovered`, `mount.js`의 `getCanvas`, `adapter.js`의 `getFacts`.
- 최대 층 수 40이 `layout.js`(`MAX_LAYER_COUNT`)와 `renderer.js`(`MAX_LAYERS`)에 따로 있다. 주석에 "같은 값이어야 한다"고 적혀 있다.
- 검은 띠 기능이 `bars.js`, `renderer.js`, `controller.js`, `layout.js`, `mount.js`, `config.js`, `ambient.css`에 걸쳐 있다. 측정(renderer) → 알림(controller) → 계산(layout) → 적용(mount/CSS) → renderer로 돌아오는 순환이다.
- `manifest.json` 버전은 0.2, `package.json` 버전은 0.3.0이다. **어느 쪽이 맞는지 Uncertain.**

### 4-3. 현재 모듈 간 호출 관계 (바꾸지 않는 외부 모양)

```text
main → store, adapter, mount, renderer, controller 생성 → controller.start()
adapter.onChange(facts) → store.set(facts)
controller: store 구독 → reconcile() → mount / renderer 호출
controller.relayout(): rect 3개 읽기 → computeLayout → mount.applyLayout + renderer.setLayout
renderer.onBarsChange(cb) → controller.handleBars → relayout 예약
```

`createRenderer`의 공개 함수 모양은 Phase 3에서도 **바꾸지 않는다**:
`{ attach, setLayout, start, stop, detach, destroy, onBarsChange, hasGl }`

---

## 5. 목표 구조

```text
scripts/
  main.js  config.js  selectors.js  store.js  adapter.js
  controller.js    (3상태 유지, 내부만 정리)
  layout.js        (순수 계산)
  mount.js
  renderer.js      ← 프레임 루프만 (fps 제한, 재생/일시정지/시크, 연속 오류 중단)
  gl-pipeline.js   ← 신규: WebGL 자원, 그리기 4단계, 컨텍스트 유실/복구
  shaders.js       ← 신규: 셰이더 문자열과 셰이더 상수만
  letterbox.js     ← bars.js를 대체: 띠 분석 + 측정 + 안정화
styles/
  ambient.css
  yt-overrides.css
```

- `test/` 폴더는 **만들지 않는다** (결정 ③).
- 새 JS 파일은 `main.js`에서 이어지는 `import`를 따라 esbuild가 묶어 주므로 `manifest.json`은 고치지 않는다. 새 CSS 파일은 만들지 않는다.

---

## 6. Phase 계획

각 Phase는 **작게 끝낸다.** 끝날 때마다 빌드가 성공하는 상태여야 한다. 한 Phase가 끝나면 §8 로그를 갱신하고 zip을 낸다.
Phase 번호는 승인된 설계안과 같게 유지한다. (Phase 5는 생략이지만 번호는 그대로 둔다)

### Phase 0 — 기준선 기록 (코드 변경 없음)

- **범위**: 파일을 고치지 않는다.
- **작업**
  1. `npm install` 후 `npm run build`가 성공하는지 확인한다. `dist/content.js` 크기(기준 52,661 bytes)를 §8에 적는다.
  2. 사용자에게 **작업 전 화면 기준 스크린샷**을 요청한다. 극장 모드에서 (a) 일반 영상 (b) 위아래 검은 띠가 있는 영상. 사용자가 저장해 두고, Phase 3과 Phase 4에서 비교에 쓴다. 사용자가 못 한다고 하면 "기준 없음"으로 적고 눈 확인만으로 진행한다.
- **완료 기준**: 빌드 성공, 기준 크기 기록.

### Phase 1 — 잔가지 정리 (화면 변화 없음)

- **범위**: `scripts/layout.js`, `scripts/mount.js`, `scripts/adapter.js`, `scripts/config.js`, `scripts/renderer.js`
- **작업**
  1. `layout.js`: `isPlayerCovered` 삭제. (`computeFarthestGap`, `isSizedRect`는 다른 곳에서 쓰므로 남긴다)
  2. `mount.js`: `getCanvas` 삭제하고 반환 객체에서도 뺀다.
  3. `adapter.js`: `getFacts` 삭제하고 반환 객체에서도 뺀다. (`INITIAL_FACTS`는 다른 곳에서 쓰므로 남긴다)
  4. 최대 층 수 40을 한 곳으로 모은다. **권장:** `config.js`에 `maxLayers: 40`을 추가하고, `layout.js`는 `config.maxLayers`를, `renderer.js`는 `config.maxLayers`를 쓴다. `renderer.js`의 셰이더 문자열이 모듈 최상위 상수라 값을 받으려면 함수 형태(예: `buildCompositeSource(maxLayers)`)로 바꿔야 할 수 있다. 값(40)과 층 수 계산식(`Math.min(max, Math.max(1, needed) + 1)`)은 **그대로** 둔다.
- **하지 않는 것**: `layout.js`의 `MAX_BAR_PERCENT`(49)는 `config.bars.maxBarPercent`(38)와 목적이 다른 안전장치이므로 건드리지 않는다.
- **완료 기준**
  - `npm run build` 성공
  - `grep -rn "isPlayerCovered\|getCanvas\|getFacts" scripts/` 결과 없음
  - 40이 한 곳에만 정의됨
  - 같은 입력에 대한 `computeLayout` 결과가 변경 전과 같다. (임시 확인 방법은 §7)

### Phase 2 — CSS 정리 (화면 변화 없음)

- **범위**: `styles/yt-overrides.css`
- **작업**
  1. 선언 5줄(`background`, `background-color`, `backdrop-filter`, `border-color`, `box-shadow`)이 똑같은 두 블록("필수" 묶음, "외형 보정" 묶음)을 **규칙 1개**로 합친다. 선택자는 하나도 지우지 않는다. "필수/외형 보정(추정)" 구분은 선택자 목록 안의 주석으로 남겨서 V8 확인 때 쓸 수 있게 한다.
  2. 파일 맨 위 주석의 `src/config.js`를 `scripts/config.js`로 고친다.
- **하지 않는 것**: 선택자 삭제, `!important` 변경, `ambient.css` 수정.
- **주의**: 두 블록 사이에 있는 `#cinematics...` 규칙(`display: none`)은 선언이 달라 충돌하지 않는다. 순서가 바뀌어도 결과가 같지만, 합친 뒤 눈으로 확인한다.
- **완료 기준**: 빌드 성공, 극장 모드에서 이전과 같은 모습(앰비언트가 가려지지 않고 YouTube 배경이 투명), 선택자 개수 변화 없음.

### Phase 3 — renderer 분리 (화면 변화 없음, **코드 이동만**)

- **범위**: `scripts/renderer.js`, 신규 `scripts/shaders.js`, 신규 `scripts/gl-pipeline.js`
- **작업**
  - `shaders.js`로 이동: `VERTEX_SOURCE`, `CAPTURE_FRAGMENT_SOURCE`, `COMPOSITE_FRAGMENT_SOURCE`, `BLUR_FRAGMENT_SOURCE`와 셰이더가 쓰는 상수(`CAPTURE_TAPS`, `FAN_TAPS`, `MAX_BLUR_RADIUS`, 층 수 상한).
  - `gl-pipeline.js`로 이동: `compileShader`, `createProgram`, `createTexture`, `allocateCapture`, `allocateTargets`, `buildGlResources`, `releaseGlResources`, `onContextLost`, `onContextRestored`, `setupGl`, `applySizes`, `uploadVideoFrame`, `renderCapture`, `uploadLayoutUniforms`, `renderLayers`, `renderBlur`와 관련 상수(`MIN_READY_STATE`, `MAX_FAN_ANGLE_DEG`)·GL 변수.
  - `renderer.js`에 남김: `shouldDrawFrame`, `FRAME_SLACK_MS`, 프레임 루프(`scheduleFrame`, `onFrame`, `cancelFrame`), 미디어 이벤트(`onPlay`, `onPause`, `onSeeked`, `onSourceChange`), 연속 오류 중단(`handleDrawError`, `errorCount`, `halted`), `attach/start/stop/detach/destroy/hasGl/setLayout`, **그리고 띠 측정 코드(Phase 4에서 옮김)**.
- **권장 인터페이스 (초안. 필요하면 조정하고 §8에 최종 모양을 기록한다)**
  ```text
  createGlPipeline({ config, logger, onRestored })
    → { setup(canvas): boolean,   // WebGL2 컨텍스트와 자원 생성. 실패 시 false (경고는 1회만)
        setLayout(layout): void,  // 크기/배치 반영 (값이 바뀔 때만 canvas.width/height 대입)
        draw(video): boolean,     // 그릴 프레임이 없으면 false, 그리기 실패는 예외로 던짐
        release(): void,
        hasGl(): boolean }
  ```
- **반드시 보존할 동작** (코드를 읽고 정리한 것. 하나라도 바뀌면 안 된다)
  1. `canvas.width/height`는 **값이 바뀔 때만** 대입한다. (대입하면 canvas 내용이 지워진다)
  2. `attach` 순서: `detach()` → video/canvas 설정 → `setupGl()` → `halted=false`, `errorCount=0`, `lastDrawMs=0` → 띠 측정 초기화 → 크기 적용.
  3. `drawFrame` 순서: 영상 올리기 → capture → layers → blur → `errorCount=0`, `lastDrawMs` 기록 → 띠 측정. **띠 측정은 그리기가 성공한 뒤에만** 한다.
  4. `uploadVideoFrame`이 `false`(아직 프레임 없음)이면 오류로 세지 않는다.
  5. 그리기 예외가 `drmErrorLimit`번 **연속**이면 `halted`가 되고, 새 `attach` 전까지 `start()`는 무시한다.
  6. `setLayout`이 불리면 `layoutDirty=true`, 크기 적용, 실행 중이면 즉시 다시 그린다.
  7. 컨텍스트 유실 시 `preventDefault()`로 복구가 시도되게 하고, 복구되면 자원을 다시 만들고 실행 중이면 한 프레임을 바로 그린다.
  8. `start()`는 `requestVideoFrameCallback`이 없으면 경고 1회 후 동작하지 않는다. 시작 시 1프레임을 바로 그린다. `detach()`는 `stop()`을 포함한다.
  9. 셰이더 코드(GLSL) 내용은 **한 글자도 바꾸지 않는다.** 위치만 옮긴다.
- **하지 않는 것**: 알고리즘 변경, 셰이더 수정, 상수 값 변경, 공개 함수 이름 변경(`createRenderer`의 반환 모양 포함).
- **완료 기준**
  - 빌드 성공, 에러 없음
  - `renderer.js`가 프레임 루프 중심으로 줄어듦 (줄 수는 §8에 기록)
  - **사람이 확인:** Phase 0 스크린샷과 비교해 같은 모습인지. 콘솔(F12)에 `[yt-ambient]` 경고/에러가 없는지
  - 선택(가능하면): 컨텍스트 복구 확인. 앰비언트가 켜진 상태에서 콘솔에 아래를 실행하고 그림이 돌아오는지 본다. 결과가 불확실하면 §8에 "Uncertain"으로 적는다.
    ```js
    const c = document.querySelector('#ambient-light-wrapper canvas');
    const ext = c.getContext('webgl2').getExtension('WEBGL_lose_context');
    ext.loseContext(); setTimeout(() => ext.restoreContext(), 500);
    ```

### Phase 4 — 레터박스 정리 (결정 ① = A)

두 단계로 나눠서 각각 끝내고 로그를 남긴다.

#### 4a. 측정 코드를 `letterbox.js`로 모으기 (화면 변화 없음)

- **범위**: `scripts/bars.js`(삭제), 신규 `scripts/letterbox.js`, `scripts/renderer.js`
- **작업**
  - `bars.js`의 `analyzeBarStrip`, `createBarStabilizer`(및 내부 함수)를 `letterbox.js`로 옮긴다. 이름은 그대로 export한다.
  - `renderer.js`의 측정 코드를 `letterbox.js`로 옮긴다: `ensureBarStrip`, `releaseBarStrip`, `emitBars`, `resetBars`, `sampleBars`와 관련 변수(`barLocked`, `barStrip`, `barStripCtx`, `lastSampleMs`, `emittedBars`, `barsListener`, `stabilizer`, `barOptions`).
  - **권장 인터페이스(초안)**: `createLetterboxDetector({ config, env })` → `{ sample(video, nowMs), reset(), release(), onChange(listener) }`. `renderer.js`는 그리기 성공 뒤 `detector.sample(video, stamp)`만 부르고, `attach/start/loadstart/emptied` 때 `reset()`, `detach` 때 `release()`를 부른다.
  - `renderer.onBarsChange`는 그대로 `detector.onChange`에 연결해서 `controller.js`는 **고치지 않는다.**
- **반드시 보존할 동작**
  1. 측정은 영상마다 처음에 몇 번만 한다. 같은 값이 `stableCount`번 연속(`stableTolerance` 이내)이면 확정하고 **이후 측정하지 않는다.**
  2. 측정 간격은 `measureIntervalMs`. 첫 측정은 바로 한다. (`lastSampleMs`가 0일 때)
  3. 화면 전체가 검거나(`black`) 띠가 너무 큰(`tooBig`) 측정은 버리고 계속한다.
  4. 확정되면 측정용 canvas를 버리고 `{ x: 0, y: 확정값 }`을 알린다. 새 영상(`loadstart`/`emptied`), `attach`, `start` 때는 처음부터 다시 하고 `{x:0, y:0}`을 알린다.
  5. 읽을 수 없는 영상(DRM 등)에서 `drawImage`/`getImageData` 예외가 나면 이번 측정만 건너뛴다. (그리기 오류 횟수에 넣지 않는다)
  6. `enabled: false`이면 측정을 하지 않는다.
- **완료 기준**: 빌드 성공, `bars.js` 삭제됨, `analyzeBarStrip`/`createBarStabilizer`의 같은 입력에 대한 결과가 변경 전과 같음(§7), **사람이 확인:** 위아래 검은 띠가 있는 영상에서 띠가 잘려 나가고 Phase 0 스크린샷과 같은 모습.

#### 4b. 띠 값이 흐르는 길 단순화 (화면 변화 없음이 목표)

- **범위**: `scripts/mount.js`, `styles/ambient.css`, (필요 시) `scripts/config.js`
- **작업**: `<html>`에 쓰는 CSS 변수를 3개(`--ambient-clip-inset`, `-x`, `-y`)에서 **2개(`-x`, `-y`)로** 줄인다. `ambient.css`의 `clip-path`가 `-y`, `-x`를 직접 읽게 한다. (예: `clip-path: inset(var(--ambient-clip-inset-y, 0%) var(--ambient-clip-inset-x, 0%))`) 변수 이름 기준은 `config.bars.clipVar`이며, CSS와 같아야 한다는 주석을 남긴다.
- **주의 (Uncertain)**: 지금은 띠가 없으면 변수가 없어서 `clip-path`가 적용되지 않는다. 바꾼 뒤에는 항상 `inset(0% 0%)`가 적용된다. 같은 요소에 이미 `mask-image`가 항상 적용되므로 겹침 순서(stacking)는 같을 것으로 보이지만 **실제 확인 전에는 Uncertain**이다. 눈으로 확인한다.
- **완료 기준**: 빌드 성공, 띠가 없는 영상과 있는 영상 모두 이전과 같은 모습, 영상 가장자리 페더링도 이전과 같음.
- **같은 모습이 아니면**: 4b를 되돌리고 이유를 §8에 적은 뒤 사용자에게 보고한다. (4a만으로도 목적은 달성된다)

### Phase 5 — **생략** (결정 ② = A)

부채꼴 샘플링은 유지한다. 이 Phase는 하지 않는다.

### Phase 6 — controller 정리 (화면 변화 없음)

- **범위**: `scripts/controller.js`
- **작업**: 같은 일을 하는 부분을 정리한다. 예: `applied`와 `bound`(영상/canvas 연결 기록)를 하나로 합치기, `enterIdle`/`enterArmed`/`enterRunning`의 공통 정리 모으기. 구체적인 방법은 코드를 읽고 정하되, 아래 동작은 보존한다.
- **반드시 보존할 동작**
  1. 상태는 IDLE / ARMED / RUNNING 3개. 판정은 `deriveRunState`만 한다.
  2. `reconcile()`은 **멱등**이다. 같은 입력(`state`, `player`, `video`, `parent`)이면 아무것도 하지 않는다. RUNNING 중 요소 참조가 바뀌면 다시 연결한다.
  3. `→IDLE`: 렌더러 stop+detach, ResizeObserver 해제, 예약 취소, 띠 초기화, 루트 속성 끄기, wrapper 제거.
  4. `→ARMED`: 렌더 정지, 옵저버 해제, 루트 속성 끄기, wrapper 숨김. (GPU 자원은 유지)
  5. `→RUNNING`: wrapper 마운트 → (영상/canvas가 바뀌었을 때만) `renderer.attach` → **WebGL이 없으면 앰비언트를 켜지 않고 루트 속성도 끈다** → 루트 속성 켜기, 표시 → (부모가 바뀌면 `lastLayout` 초기화) → 옵저버 연결 → `relayout()` 동기 1회 → `renderer.start()`.
  6. `relayout()`은 rAF로 합친다. rect 3개를 먼저 모두 읽고 → 계산 → `layoutEquals`로 비교 → 달라졌을 때만 `mount.applyLayout` + `renderer.setLayout`.
  7. ResizeObserver는 RUNNING일 때만 `player`와 `video`를 지켜본다.
  8. `stop()`은 `start()`가 만든 것을 전부 해제한다. (멱등)
- **하지 않는 것**: 상태 개수 변경, `deriveRunState` 이동/변경, 공개 함수(`start`, `stop`) 변경.
- **완료 기준**: 빌드 성공, **사람이 확인** — §9 체크리스트 전체.

### Phase 7 — 문서 현행화

- **범위**: `docs/ARCHITECTURE.md`, `README.md`, `docs/VERIFICATION.md`(필요한 줄만)
- **작업**
  1. `ARCHITECTURE.md`: `src/` → `scripts/`, §3-2 모듈 구성을 §5 구조로, §4 모듈 계약을 실제 코드로 맞춘다. (`CONFIG` 실제 값과 `bars`/`crop`/`maxLayers`, 삭제된 `getFacts`/`getCanvas`, 새 `gl-pipeline.js`/`shaders.js`/`letterbox.js`, 층 수 계산식 `+1`). 없는 문서(`PROGRESS.md`, `BASELINE.md`, `TEST_CHECKLIST.md`) 참조를 지우고 "작업 순서는 `docs/HANDOFF.md`"만 남긴다. 테스트 관련 설명이 있으면 지운다.
  2. `README.md`: `npm test` 줄 삭제, `src/ → dist/content.js`를 `scripts/ → dist/content.js`로, 배포 zip 명령의 `src/styles`를 `styles`로 고친다. (`manifest.json`이 읽는 폴더는 `styles/`다)
  3. 문서와 코드가 다르면 **코드를 사실로** 보고 문서를 고친다.
- **AI가 직접 고치지 않고 사용자에게 알릴 것**
  - `AGENTS.md`는 `architecture.txt`를 읽으라고 하지만 실제 파일은 `docs/ARCHITECTURE.md`다. 이 줄은 사용자에게 알려서 고치게 한다.
  - `manifest.json`(0.2)과 `package.json`(0.3.0)의 **버전이 다르다.** 어느 쪽이 맞는지 사용자에게 묻는다. 묻기 전에는 바꾸지 않는다.
- **완료 기준**: 문서에 적힌 파일/함수/값이 코드와 일치. `grep -rn "src/" docs README.md styles scripts` 결과에 남은 것이 없음(의도한 것 제외).

---

## 7. 임시 확인 방법 (프로젝트에 파일을 남기지 않는다)

순수 계산 함수(`computeLayout`, `analyzeBarStrip`, `shouldDrawFrame`, `deriveRunState`)는 화면 없이 숫자만 비교할 수 있다. Phase 1과 4a처럼 계산 쪽 코드가 바뀌는 Phase에서만 쓴다.

1. 프로젝트 **밖**(예: `/tmp`)에 일회용 스크립트를 만든다. 고정한 입력 몇 개(플레이어/영상/부모 rect, bars 없음·있음, 영상이 큰 경우·작은 경우)로 함수를 불러 결과를 JSON으로 저장한다.
2. **수정 전**에 한 번, **수정 후**에 한 번 실행해서 두 JSON이 같은지 비교한다.
3. 스크립트는 프로젝트에 넣지 않고 인계물에도 포함하지 않는다. (결정 ③)

---

## 8. 진행 로그 (작업이 끝나거나 멈출 때마다 갱신)

### 8-1. Phase 상태

| Phase | 상태 | 완료일 | 메모 |
|---|---|---|---|
| 0 기준선 기록 | 완료 | 2026-10-25 | 빌드 성공, dist 52,661 bytes. 작업 전 스크린샷은 **사용자 미제출(기준 없음)** |
| 1 잔가지 정리 | 완료 | 2026-10-25 | 아래 8-3 참고. 사용자가 §9 A~G 확인, 문제 없음 |
| 2 CSS 정리 | 완료 | 2026-10-25 | 선택자 43개 그대로, 선언 블록만 1개로 합침. 사용자가 §9 A~G 확인, 문제 없음 |
| 3 renderer 분리 | 완료 | 2026-10-25 | `renderer.js` 808→263줄, 신규 `gl-pipeline.js` 453줄, `shaders.js` 152줄. 아래 8-3, 8-4 참고. 사용자가 §9 A~G 확인, 문제 없음 |
| 4a 측정 코드 이동 | 완료 | 2026-10-25 | `bars.js` 삭제, 신규 `letterbox.js`(172줄), `renderer.js` 263→191줄. 사람 확인은 4b·6과 함께 대기(통과 보고 없음) |
| 4b 띠 CSS 변수 정리 | 완료(사람 확인 대기) | 2026-10-25 | CSS 변수 3개→2개. 아래 8-3 참고. 통과 보고 없음 |
| 5 부채꼴 | **생략** (결정 ②) | | |
| 6 controller 정리 | 완료(사람 확인 대기) | 2026-10-25 | `applied`와 `bound`를 하나로 합침 (`controller.js` 185→182줄). 아래 8-3 참고 |
| 7 문서 현행화 | 완료 | 2026-10-25 | `ARCHITECTURE.md` 전면 갱신, `README.md`, `VERIFICATION.md`(V8 표 2줄 추가, V2 영향 위치), `AGENTS.md`(사용자 요청으로 직접 수정) |

상태 값: `대기` / `진행 중` / `완료` / `보류`

### 8-2. 중단 지점 (Phase 도중에 멈출 때만 쓴다)

```text
Phase: 7까지 완료 (Phase 5는 생략). 코드 작업은 모두 끝남
끝낸 것: Phase 0, 1, 2, 3, 4a, 4b, 6, 7 (빌드 성공, 코드는 Phase 6 이후 변경 없음)
남은 것: 사용자가 §9 체크리스트 A~H 전체를 확인한다 (Phase 3~6 변경 중 3은 통과 보고 있음, 4a/4b/6은 통과 보고 없음)
지금 빌드가 되는가: 예
메모: Phase 7은 문서만 고쳤다. 코드와 dist는 건드리지 않았다.
      - 코드를 사실로 보고 ARCHITECTURE.md를 고쳤다 (src/→scripts/, 모듈 구성, 상태 머신 표, 설정값, 계약, 띠 흐름 §3-5 추가, gl-pipeline/shaders/letterbox 계약 추가).
      - 문서의 오래된 설명을 바로잡았다: 블러/채도는 CSS filter가 아니라 셰이더, mipmap 안 씀, edgeFeatherPx 없음(가장자리 투명 폭 = layerGapPx), 층 개수 식의 +1, maxFps 15, CSS 변수 --ambient-blur 없음.
      - 코드 주석 불일치 발견(고치지 않음): gl-pipeline.js의 setup 주석은 "alpha:false(불투명)"이라고 쓰였지만 코드는 alpha: true다. 주석 수정은 코드 변경이라 이번 Phase에서 하지 않았다. ARCHITECTURE.md §8에 적었다.
      - VERIFICATION.md의 V1~V8 표의 "(Phase N)" 표기는 예전 계획의 번호라 지금 HANDOFF의 Phase와 다르다. 의미가 헷갈릴 수 있으나 "필요한 줄만" 원칙에 따라 그대로 두었다.
      - `grep -rn "src/" docs README.md styles scripts` 결과는 이 HANDOFF.md 안의 설명(옛 표기를 설명하는 줄)만 남는다. 의도한 것이다.
      - package.json/manifest.json 버전 불일치(0.3.0 / 0.2)는 사용자가 package.json은 범위 밖이라고 해서 다루지 않았다. Uncertain으로 남는다.
```

토큰이 부족해지면 **함수 하나가 끝나는 지점**에서 멈춘다. 빌드가 깨지는 상태로 멈출 수밖에 없다면 "빌드 안 됨"과 이유를 반드시 적는다.

### 8-3. 기록 (Phase를 끝낼 때 한 줄씩 추가)

| 날짜 | Phase | 한 일 | 빌드 | 사람 확인 | `dist` 크기 |
|---|---|---|---|---|---|
| (기준) | 0 | 작업 전 상태 | 성공 확인됨 | 미확인 | 52,661 bytes |
| 2026-10-25 | 1 | `isPlayerCovered`(layout), `getCanvas`(mount), `getFacts`(adapter) 삭제. 최대 층 수를 `config.maxLayers: 40` 한 곳으로 통일 (`layout.js`는 `config.maxLayers`, `renderer.js`는 `buildCompositeSource(maxLayers)` 함수로 셰이더 문자열 생성). `layout.js`는 `maxLayers`가 양수가 아니면 `valid:false`를 돌려줌(기본값 40이라 평소엔 영향 없음) | 성공 | 대기 | 51.6kb |
| 2026-10-25 | 2 | `yt-overrides.css`의 동일 선언 블록 2개를 1개로 합침(선택자 43개 동일 확인). 주석의 `src/config.js` → `scripts/config.js` | 성공 | 통과 (A~G) | 52,830 bytes |
| 2026-10-25 | 3 | `renderer.js`를 셋으로 분리. `shaders.js`(셰이더 문자열 + `FAN_TAPS`/`CAPTURE_TAPS`/`MAX_BLUR_RADIUS`), `gl-pipeline.js`(GL 자원, 4단계 그리기, 컨텍스트 유실/복구, `MIN_READY_STATE`/`MAX_FAN_ANGLE_DEG`), `renderer.js`(프레임 루프, 미디어 이벤트, 연속 오류 중단, 띠 측정). `createRenderer` 공개 모양은 그대로. 부수 변경: `start()`의 `!gl` 검사는 `!pipeline.hasGl()`로 바뀜 | 성공 | 통과 (A~G) | 53,734 bytes |
| 2026-10-25 | 4a | `bars.js`의 `analyzeBarStrip`, `createBarStabilizer`와 `renderer.js`의 띠 측정 코드(`ensureBarStrip`, `releaseBarStrip`, `emitBars`, `resetBars`→`reset`, `sampleBars`→`sample(video, stamp)`, 관련 변수)를 신규 `letterbox.js`로 이동. `bars.js` 삭제. `renderer.js`는 `detector.sample/reset/release/onChange`만 호출. `controller.js`는 고치지 않음 | 성공 | 대기 | 54033 bytes |
| 2026-10-25 | 4b | `<html>` CSS 변수를 3개(`--ambient-clip-inset`, `-x`, `-y`)에서 2개(`-x`, `-y`)로 줄임. `mount.js`의 `applyClip`/`unmount`에서 기준 변수 쓰기·지우기 삭제. `ambient.css`의 `clip-path`가 `-y`, `-x`를 대체값 없이 직접 읽음(변수가 없으면 clip-path 없음, 이전과 같음). `config.js`의 `clipVar` 주석만 수정(값은 그대로) | 성공 | 대기 | 53946 bytes |
| 2026-10-25 | 6 | `controller.js`: `bound`(렌더러에 연결한 영상/canvas)를 `applied.boundVideo`/`boundCanvas`로 합침. `emptyApplied()`가 둘 다 비우므로 `enterIdle`의 별도 초기화 삭제. `enterArmed`는 `{ ...applied, ... }`로 연결 기록 보존, `enterRunning`은 합친 값으로 attach 여부 판단. 상태 3개, `deriveRunState`, 공개 함수는 그대로 | 성공 | 대기 | 53897 bytes |
| 2026-10-25 | 7 | 문서만 수정. `ARCHITECTURE.md`(코드 기준으로 전면 갱신), `README.md`(`npm test` 줄 삭제, `src/`→`scripts/`, 배포 zip 명령의 `src/styles`→`styles`), `VERIFICATION.md`(V8 표에 `#voice-search-button`, `.ytSpecButtonShapeNextHost` 추가: 표 43개 = CSS 선택자 43개, V2 영향 위치 갱신). `AGENTS.md`는 사용자 요청으로 `architecture.txt` 4곳을 `docs/ARCHITECTURE.md`로 수정 | 해당 없음(코드 변경 없음) | 해당 없음 | 변화 없음 |

### 8-4. 확정된 인터페이스 (Phase 3, 4a에서 최종 모양을 여기에 적는다)

```text
createGlPipeline({ config, logger, onRestored, onError })
  → { setup(canvas): boolean,    // WebGL2 컨텍스트와 자원 생성. 실패 시 false (WebGL 없음 경고는 1회만). canvas 참조도 여기서 받는다
      setLayout(layout): void,   // 배치 저장 + 크기 반영 (값이 바뀔 때만 canvas.width/height 대입). null 허용
      draw(video): boolean,      // 그릴 수 없거나 영상 프레임이 아직 없으면 false, 성공하면 true. 그리기 실패는 예외로 던진다
      release(): void,           // 컨텍스트 리스너 해제 + 자원 삭제 + canvas 참조 놓기 (layout은 유지)
      hasGl(): boolean }
  - onRestored(): 컨텍스트 복구 후 자원 재생성이 끝나면 부른다. renderer는 실행 중일 때 한 프레임을 바로 그린다
  - onError(error): 복구 중 자원 재생성이 실패하면 부른다. renderer는 handleDrawError로 연결했다
  - 초안과 다른 점: onError 인자 추가. renderer.attach는 마지막에 pipeline.setLayout(layout)을 불러 예전 applySizes()와 같은 일을 한다
createLetterboxDetector({ config, env })      // env.createCanvas는 선택 (측정용 canvas, 기본은 document.createElement)
  → { sample(video, nowMs): void,      // 그리기 성공 뒤에만 호출. 첫 측정은 바로, 이후 measureIntervalMs 간격. 확정되면 더 측정하지 않음
      reset(): void,                    // 처음부터 다시 측정하고 { x:0, y:0 }을 알림 (attach/start/loadstart/emptied)
      release(): void,                  // 측정용 canvas만 버림 (detach)
      onChange(listener): void }        // 확정/초기화 때 { x, y } 알림. null이면 해제. renderer.onBarsChange가 그대로 연결
  - 같은 파일에서 analyzeBarStrip, createBarStabilizer도 export (이름 그대로)
```

---

## 9. 사람 확인 체크리스트 (사용자가 크롬에서 확인)

크롬에 불러오는 방법: `npm run build` → `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드" → 프로젝트 폴더 선택. (이미 로드했다면 확장 프로그램 카드에서 새로고침 후 YouTube 페이지도 새로고침)

| # | 확인 항목 | 기대 결과 |
|---|---|---|
| A | 극장 모드를 켠다 / 끈다 | 켜면 영상 뒤에 앰비언트, 끄면 사라짐 |
| B | 재생 / 일시정지 / 시크 | 재생 중에는 갱신, 일시정지 중에도 빈 화면이 되지 않음 |
| C | 다른 영상으로 이동(다음 영상, 홈 → 시청) | 앰비언트가 새 영상을 따라감, 깨지지 않음 |
| D | 다른 탭으로 갔다가 돌아옴 | 돌아오면 다시 갱신됨 |
| E | 창 크기를 바꿈 | 앰비언트가 플레이어에 맞게 따라옴 |
| F | 위아래 검은 띠가 있는 영상 | 띠가 잘려 나가고 앰비언트가 자연스러움 |
| G | 개발자 도구(F12) Console | `[yt-ambient]` 경고/에러 없음 |
| H | 기본 모드(극장 아님) | 앰비언트가 **켜지지 않음** (현재 `enabledModes: ['theater']`) |

---

## 10. 확인되지 않은 것 (Uncertain)

- 실제 YouTube에서의 동작은 코드를 읽고 추정한 것이다. 이 문서를 만든 시점에 브라우저 실행 확인은 없다.
- `docs/VERIFICATION.md`의 V1~V8은 모두 `Unverified`다. (전체화면 요소, DRM 동작, scroll 리스너 필요 여부, `#movie_player` 존재, `yt-navigate-finish` 최초 발생, `ytd-watch-*` 종류, 오버라이드 선택자 유효성)
- `manifest.json`과 `package.json`의 올바른 버전.
- `ambient.css`의 `-webkit-mask-*`(접두사 있는 속성)을 지워도 되는 최소 크롬 버전. **지금은 지우지 않는다.**
- Phase 4b의 `clip-path` 항상 적용이 화면에 영향을 주는지.
- Phase 3 이후 WebGL 컨텍스트 복구가 이전과 같이 동작하는지.

---

## 11. 하지 말 것 (요약)

- 새 기능 추가, 설정 기본값 변경, `enabledModes` 변경
- 부채꼴(`fan`) 코드 수정 (결정 ②)
- `yt-overrides.css` 선택자 삭제 (결정 ⑦)
- `test/` 폴더, 테스트 파일, `npm test` 스크립트 만들기 (결정 ③)
- 셰이더(GLSL) 내용 수정, 그리기 4단계 변경 (결정 ⑥)
- 빌드(`npm run build`) 없이 인계하기
- 이 문서에 없는 구조 변경을 승인 없이 하기

## 12. 되돌리기

문제가 생기면 **직전 Phase의 zip**으로 되돌린다. (git은 현재 프로젝트에 없다.) 그래서 Phase마다 `yt-ambient-phaseN.zip`을 만들어 보관하는 것이 필수다.
