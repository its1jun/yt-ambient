// 앰비언트 라이트의 모든 설정값을 모아둔 단일 출처 (다른 파일에서 숫자를 직접 쓰지 않는다)
export const CONFIG = Object.freeze({
  blurPx: 20,              // 흐림 정도 (CSS px)
  saturate: 1.0,           // 채도 배율 (1 = 원본)
  maxFps: 15,              // 초당 그리기 상한 (0 이하면 제한 없음)

  layerGapPx: 64,          // 층 하나가 사방으로 넓어지는 폭 (CSS px). 계단 한 칸의 실제 폭. 작을수록 층이 늘어 비용 증가 (권장 24~64)
  captureLongSide: 128,    // 영상 샘플링 canvas의 긴 변 (px)
  canvasLongSide: 256,     // 앰비언트 canvas 내부 해상도의 긴 변 (px)

  drmErrorLimit: 3,        // drawImage가 연속으로 실패해도 허용하는 횟수 (넘으면 그 영상은 중단)
  retry: {
    maxAttempts: 10,       // 요소를 못 찾았을 때 재시도 최대 횟수
    intervalMs: 300,       // 재시도 간격 (ms)
  },
  wrapperId: 'ambient-light-wrapper',  // 앰비언트를 담는 div의 id
  rootAttr: 'data-yt-ambient',         // <html>에 붙이는 속성 이름 (값 'on' 또는 속성 없음)
  debug: false,            // true면 콘솔에 상태 변화를 출력

  // 앰비언트 실행을 허용할 화면 모드 
  // ['default','theater','fullscreen']
  enabledModes: ['theater']
});
