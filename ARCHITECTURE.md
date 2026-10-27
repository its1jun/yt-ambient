# Ambient Light for YouTube — 설계 문서 (ARCHITECTURE)

> 이 문서는 두 가지만 다룬다: **트리 구조**(§1)와 **전체 구조**(§2). 모듈별 함수 계약, 설정값 표, 검증 기록은 넣지 않는다.
> 문서와 코드가 다르면 **코드가 사실이다**. 이 문서는 소스를 읽고 정리한 것이며, 실제 Chrome/YouTube에서 실행해 확인한 내용은 아니다.

---

## 1. 트리 구조

```text
yt-ambient/
├─ manifest.json          MV3 매니페스트. 콘텐츠 스크립트(dist/content.js + styles/*.css)와 팝업을 연결
├─ README.md              개발/설치/배포 안내
├─ ARCHITECTURE.md        이 문서
├─ assets/
│  └─ icon.png            확장 아이콘 (툴바, 팝업 로고)
├─ config/                콘텐츠 스크립트와 팝업이 함께 import 하는 설정
│  ├─ config.js           모든 설정 기본값의 단일 출처 (CONFIG, 동결 객체)
│  └─ settings.js         팝업 설정의 스키마(SCHEMA) + 값 검증 + chrome.storage 저장/읽기 + 실행 중인 config에 적용
├─ dist/
│  └─ content.js          scripts/main.js를 번들한 결과물. 실제로 YouTube 페이지에 주입되는 파일 (직접 수정하지 않는다)
├─ popup/                 툴바 아이콘을 눌렀을 때 뜨는 UI (번들하지 않고 ES module로 직접 로드)
│  ├─ popup.html          전원 버튼과 설정 컨트롤(슬라이더/스위치). 컨트롤마다 data-setting 키가 붙는다
│  ├─ popup.css           팝업 스타일
│  └─ popup.js            전원/설정을 chrome.storage.local에 저장하고, 저장된 값을 읽어 화면에 반영
├─ scripts/               콘텐츠 스크립트 본체 (YouTube 페이지 안에서 동작)
│  ├─ main.js             진입점. 중복 실행 방지, 모듈 생성과 연결(조립)만 한다
│  ├─ selectors.js        YouTube 선택자/속성명 상수 (YouTube가 바뀌면 여기만 고친다)
│  ├─ adapter.js          YouTube 화면을 관찰해 "사실(facts)"만 보고한다 (시청 페이지인지, 화면 모드, 요소들)
│  ├─ store.js            앱 상태 한 곳 + deriveRunState (지금 돌아야 하는가 판정, 순수 함수)
│  ├─ power-storage.js    팝업의 전원 ON/OFF를 chrome.storage에서 읽어 store.powerOn에 반영
│  ├─ controller.js       상태 머신(IDLE/ARMED/RUNNING). mount/renderer/옵저버를 조율하고 배치 재계산을 예약
│  ├─ layout.js           배치 계산 (순수 함수). 층, canvas 박스, 띠 제거 crop, 영상 확대 배율, 그리기 생략 영역
│  ├─ mount.js            앰비언트 wrapper+canvas를 만들고 지우고, 배치 결과를 DOM과 <html>에 적용
│  ├─ renderer.js         프레임 루프: fps 제한, 재생/일시정지/시크 대응, 연속 오류 중단 (YouTube를 모른다)
│  ├─ gl-pipeline.js      WebGL2 자원 관리 + 그리기 4단계 + 컨텍스트 유실/복구
│  ├─ shaders.js          GLSL 셰이더 문자열과 셰이더 안에서만 쓰는 상수
│  └─ letterbox.js        검은 띠(레터박스) 분석(순수) + 영상에서 픽셀을 읽어 측정 + 값 확정
└─ styles/                manifest가 콘텐츠 스크립트와 함께 YouTube 페이지에 로드하는 CSS
   ├─ ambient.css         wrapper 기본 스타일, 원본 영상의 clip-path/확대/가장자리 마스크, 스크롤바 숨김
   └─ yt-overrides.css    YouTube 배경 투명화/숨김. 모든 규칙이 html[data-yt-ambient="on"] 하위로 스코프됨
```

