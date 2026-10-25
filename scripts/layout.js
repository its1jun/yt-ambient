// 앰비언트 배치 계산 모듈 (순수 함수: 화면 요소에 접근하지 않고 숫자만 계산한다)

const EPSILON = 0.01;        // layoutEquals에서 같은 값으로 취급할 오차 (px)
const MAX_BAR_PERCENT = 49;  // 한쪽 띠 크기의 상한 (%). 양쪽 합이 100%를 넘어 영역이 사라지는 것을 막는 안전 장치

// 비어 있음을 나타내는 결과 (valid가 false이면 나머지 값은 의미 없음)
const INVALID_LAYOUT = Object.freeze({
  valid: false,
  wrapperBox: null,
  canvasBox: null,
  canvasPx: null,
  captureSize: null,
  feather: null,
  crop: null,
  bars: null,
  draws: Object.freeze([]),
});

// 띠 크기(%)를 0 ~ MAX_BAR_PERCENT 범위의 숫자로 정리한다 (한쪽 변 기준)
function normalizeBarPercent(value) {
  return Number.isFinite(value) && value > 0 ? Math.min(MAX_BAR_PERCENT, value) : 0;
}

// 양수인 유한한 숫자인지 확인
function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

// 위치와 크기가 모두 올바른 사각형인지 확인 (크기는 0보다 커야 함)
function isSizedRect(rect) {
  return !!rect
    && Number.isFinite(rect.left) && Number.isFinite(rect.top)
    && isPositiveNumber(rect.width) && isPositiveNumber(rect.height);
}

// 위치만 올바른 사각형인지 확인 (부모 요소용)
function isPositionedRect(rect) {
  return !!rect && Number.isFinite(rect.left) && Number.isFinite(rect.top);
}

