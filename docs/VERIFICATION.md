# VERIFICATION — 코드만으로 확정하지 못한 가정의 검증

사람이 브라우저에서 확인하고 결과를 적는다. 결과 값: `Unverified` / `Confirmed` / `Refuted`.
확인이 안 되면 `Unverified`로 두고 사유를 적는다. (미확정이어도 다음 Phase는 진행 가능하며, 기본값으로 간다.)

| ID | 질문 | 상태 | 근거 / 날짜 | 영향받는 곳 |
|---|---|---|---|---|
| V1 | 전체화면일 때 `document.fullscreenElement`는 무엇이며, `#content.ytd-app` 안의 앰비언트가 보이는가 | Unverified | | adapter의 `mountParent` (Phase 3, 5) |
| V2 | DRM 영상에서 `drawImage`가 예외인가, 검은 프레임인가 | Unverified | | renderer DRM 가드 (Phase 4) |
| V3 | 레거시가 유휴 상태에서 매초 레이아웃을 일으키는가 | Unverified | | 기준선 해석 |
| V4 | `scroll` 리스너가 필요한가 | Unverified | | controller (Phase 5) |
| V5 | `#movie_player`가 있는가 / 문서 전역 `.html5-video-player`가 여러 개인가 | Unverified | | `SEL.player` (Phase 1, 3) |
| V6 | `yt-navigate-finish`가 최초 로드에서도 발생하는가 | Unverified (Phase 5에서 확인) | | adapter 진입 방식 |
| V7 | 실제로 쓰이는 `ytd-watch-*` 요소는 무엇인가 | Unverified | | `SEL.watchRoot` |
| V8 | 오버라이드 CSS 선택자 중 아직 유효한 것 (Phase 6에서 표로 채움) | Unverified | | `yt-overrides.css` |

## 확인 방법

브라우저 개발자 도구(F12)의 Console 탭에 붙여 넣어 실행한다. 확인 후 이 문서의 표를 고쳐 쓴다.

### V1 — 전체화면 요소
1. 영상 시청 페이지에서 아래를 Console에 붙여 넣고 실행한다.
   ```js
   document.addEventListener('fullscreenchange', () => console.log('fullscreenElement:', document.fullscreenElement));
   ```
2. 영상을 전체화면으로 바꾼다. (Console 출력은 전체화면을 닫은 뒤 확인)
3. 출력된 요소의 태그/id를 기록한다.
4. 레거시 확장이 켜진 상태에서, 전체화면 때 영상 주변(레터박스)에 앰비언트가 보이는지 눈으로 확인한다. (울트라와이드가 아니면 여백이 없어 판단이 어려울 수 있음 → 그 경우 `Unverified`)

### V2 — DRM 영상 (대여/구매 영화가 없으면 `Unverified`로 둔다)
1. DRM 영상을 재생한 상태에서 실행한다.
   ```js
   const v = document.querySelector('video.html5-main-video');
   const c = document.createElement('canvas'); c.width = 16; c.height = 9;
   const x = c.getContext('2d'); x.drawImage(v, 0, 0, 16, 9);
   try { console.log(x.getImageData(0, 0, 16, 9).data.slice(0, 12)); } catch (e) { console.log('예외:', e.name); }
   ```
2. 예외가 나오는지, 값이 모두 0(검은색)인지 기록한다.

### V3 — 유휴 상태 레이아웃
1. 극장 모드에서 영상을 재생하고, 레거시 확장을 켠 상태로 개발자 도구 Performance 탭에서 5초 녹화한다.
2. 1초 간격으로 반복되는 `Layout` / `Recalculate Style` 막대가 있는지 기록한다.

### V4 — scroll 리스너 필요성
1. 기본 모드와 극장 모드에서 각각 페이지를 아래로 스크롤한다.
2. 앰비언트가 플레이어와 어긋나는지(따로 움직이는지) 기록한다. 어긋나면 `Confirmed`(필요).