### 1-1. 폴더별 실행 위치

| 폴더/파일 | 실행되는 곳 | 로드 방식 |
| --- | --- | --- |
| `scripts/` + `config/` | YouTube 페이지 (콘텐츠 스크립트) | `dist/content.js` 한 파일로 번들되어, manifest의 `content_scripts`가 `https://www.youtube.com/*`에 `document_idle` 시점에 주입 |
| `styles/` | YouTube 페이지 | 번들하지 않고 manifest의 `content_scripts.css`가 콘텐츠 스크립트와 함께 로드 |
| `popup/` + `config/` | 툴바 팝업 | `popup.html`이 `popup.js`(module)를 로드하고, `popup.js`가 `../config/*.js`를 직접 import |

- `config/`는 콘텐츠 스크립트(번들 안)와 팝업(번들 밖) 양쪽에서 import한다. README의 배포용 zip 목록에는 `config/`가 있고 `scripts/`는 없는데, `scripts/`는 `dist/content.js`에 번들되고 팝업은 `config/`를 직접 import하기 때문으로 보인다 (추정).
- **Uncertain**: 압축 파일에 `package.json`이 없다. README는 `npm run build`로 `scripts/ → dist/content.js`를 만든다고 하지만 빌드 도구와 옵션은 이 파일만으로 확인할 수 없다. `dist/content.js`는 첫 줄이 IIFE이고 원본 파일 경로가 주석으로 붙은 형태라 esbuild 번들로 보인다.

---

## 2. 전체 구조

### 2-1. 한눈에 보기

확장은 **두 곳(팝업, YouTube 페이지)에서 따로 돌고, 둘은 `chrome.storage.local`로만 연결된다.** YouTube 페이지 쪽은 "관찰 → 상태 → 판정 → 조율 → 그리기"로 한 방향으로 흐른다.

```text
chrome.storage.local ──► power-storage ──┐
   (power)                               │ powerOn
                                         ▼
YouTube DOM ──► adapter ──facts──►      store ──► deriveRunState()
   (관찰)                                │
                                         │ subscribe → reconcile()
                                         ▼
chrome.storage.local ──► settings ──►  controller ◄── renderer.onBarsChange (띠 확정)
   (settings)           onChange         │   │
                       (refresh)         │   └── computeLayout()   layout.js (순수)
                                         │
                           ┌─────────────┴─────────────┐
                           ▼                           ▼
                         mount                      renderer
              (wrapper/canvas,                  (프레임 루프)
               <html> 속성/변수)                  ├─ gl-pipeline ── shaders
                                                  └─ letterbox
```

### 2-2. 팝업과 저장소

- 팝업과 콘텐츠 스크립트는 서로 직접 메시지를 주고받지 않는다. 팝업이 `chrome.storage.local`에 쓰면, YouTube 탭의 콘텐츠 스크립트가 `chrome.storage.onChanged`로 받아 반영한다. 그래서 열려 있는 **모든 YouTube 탭에 동시에** 적용된다. (manifest 권한은 `storage` 하나)
- 저장 키는 두 개다.
  - `power` — `true`/`false`. 값이 없으면 `config.power.defaultOn`을 따른다.
  - `settings` — 사용자가 바꾼 값만 담은 객체. 스키마(`SCHEMA`)에 있는 키만 받는다: `blurPx`, `videoFeatherPercent`, `maxFps`, `layerGapPx`, `fanAngleDeg`, `bars.enabled`.
- 최종 설정값 = `config.js` 기본값 위에 저장된 `settings`를 얹은 것. 알 수 없는 키나 범위를 벗어난 값은 `settings.js`가 걸러낸다.
- 새 설정을 추가하는 순서: ① `config.js`에 기본값 → ② `settings.js`의 `SCHEMA`에 한 줄 → ③ `popup.html` 컨트롤에 `data-setting` 키 붙이기.

### 2-3. 모듈 역할과 의존 방향

모든 모듈은 `createXxx(...)` 팩토리 형태이고, `main.js`가 만들어서 서로 연결한다. 외부 객체(document, 시계, chrome.storage 등)는 선택 인자 `env`로 바꿔 끼울 수 있다.

