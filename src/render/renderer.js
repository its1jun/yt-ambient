// 영상 프레임을 앰비언트 canvas 한 장에 그리는 렌더러 (YouTube를 모른다. 영상/canvas는 인자로만 받는다)

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
  const createCanvas = env.createCanvas || (() => document.createElement('canvas'));
  const now = env.now || (() => performance.now());
  const logger = env.logger || console;

  let video = null;
  let canvas = null;
  let ctx = null;
  let captureCanvas = null;   // 영상을 작게 한 번 옮겨 담는 화면 밖 canvas
  let captureCtx = null;
  let layout = null;
  let featherH = null;      // 가로 방향 가장자리 그라데이션 (capture canvas 크기가 바뀔 때만 새로 만듦)
  let featherV = null;      // 세로 방향 가장자리 그라데이션
  let featherKey = '';      // 그라데이션을 만들 때의 크기/폭 (같으면 재사용)

  let running = false;
  let halted = false;         // drawImage가 연속 실패해 중단된 상태 (새 attach 전까지 유지)
  let frameHandle = null;     // 예약된 프레임 콜백 번호 (없으면 null)
  let mediaAbort = null;      // 미디어 이벤트 리스너를 한 번에 해제하기 위한 컨트롤러
  let errorCount = 0;         // drawImage 연속 실패 횟수
  let lastDrawMs = 0;         // 마지막으로 그린 시각 (0 = 아직 없음)
  let warnedNoRvfc = false;

  // canvas 내부 해상도를 layout에 맞춘다. 값이 바뀔 때만 대입한다 (대입하면 canvas가 지워지므로)
  // 하나라도 바꿨으면 true
  function applySizes() {
    if (!layout || !layout.valid) return false;
    let changed = false;
    const { captureSize, canvasPx } = layout;
    if (captureCanvas && (captureCanvas.width !== captureSize.width || captureCanvas.height !== captureSize.height)) {
      captureCanvas.width = captureSize.width;
      captureCanvas.height = captureSize.height;
      changed = true;
    }
    if (canvas && (canvas.width !== canvasPx.width || canvas.height !== canvasPx.height)) {
      canvas.width = canvasPx.width;
      canvas.height = canvasPx.height;
      changed = true;
    }
    return changed;
  }

  // 예약된 프레임 콜백이 있으면 취소한다
  function cancelFrame() {
    if (frameHandle !== null && video) video.cancelVideoFrameCallback(frameHandle);
    frameHandle = null;
  }

  // drawImage가 연속으로 실패하면 이 영상은 더 이상 그리지 않는다
  function handleDrawError(error) {
    errorCount += 1;
    if (errorCount < Math.max(1, config.drmErrorLimit || 1)) return;
    halted = true;
    stop();
    logger.debug('[yt-ambient] drawImage가 연속 실패해 렌더링을 중단했습니다.', error);
  }

  // 그라데이션에 "양 끝은 투명, 안쪽은 불투명" 색 정지점을 넣는다 (feather: 0~0.5, 한쪽 끝에서의 비율)
  function buildFeatherGradient(gradient, feather) {
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(feather, 'rgba(0,0,0,1)');
    gradient.addColorStop(1 - feather, 'rgba(0,0,0,1)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    return gradient;
  }

  // capture canvas에 그려진 영상의 가장자리를 투명하게 깎는다 (이 이미지를 넓혀 겹치므로 층 경계가 부드러워진다)
  // 투명 폭은 layout.feather(영상 대비 비율, 가로/세로 따로)에서 읽는다. config의 px 값은 layout.js가 비율로 바꿔 준다
  // destination-in: 이미 그려진 그림에 "투명도만" 곱한다. 가로, 세로 순서로 두 번 곱하면 네 변이 모두 사라진다
  function applyFeather() {
    const { width, height } = captureCanvas;
    const featherX = Math.min(0.5, Number(layout.feather && layout.feather.x) || 0);
    const featherY = Math.min(0.5, Number(layout.feather && layout.feather.y) || 0);
    if (featherX <= 0 && featherY <= 0) return;
    const key = `${width}x${height}x${featherX}x${featherY}`;
    if (key !== featherKey) {
      featherKey = key;
      featherH = featherX > 0 ? buildFeatherGradient(captureCtx.createLinearGradient(0, 0, width, 0), featherX) : null;
      featherV = featherY > 0 ? buildFeatherGradient(captureCtx.createLinearGradient(0, 0, 0, height), featherY) : null;
    }
    captureCtx.globalCompositeOperation = 'destination-in';
    if (featherH) {
      captureCtx.fillStyle = featherH;
      captureCtx.fillRect(0, 0, width, height);
    }
    if (featherV) {
      captureCtx.fillStyle = featherV;
      captureCtx.fillRect(0, 0, width, height);
    }
    captureCtx.globalCompositeOperation = 'source-over';
  }

  // 한 프레임을 그린다: 영상 → capture(1회) → 가장자리 투명 처리 → 바깥층부터 안쪽층 순으로 canvas에 겹쳐 그림
  // stamp는 그린 시각(ms). 성공하면 lastDrawMs로 기록
  function drawFrame(stamp) {
    if (!video || !canvas || !ctx || !captureCtx || halted) return;
    if (!layout || !layout.valid) return;
    try {
      captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
      applyFeather();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const d of layout.draws) {
        ctx.drawImage(captureCanvas, d.dx, d.dy, d.dw, d.dh);
      }
      errorCount = 0;
      lastDrawMs = stamp;
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
  // 앰비언트 canvas는 alpha:false(불투명)로 만든다. 가장자리가 투명해지는 곳이 YouTube 배경 대신 검은색으로 채워진다
  function attach(nextVideo, nextCanvas) {
    detach();
    video = nextVideo;
    canvas = nextCanvas;
    ctx = canvas.getContext('2d', { alpha: false });
    if (!captureCanvas) {
      captureCanvas = createCanvas();
      captureCtx = captureCanvas.getContext('2d');
    }
    halted = false;
    errorCount = 0;
    lastDrawMs = 0;
    applySizes();
  }

  // 배치 결과를 반영한다. 실행 중이면 지워진 canvas를 바로 다시 그린다(일시정지 중에도 빈 화면이 되지 않도록)
  function setLayout(nextLayout) {
    layout = nextLayout || null;
    applySizes();
    if (running) drawFrame(now());
  }

  // 렌더 루프를 시작한다 (멱등). 시작 시 1프레임을 바로 그리고, 재생 중일 때만 프레임 콜백을 예약한다
  function start() {
    if (running || halted || !video || !canvas) return;
    if (typeof video.requestVideoFrameCallback !== 'function') {
      if (!warnedNoRvfc) {
        warnedNoRvfc = true;
        logger.warn('[yt-ambient] 이 브라우저는 requestVideoFrameCallback을 지원하지 않아 동작하지 않습니다.');
      }
      return;
    }
    running = true;
    mediaAbort = new AbortController();
    const options = { signal: mediaAbort.signal };
    video.addEventListener('play', onPlay, options);
    video.addEventListener('pause', onPause, options);
    video.addEventListener('seeked', onSeeked, options);
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

  // 멈추고 영상/canvas 참조를 놓는다 (이후 다시 쓰려면 attach 필요)
  function detach() {
    stop();
    video = null;
    canvas = null;
    ctx = null;
  }

  // 모든 것을 해제한다
  function destroy() {
    detach();
    captureCanvas = null;
    captureCtx = null;
    layout = null;
  }

  return { attach, setLayout, start, stop, detach, destroy };
}