### V5 — 플레이어 요소
```js
document.querySelectorAll('.html5-video-player').length
document.querySelector('#movie_player')
```
- 시청 페이지, 홈(영상에 마우스를 올려 미리보기 재생 중), 미니플레이어 상태에서 각각 실행해 결과를 기록한다.

### V7 — 시청 요소
```js
document.querySelector('ytd-watch-flexy, ytd-watch-fixie, ytd-watch-grid')?.tagName
```


## V8: 오버라이드 선택자 유효성 (Phase 6)

방법: 앰비언트 ON 상태(극장/전체화면)에서 개발자 도구로 해당 규칙을 끄고 앰비언트가 가려지거나 외형이 달라지는지 확인. 결과는 `필요 / 불필요 / Unverified`로 기록.

| 선택자 | 분류 | 필요 여부 | 확인일 |
|---|---|---|---|
| `ytd-app` | 필수(추정) | Unverified | |
| `#content.ytd-app` | 필수(추정) | Unverified | |
| `#player-theater-container` | 필수(추정) | Unverified | |
| `#player-wide-container` | 필수(추정) | Unverified | |
| `#full-bleed-container` | 필수(추정) | Unverified | |
| `#player-full-bleed-container` | 필수(추정) | Unverified | |
| `#player` | 필수(추정) | Unverified | |
| `#player-container` | 필수(추정) | Unverified | |
| `#ytd-player` | 필수(추정) | Unverified | |
| `.html5-video-player` | 필수(추정) | Unverified | |
| `.html5-video-container` | 필수(추정) | Unverified | |
| `.html5-main-video` | 필수(추정) | Unverified | |
| `ytd-masthead` | 필수(추정) | Unverified | |
| `ytd-masthead #background` | 필수(추정) | Unverified | |
| `ytd-masthead #container` | 필수(추정) | Unverified | |
| `#frosted-glass` | 필수(추정) | Unverified | |
| `ytd-watch-flexy` | 필수(추정) | Unverified | |
| `ytd-watch-flexy #columns` | 필수(추정) | Unverified | |
| `ytd-watch-flexy #primary` | 필수(추정) | Unverified | |
| `ytd-watch-flexy #secondary` | 필수(추정) | Unverified | |
| `ytd-watch-flexy #primary-inner` | 필수(추정) | Unverified | |
| `ytd-watch-flexy #below` | 필수(추정) | Unverified | |
| `#cinematics` | 필수(추정) | Unverified | |
| `#cinematics-container` | 필수(추정) | Unverified | |
| `#cinematics-wide-container` | 필수(추정) | Unverified | |
| `#cinematics-full-bleed-container` | 필수(추정) | Unverified | |
| `ytd-watch-metadata` | 외형 보정(추정) | Unverified | |
| `yt-searchbox` | 외형 보정(추정) | Unverified | |
| `ytd-searchbox` | 외형 보정(추정) | Unverified | |
| `.ytSearchboxComponentInputContainer` | 외형 보정(추정) | Unverified | |
| `.ytSearchboxComponentInputBox` | 외형 보정(추정) | Unverified | |
| `.ytSearchboxComponentInputBoxDark` | 외형 보정(추정) | Unverified | |
| `.ytSearchboxComponentSearchButton` | 외형 보정(추정) | Unverified | |
| `.ytSearchboxComponentSearchButtonDark` | 외형 보정(추정) | Unverified | |
| `#search-icon-legacy` | 외형 보정(추정) | Unverified | |
| `#container.ytd-searchbox` | 외형 보정(추정) | Unverified | |
| `ytd-playlist-panel-renderer` | 외형 보정(추정) | Unverified | |
| `ytd-playlist-panel-renderer #container` | 외형 보정(추정) | Unverified | |
| `ytd-playlist-panel-renderer .header` | 외형 보정(추정) | Unverified | |
| `ytd-playlist-panel-renderer #items` | 외형 보정(추정) | Unverified | |
| `ytd-playlist-panel-renderer .playlist-items` | 외형 보정(추정) | Unverified | |
