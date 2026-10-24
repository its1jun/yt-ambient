// 앰비언트 라이트의 모든 설정값을 모아둔 단일 출처 (다른 파일에서 숫자를 직접 쓰지 않는다)
export const CONFIG = Object.freeze({
  blurPx: 24,              // 흐림 정도 (CSS px). 층 간격(layerGapPx)의 약 2배 안팎이면 계단이 뭉개져 부드러운 확산광이 된다
  saturate: 1.0,           // 채도 배율 (1 = 원본)
  videoFeatherPercent: 20, // 유튜브 원본 영상 가장자리 페더링 폭 (%)
  maxFps: 15,              // 초당 그리기 상한 (0 이하면 제한 없음)

  layerGapPx: 48,          // 층 하나가 사방으로 넓어지는 폭 (CSS px). 계단 한 칸의 실제 폭. 작을수록 층이 늘어 비용 증가 (권장 24~64)
  captureLongSide: 192,    // 영상 샘플링 canvas의 긴 변 (px)
  canvasLongSide: 288,     // 앰비언트 canvas 내부 해상도의 긴 변 (px)
  fanAngleDeg: 15,         // 부채꼴 한쪽 각도 (도, 0~60). 층의 색을 중심에서 이 각도 안으로 퍼뜨려 평균내어 방사형 줄무늬를 흐린다. 0이면 끔(기존 모습). 클수록 넓게 퍼진다

  // 앰비언트 실행을 허용할 화면 모드 
  // ['default','theater','fullscreen']
  enabledModes: ['theater'],

  drmErrorLimit: 3,        // drawImage가 연속으로 실패해도 허용하는 횟수 (넘으면 그 영상은 중단)
  retry: {
    maxAttempts: 10,       // 요소를 못 찾았을 때 재시도 최대 횟수
    intervalMs: 300,       // 재시도 간격 (ms)
  },
  wrapperId: 'ambient-light-wrapper',  // 앰비언트를 담는 div의 id
  rootAttr: 'data-yt-ambient',         // <html>에 붙이는 속성 이름 (값 'on' 또는 속성 없음)
  debug: false,            // true면 콘솔에 상태 변화를 출력

  // 영상 속 검은 띠(레터박스) 검출/제거. 영상마다 처음에 몇 번 측정해 확정하고, 이후에는 다시 측정하지 않는다
  bars: {
    enabled: true,           // false면 검출과 제거를 모두 끈다
    blackSumMax: 16,         // 검은색으로 보는 R+G+B 합의 상한 (0~765)
    blackChannelDiffMax: 3,  // 검은색으로 보는 R/G/B 채널 사이 차이의 상한 (0~255)
    maxBarPercent: 38,       // 영상 높이 대비 한쪽 띠 크기의 상한 (%). 넘으면 오검출로 보고 그 측정은 버린다
    minBarPercent: 1,        // 이보다 작은 띠는 없는 것(0)으로 본다 (%)
    edgeMarginRows: 1,       // 경계 선이 남지 않도록 띠보다 더 자르는 행 수 (측정 이미지 기준)
    scanColumns: 5,          // 측정에 쓰는 세로 스캔라인 개수 (가로로 고르게 배치)
    stripHeight: 360,        // 측정 이미지의 세로 해상도 상한 (px)
    measureIntervalMs: 300,  // 측정 간격 (ms)
    stableCount: 3,          // 같은 값이 연속 몇 번 나오면 확정할지
    stableTolerance: 0.5,    // 같은 값으로 볼 오차 (%p)
    clipVar: '--ambient-clip-inset',  // <html>에 넣는 CSS 변수 이름 (styles/ambient.css의 이름과 같아야 한다)
  }
});
