// YouTube 화면에서 요소를 찾을 때 쓰는 선택자 모음 (YouTube가 바뀌면 이 파일만 고친다)
export const SEL = Object.freeze({
  mountParent: '#content.ytd-app',                         // 앰비언트 div를 넣을 부모
  watchRoot: 'ytd-watch-flexy, ytd-watch-fixie, ytd-watch-grid', // 시청 화면 최상위 요소
  // Uncertain: 실제 존재 여부는 VERIFICATION.md의 V5로 확인 필요.
  // 없으면 watchRoot 안의 '.html5-video-player'로 바꾼다.
  player: '#movie_player',
  video: 'video.html5-main-video',                         // 실제 영상 요소
  modeAttrs: ['theater', 'full-bleed-player'],             // watchRoot의 극장 모드 판단 속성
  watchPath: '/watch',                                     // 앰비언트를 적용할 주소 경로
});