| 계층 | 모듈 | 책임 | 하지 않는 일 |
| --- | --- | --- | --- |
| 조립 | `main.js` | 모듈 생성, 연결, 시작 순서 | 판단/계산 |
| 관찰 | `selectors.js`, `adapter.js` | YouTube에서 facts 읽기, 이벤트/옵저버 구독, 횟수 제한 재시도 | 표시 여부 판단 |
| 저장소 입력 | `power-storage.js`, `settings.js`의 `createSettings` | chrome.storage ↔ store / config | 그리기, DOM |
| 상태·판정 | `store.js` | 상태 보관, 값이 바뀔 때만 알림, `deriveRunState` | DOM 접근 |
| 조율 | `controller.js` | 상태 전이, ResizeObserver, 배치 재계산 예약(rAF 병합) | 직접 계산/그리기 (`computeLayout`은 주입받음) |
| 계산(순수) | `layout.js`, `letterbox.js`의 분석 함수 | 숫자만으로 결과 계산 | DOM/GPU 접근 |
| 부수효과 | `mount.js` | wrapper/canvas 생성·제거, 스타일 적용(바뀐 값만), `<html>` 속성/변수 | YouTube 요소 탐색 |
| | `renderer.js` | 프레임 루프, fps 제한, 일시정지/시크, 연속 오류 중단 | YouTube 지식, GPU 세부 |
| | `gl-pipeline.js`, `shaders.js` | WebGL 자원, 그리기 4단계, 컨텍스트 복구 / GLSL 문자열 | 프레임 루프 |
| | `letterbox.js` | 영상에서 픽셀을 읽어 검은 띠 측정, 확정 | 배치 계산 |

의존은 한 방향이다.

```text
main ─┬─ config/config, config/settings
      ├─ selectors, adapter, store, power-storage
      ├─ layout ········ computeLayout을 controller에 주입
      └─ mount, renderer, controller
controller ─┬─ store    (deriveRunState)
            └─ layout   (layoutEquals, scaleRectAboutCenter)
renderer ───┬─ gl-pipeline ─ shaders
            └─ letterbox
store ─ config/config
```

- `controller`는 `adapter`/`mount`/`renderer`를 import하지 않고 인자로 받는다. `adapter`, `mount`, `layout`, `letterbox`, `power-storage`는 다른 모듈을 import하지 않는다.
- 주의: `store.js`는 실행 중 갱신되는 config가 아니라 **동결된 `CONFIG`를 직접** 읽는다(`enabledModes`). 지금은 `enabledModes`가 팝업 설정(SCHEMA)에 없어서 문제가 없지만, 팝업에서 바꿀 수 있게 만들면 `deriveRunState`가 바뀐 값을 보지 못한다.

구조를 지키는 규칙:

1. 상태는 `store` 한 곳에만 둔다. "지금 돌아야 하는가"는 `deriveRunState` 한 함수가 정한다.
2. YouTube를 아는 JS는 `selectors.js`와 `adapter.js`뿐이다. (CSS는 `styles/`의 두 파일) `renderer`, `gl-pipeline`, `mount`는 요소를 인자로만 받는다.
3. 모든 start에는 짝이 되는 stop이 있고, 리스너는 `AbortController`의 signal로 한꺼번에 해제한다.
4. 폴링은 없다. 재시도는 `config.retry`로 횟수가 제한된 것만 허용한다. 프레임은 `requestVideoFrameCallback`으로 받는다.
5. 계산(순수)과 부수효과(DOM, GPU)를 분리한다. 숫자 설정은 `config.js`가 단일 출처다.

### 2-4. 실행 상태 머신 (controller가 소유)

