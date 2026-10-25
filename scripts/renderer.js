// 영상 프레임을 앰비언트 canvas 한 장에 그리는 렌더러의 프레임 루프 (YouTube를 모른다. 영상/canvas는 인자로만 받는다)
// 재생/일시정지/시크, fps 제한, 연속 오류 중단, 검은 띠 측정 호출을 맡고, WebGL 그리기는 gl-pipeline.js에 맡긴다
import { createLetterboxDetector } from './letterbox.js';
import { createGlPipeline } from './gl-pipeline.js';

// 프레임 도착 시각의 흔들림(지터)을 흡수하는 여유 시간 (ms).
// 여유가 없으면 60fps 영상에서 30fps 제한을 걸 때 간격이 살짝 모자라 한 프레임을 더 건너뛰어 20fps처럼 보일 수 있다.
const FRAME_SLACK_MS = 2;

// 이번 프레임을 그려야 하는지 판단하는 순수 함수 (단위: ms, fps)
// - maxFps가 0 이하이거나 숫자가 아니면 "제한 없음"을 뜻하며 항상 true
// - lastDrawMs가 0 이하이면 "아직 한 번도 그리지 않음"을 뜻하며 항상 true
export function shouldDrawFrame(nowMs, lastDrawMs, maxFps) {
  if (!Number.isFinite(maxFps) || maxFps <= 0) return true;
  if (!Number.isFinite(lastDrawMs) || lastDrawMs <= 0) return true;
  return nowMs - lastDrawMs >= 1000 / maxFps - FRAME_SLACK_MS;
}