// 영상 비율을 유지하며 긴 변이 longSide가 되는 샘플링 크기 계산 (단위: px, 최소 1)
function computeCaptureSize(videoWidth, videoHeight, longSide) {
  const aspect = videoWidth / videoHeight;
  const width = aspect > 1 ? longSide : Math.round(longSide * aspect);
  const height = aspect > 1 ? Math.round(longSide / aspect) : longSide;
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

// 영상 박스가 플레이어 안쪽으로 떨어져 있는 거리 중 가장 큰 값 (왼/오/위/아래, 단위: px)
// 이 거리만큼 층을 넓혀야 플레이어 전체가 덮인다. 영상이 플레이어보다 크면 0 이하가 된다
function computeFarthestGap(playerRect, videoRect) {
  return Math.max(
    videoRect.left - playerRect.left,
    (playerRect.left + playerRect.width) - (videoRect.left + videoRect.width),
    videoRect.top - playerRect.top,
    (playerRect.top + playerRect.height) - (videoRect.top + videoRect.height),
  );
}

// 플레이어를 덮는 데 필요한 층 개수 계산 (1 ~ maxLayers)
function computeLayerCount(playerRect, videoRect, layerGapPx, maxLayers) {
  const needed = Math.ceil(computeFarthestGap(playerRect, videoRect) / layerGapPx - 0.0001);
  return Math.min(maxLayers, Math.max(1, needed) + 1);
}

// 가장자리 투명 폭(px)을 영상 크기 대비 비율로 바꾼다 (0 ~ 0.5, 한쪽 가장자리 기준)
// 반환: { x: 가로 방향 비율, y: 세로 방향 비율 }. 0이면 그 방향은 투명 처리를 하지 않는다
function computeFeather(videoRect, layerGapPx) {
  if (!isPositiveNumber(layerGapPx)) return { x: 0, y: 0 };
  return {
    x: Math.min(0.5, layerGapPx / videoRect.width),
    y: Math.min(0.5, layerGapPx / videoRect.height),
  };
}

// 플레이어/영상 사각형(화면 기준)과 검은 띠 크기를 받아 앰비언트 배치 정보를 계산한다.
// bars = { x, y }: 영상 가로/세로 대비 한쪽 띠 크기(%). x는 좌우, y는 위아래 (없으면 띠 없음)
// 층과 가장자리 투명 폭은 띠를 뺀 영역(contentRect) 기준이다
// 반환: wrapperBox(부모 기준), canvasBox(wrapper 기준), canvasPx, captureSize, feather(가장자리 투명 비율),
//       crop(capture 이미지에서 띠를 뺀 영역, px), bars(정리된 띠 크기, %), draws(바깥층부터)
export function computeLayout({ playerRect, videoRect, parentRect, bars, config }) {
  const { layerGapPx, captureLongSide, canvasLongSide, maxLayers } = config || {};
  if (!isSizedRect(playerRect) || !isSizedRect(videoRect) || !isPositionedRect(parentRect)) {
    return INVALID_LAYOUT;
  }
  if (!isPositiveNumber(layerGapPx) || !isPositiveNumber(captureLongSide) || !isPositiveNumber(canvasLongSide) || !isPositiveNumber(maxLayers)) {
    return INVALID_LAYOUT;
  }

  // wrapper는 플레이어와 겹치게 두고, 위치는 부모 요소 기준으로 표시
  const wrapperBox = {
    left: playerRect.left - parentRect.left,
    top: playerRect.top - parentRect.top,
    width: playerRect.width,
    height: playerRect.height,
  };

  // 띠를 뺀 영상 영역 (화면 기준). 띠가 없으면 영상 박스와 같다
  const barX = normalizeBarPercent(bars && bars.x);
  const barY = normalizeBarPercent(bars && bars.y);
  const contentRect = {
    left: videoRect.left + videoRect.width * (barX / 100),
    top: videoRect.top + videoRect.height * (barY / 100),
    width: videoRect.width * (1 - (barX / 100) * 2),
    height: videoRect.height * (1 - (barY / 100) * 2),
  };
  if (!isSizedRect(contentRect)) return INVALID_LAYOUT;

  // 띠를 뺀 영역: wrapper(플레이어) 기준 상대 좌표
  const videoLeft = contentRect.left - playerRect.left;
  const videoTop = contentRect.top - playerRect.top;

  // i번째 층 = 띠를 뺀 영역을 사방으로 (layerGapPx * i) px씩 넓힌 박스 (바깥층이 먼저 오도록 큰 i부터)
  const count = computeLayerCount(playerRect, contentRect, layerGapPx, maxLayers);
  const layerBoxes = [];
  for (let i = count; i >= 1; i -= 1) {
    const grow = layerGapPx * i;
    layerBoxes.push({
      left: videoLeft - grow,
      top: videoTop - grow,
      width: contentRect.width + grow * 2,
      height: contentRect.height + grow * 2,
    });
  }

  // canvasBox: 플레이어 박스와 가장 바깥 층 박스를 모두 포함하는 사각형
  const biggest = layerBoxes[0];
  const boxLeft = Math.min(0, biggest.left);
  const boxTop = Math.min(0, biggest.top);
  const boxRight = Math.max(playerRect.width, biggest.left + biggest.width);
  const boxBottom = Math.max(playerRect.height, biggest.top + biggest.height);
  const canvasBox = {
    left: boxLeft,
    top: boxTop,
    width: boxRight - boxLeft,
    height: boxBottom - boxTop,
  };

  // canvas 내부 해상도: 긴 변이 canvasLongSide, 비율은 canvasBox와 동일
  const pxPerCss = canvasLongSide / Math.max(canvasBox.width, canvasBox.height);
  const canvasPx = {
    width: Math.max(1, Math.round(canvasBox.width * pxPerCss)),
    height: Math.max(1, Math.round(canvasBox.height * pxPerCss)),
  };

  // 각 층의 그리기 위치/크기를 canvas 내부 좌표(px)로 변환
  const scaleX = canvasPx.width / canvasBox.width;
  const scaleY = canvasPx.height / canvasBox.height;
  const draws = layerBoxes.map((box) => ({
    dx: (box.left - canvasBox.left) * scaleX,
    dy: (box.top - canvasBox.top) * scaleY,
    dw: box.width * scaleX,
    dh: box.height * scaleY,
  }));

  // capture 이미지(영상 전체)에서 띠를 뺀 영역 (capture px)
  const captureSize = computeCaptureSize(videoRect.width, videoRect.height, captureLongSide);
  const crop = {
    sx: captureSize.width * (barX / 100),
    sy: captureSize.height * (barY / 100),
    sw: captureSize.width * (1 - (barX / 100) * 2),
    sh: captureSize.height * (1 - (barY / 100) * 2),
  };

  return {
    valid: true,
    wrapperBox,
    canvasBox,
    canvasPx,
    captureSize,
    feather: computeFeather(contentRect, layerGapPx),
    crop,
    bars: { x: barX, y: barY },
    draws,
  };
}

// 두 숫자가 오차(EPSILON) 안에서 같은지 확인
function near(a, b) {
  return Math.abs(a - b) <= EPSILON;
}

// 사각형 두 개가 같은지 확인
function rectEquals(a, b) {
  return near(a.left, b.left) && near(a.top, b.top)
    && near(a.width, b.width) && near(a.height, b.height);
}

// 크기(width/height) 두 개가 같은지 확인
function sizeEquals(a, b) {
  return near(a.width, b.width) && near(a.height, b.height);
}

// 가장자리 투명 비율 두 개가 같은지 확인 (비율은 0~0.5라서 px용 오차보다 훨씬 작게 비교)
function featherEquals(a, b) {
  return Math.abs(a.x - b.x) <= 0.0001 && Math.abs(a.y - b.y) <= 0.0001;
}

// 띠를 뺀 영역(crop) 두 개가 같은지 확인
function cropEquals(a, b) {
  return near(a.sx, b.sx) && near(a.sy, b.sy) && near(a.sw, b.sw) && near(a.sh, b.sh);
}

// 띠 크기(%) 두 개가 같은지 확인
function barsEquals(a, b) {
  return Math.abs(a.x - b.x) <= 0.0001 && Math.abs(a.y - b.y) <= 0.0001;
}

// 두 배치 결과가 같은지 비교한다 (같으면 화면/렌더러 갱신을 생략하는 데 사용)
export function layoutEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.valid !== b.valid) return false;
  if (!a.valid) return true;
  if (!rectEquals(a.wrapperBox, b.wrapperBox)) return false;
  if (!rectEquals(a.canvasBox, b.canvasBox)) return false;
  if (!sizeEquals(a.canvasPx, b.canvasPx)) return false;
  if (!sizeEquals(a.captureSize, b.captureSize)) return false;
  if (!featherEquals(a.feather, b.feather)) return false;
  if (!cropEquals(a.crop, b.crop)) return false;
  if (!barsEquals(a.bars, b.bars)) return false;
  if (a.draws.length !== b.draws.length) return false;
  return a.draws.every((d, i) => near(d.dx, b.draws[i].dx) && near(d.dy, b.draws[i].dy)
    && near(d.dw, b.draws[i].dw) && near(d.dh, b.draws[i].dh));
}