| 상태 | 조건 (store 기준) | 살아 있는 것 |
| --- | --- | --- |
| `IDLE` | `!powerOn` 또는 `!isWatchPage` 또는 `mountParent`/`player`/`video` 중 하나라도 null | adapter 관찰, power-storage 구독만. wrapper 없음, renderer는 detach |
| `ARMED` | 위 조건을 통과하고, `mode`가 `config.enabledModes`에 없거나 `!tabVisible` | 요소 연결과 GPU 자원은 유지. 프레임 루프 정지, wrapper 숨김 |
| `RUNNING` | 위 조건을 통과하고, 허용된 `mode`이며 `tabVisible` | + ResizeObserver, 프레임 루프, wrapper 표시, `<html data-yt-ambient="on">` |

- `enabledModes` 기본값은 `['theater']`다. 그래서 기본 모드와 전체화면에서는 `ARMED`다. (화면 모드 판독은 `default`/`theater`/`fullscreen` 셋 다 한다)
- `store`의 `powerOn` 초기값은 `false`다. 저장된 값을 읽기 전에는 `IDLE`이고, 저장값이 없으면 `config.power.defaultOn`(기본 `true`)을 따른다.
- 전이 시 동작
  - `→IDLE`: (RUNNING에서 왔으면 "RUNNING 나가기" 먼저) `renderer.detach`, `mount.unmount`, 기억해 둔 배치와 적용 기록 초기화
  - `→ARMED`: ("RUNNING 나가기" 먼저) wrapper 숨김
  - `→RUNNING`: wrapper 마운트 → (영상/canvas가 바뀐 때만) `renderer.attach` → **WebGL2를 얻지 못했으면 켜지 않고 루트 속성 OFF, wrapper 숨김 후 끝** → 루트 속성 ON, 표시 → ResizeObserver 등록 → `relayout()` 동기 1회 → `renderer.start`
  - **RUNNING 나가기**(공통): `renderer.stop`, 띠 값 0으로 초기화, ResizeObserver 해제, 예약된 relayout 취소, 루트 속성 OFF
- `reconcile()`은 멱등이다. 이미 적용한 `{ state, player, video, parent }`와 같으면 아무것도 하지 않는다.
- **일시정지는 컨트롤러 상태가 아니라 renderer 내부 동작**이다. `pause`는 프레임 콜백 취소, `play`는 재개, 일시정지 중 `seeked`는 1프레임 갱신.

### 2-5. 데이터 흐름

**① 시작** (`main.js`의 `boot`)

1. 중복 실행 가드(`window.__ytAmbientBooted`)
2. `createLiveConfig()` — `CONFIG`의 복사본. 모듈들이 이 객체를 참조로 들고 있으므로 이후 설정 변경은 값만 제자리에서 바꾼다
3. `settings.load()` 후 `applySettings` — 첫 그리기 전에 저장값을 적용해 기본값으로 잠깐 그려지는 깜빡임을 막는다 (읽기 실패 시 기본값)
4. `store`, `adapter`(`onChange → store.set`), `mount`, `renderer`, `controller` 생성
5. `power-storage` 생성, `settings.onChange` 등록
6. `powerStorage.start()` → `controller.start()` (→ `adapter.start()`)

**② 상태 결정** (관찰 → store → controller)

- adapter가 `yt-navigate-finish`, `fullscreenchange`, watchRoot 속성 변화(MutationObserver, `theater`/`full-bleed-player`)를 듣고 facts를 다시 읽는다. 주소 경로가 `/watch`가 아니면 요소를 조회하지 않고 전부 null로 본다. 요소가 아직 없으면 `config.retry` 횟수만큼만 재시도한다.
- facts가 이전과 달라졌을 때만 `store.set`을 부르고, `store.set`은 값이 바뀐 키가 있을 때만 구독자에게 알린다. 구독자인 `controller.reconcile`이 `deriveRunState`로 전이한다.
- store의 상태는 `isWatchPage`, `mode`, `mountParent`, `player`, `video`(adapter), `tabVisible`(controller의 `visibilitychange`), `powerOn`(power-storage)이다.

**③ 화면 그리기** (RUNNING 동안)