// 렌더러를 만든다. env는 테스트에서 가짜 canvas/시계/로그를 넣기 위한 선택 인자
export function createRenderer({ config, env = {} }) {
  const now = env.now || (() => performance.now());
  const logger = env.logger || console;

  let video = null;
  let canvas = null;
  let layout = null;

  let running = false;
  let halted = false;         // 그리기가 연속 실패해 중단된 상태 (새 attach 전까지 유지)
  let frameHandle = null;     // 예약된 프레임 콜백 번호 (없으면 null)
  let mediaAbort = null;      // 미디어 이벤트 리스너를 한 번에 해제하기 위한 컨트롤러
  let errorCount = 0;         // 그리기 연속 실패 횟수
  let lastDrawMs = 0;         // 마지막으로 그린 시각 (0 = 아직 없음)
  let warnedNoRvfc = false;

  // 검은 띠 측정기. 확정/초기화되면 onBarsChange로 등록된 함수에 알린다
  const detector = createLetterboxDetector({ config, env });

  // WebGL 자원 관리와 4단계 그리기. 컨텍스트가 복구되면 실행 중일 때 바로 한 프레임을 그린다
  const pipeline = createGlPipeline({
    config,
    logger,
    onRestored: () => {
      if (running) drawFrame(now());
    },
    onError: (error) => handleDrawError(error),
  });

  // 같은 video 요소에 다른 영상이 들어오면 띠 측정을 처음부터 다시 한다
  function onSourceChange() {
    detector.reset();
  }

  // 예약된 프레임 콜백이 있으면 취소한다
  function cancelFrame() {
    if (frameHandle !== null && video) video.cancelVideoFrameCallback(frameHandle);
    frameHandle = null;
  }

  // 그리기가 연속으로 실패하면 이 영상은 더 이상 그리지 않는다
  function handleDrawError(error) {
    errorCount += 1;
    if (errorCount < Math.max(1, config.drmErrorLimit || 1)) return;
    halted = true;
    stop();
    logger.debug('[yt-ambient] Rendering stopped after consecutive draw failures.', error);
  }

  // 한 프레임을 그린다: 그리기는 gl-pipeline이 하고, 성공했을 때만 오류 횟수 초기화와 띠 측정을 한다
  // 띠 측정은 이 안에서 간격(measureIntervalMs)마다 한 번씩만 한다
  // stamp는 그린 시각(ms). 성공하면 lastDrawMs로 기록
  function drawFrame(stamp) {
    if (!video || !canvas || halted) return;
    try {
      if (!pipeline.draw(video)) return;
      errorCount = 0;
      lastDrawMs = stamp;
      detector.sample(video, stamp);
    } catch (error) {
      handleDrawError(error);
    }
  }

  // 다음 프레임 콜백을 예약한다. 이미 예약돼 있거나 멈춰야 하는 상태면 아무것도 하지 않는다
  function scheduleFrame() {
    if (frameHandle !== null || !running || halted || !video || video.paused) return;
    frameHandle = video.requestVideoFrameCallback(onFrame);
  }

  // 새 영상 프레임이 준비될 때마다 불리는 콜백. fps 제한을 넘는 프레임은 그리지 않고 건너뛴다
  function onFrame(frameNow) {
    frameHandle = null;
    if (!running || halted) return;
    scheduleFrame();
    if (shouldDrawFrame(frameNow, lastDrawMs, config.maxFps)) drawFrame(frameNow);
  }

  function onPlay() {
    scheduleFrame();
  }

  function onPause() {
    cancelFrame();
  }

  // 일시정지 중에 시크하면 프레임 콜백이 오지 않으므로 직접 1프레임 갱신
  function onSeeked() {
    if (video && video.paused) drawFrame(now());
  }

  // 영상과 canvas를 연결한다. 이전 연결이 있으면 먼저 해제한다
  function attach(nextVideo, nextCanvas) {
    detach();
    video = nextVideo;
    canvas = nextCanvas;
    pipeline.setup(canvas);
    halted = false;
    errorCount = 0;
    lastDrawMs = 0;
    detector.reset();
    pipeline.setLayout(layout);
  }

  // 배치 결과를 반영한다. 실행 중이면 지워진 canvas를 바로 다시 그린다(일시정지 중에도 빈 화면이 되지 않도록)
  function setLayout(nextLayout) {
    layout = nextLayout || null;
    pipeline.setLayout(layout);
    if (running) drawFrame(now());
  }

  // 렌더 루프를 시작한다 (멱등). 시작 시 1프레임을 바로 그리고, 재생 중일 때만 프레임 콜백을 예약한다
  function start() {
    if (running || halted || !video || !canvas || !pipeline.hasGl()) return;
    if (typeof video.requestVideoFrameCallback !== 'function') {
      if (!warnedNoRvfc) {
        warnedNoRvfc = true;
        logger.warn('[yt-ambient] requestVideoFrameCallback is not supported, so the ambient light is disabled.');
      }
      return;
    }
    running = true;
    mediaAbort = new AbortController();
    const options = { signal: mediaAbort.signal };
    video.addEventListener('play', onPlay, options);
    video.addEventListener('pause', onPause, options);
    video.addEventListener('seeked', onSeeked, options);
    video.addEventListener('loadstart', onSourceChange, options);
    video.addEventListener('emptied', onSourceChange, options);
    detector.reset();
    drawFrame(now());
    scheduleFrame();
  }

  // 렌더 루프와 미디어 이벤트 리스너를 모두 해제한다 (멱등)
  function stop() {
    if (mediaAbort) {
      mediaAbort.abort();
      mediaAbort = null;
    }
    cancelFrame();
    running = false;
  }

  // 멈추고 WebGL 자원과 영상/canvas 참조를 놓는다 (이후 다시 쓰려면 attach 필요)
  function detach() {
    stop();
    detector.release();
    pipeline.release();
    video = null;
    canvas = null;
  }

  // WebGL 컨텍스트를 얻어 attach가 성공한 상태인지 알려준다 (얻지 못했으면 false)
  function hasGl() {
    return pipeline.hasGl();
  }

  // 모든 것을 해제한다
  function destroy() {
    detach();
    layout = null;
    pipeline.setLayout(null);
  }

  // 띠 크기가 확정/초기화될 때 부를 함수를 등록한다 (null이면 해제). 값은 { x, y } (영상 대비 한쪽 %)
  function onBarsChange(listener) {
    detector.onChange(listener);
  }

  return { attach, setLayout, start, stop, detach, destroy, onBarsChange, hasGl };
}