- 배치: `ResizeObserver`(player, video), 창 크기 변경, 띠 확정, 설정 변경이 `controller`의 relayout을 예약한다 (rAF로 한 번에 병합). → rect와 영상의 CSS scale, 뷰포트 경계를 모두 읽고 → `computeLayout` → `layoutEquals`로 같으면 중단 → 다르면 `mount.applyLayout` + `renderer.setLayout`.
- 프레임: `renderer`가 `requestVideoFrameCallback`으로 프레임을 받고 `shouldDrawFrame`으로 fps를 제한한 뒤 `pipeline.draw(video)`를 부른다. 4단계는 **capture(축소) → composite(층 합성) → 가로 블러 → 세로 블러(+채도)** 이고, 결과가 canvas 1개에 그려진다. 블러와 채도는 CSS `filter`가 아니라 셰이더가 처리한다.
- 검은 띠: 그리기에 성공할 때마다 `letterbox.sample`이 불리고, 확정되기 전에만 측정한다. 확정되면 `renderer.onBarsChange` → `controller.handleBars` → relayout. `layout`이 띠를 뺀 영역(`crop`)과 영상 확대 배율(`zoom`)을 계산해서, GPU는 띠를 뺀 영역만 읽고 `mount`는 `<html>`에 CSS 변수를 쓴다. 새 영상(`loadstart`/`emptied`)이면 처음부터 다시 측정한다.
- 그리기 생략: `layout`이 원본 영상이 완전히 가리는 영역(`hidden`)과 어떤 스크롤 위치에서도 보이지 않는 영역(`visible`로 제한)을 계산하고, `gl-pipeline`은 그 부분을 scissor로 그리지 않는다. (`config.hiddenSkip`, `config.offscreenSkip`)
- 연속 오류: 그리기 예외가 `config.drmErrorLimit`회 연속이면 그 영상은 새 `attach` 전까지 중단한다. 읽을 수 없는 영상(DRM 등)에서 띠 측정 예외가 나면 그 측정만 건너뛴다.

**④ 팝업 → 페이지**

- 전원: 팝업 버튼 → `storage.power` → `power-storage` → `store.powerOn` → `deriveRunState`가 `IDLE`(또는 복귀)로 판정한다.
- 설정: 슬라이더 → `settings.save` → `storage.settings` → 모든 탭의 `settings.onChange` → `applySettings`가 live config를 제자리에서 갱신하고 `{ reflow, resetBars }`를 돌려준다 → 둘 중 하나라도 true면 `controller.refresh`가 기억해 둔 배치를 비우고 relayout을 예약한다 (`resetBars`면 띠 측정도 처음부터). `maxFps`는 매 프레임 읽으므로 따로 처리하지 않아도 바로 반영된다.

### 2-6. YouTube 페이지에 닿는 곳

| 대상 | 내용 | 담당 |
| --- | --- | --- |
| `mountParent`(`#content.ytd-app`) 맨 앞 | `#ambient-light-wrapper` div 1개와 그 안의 canvas 1개. `aria-hidden`, `pointer-events:none`, `z-index:-1`, 처음엔 `display:none` | `mount.js` |
| `<html>` 속성 | `data-yt-ambient="on"` — RUNNING 중에만. 아래 CSS 규칙 전체의 스위치 | `mount.setRootAttr` |
| `<html>` 인라인 CSS 변수 | `--video-feather`(속성과 함께 켜짐/꺼짐), `--ambient-clip-inset-x/-y`(띠), `--ambient-video-scale`(확대). 띠/확대 변수는 `unmount`(IDLE) 때 지운다 | `mount.js` |
| 원본 영상 `.html5-main-video` | `clip-path`로 띠 잘라냄, `scale`로 확대, 가장자리 마스크 | `ambient.css` |
| 그 밖의 YouTube 요소 | `#content.ytd-app`의 `overflow-x: clip`, 세로 스크롤바 숨김, YouTube 배경 투명화와 시네마틱 레이어 숨김 | `ambient.css`, `yt-overrides.css` |

- 위 CSS 규칙은 모두 `html[data-yt-ambient="on"]` 아래에 있다. 속성이 꺼지면(IDLE/ARMED) 적용되지 않는다. (wrapper 기본 규칙 하나만 속성과 무관하다)
- 코드를 읽고 정리한 내용이다. 실제 YouTube에서 위 요소가 의도대로 보이는지는 확인하지 못했다.
