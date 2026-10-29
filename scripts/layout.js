// 앰비언트 배치 계산 모듈 (순수 함수: 화면 요소에 접근하지 않고 숫자만 계산한다)

const EPSILON = 0.01;        // layoutEquals에서 같은 값으로 취급할 오차 (px)
const MAX_BAR_PERCENT = 49;  // 한쪽 띠 크기의 상한 (%). 양쪽 합이 100%를 넘어 영역이 사라지는 것을 막는 안전 장치
const SNAP_TOLERANCE = 1e-6;

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
  hidden: null,
  visible: null,
  zoom: 1,
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
  return Math.min(maxLayers, Math.max(1, needed) + 2);
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

// 사각형을 자기 중심 기준으로 scale배 키우거나 줄인 사각형을 돌려준다 (CSS scale이 영상 요소에 하는 일과 같다)
export function scaleRectAboutCenter(rect, scale) {
  const width = rect.width * scale;
  const height = rect.height * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  };
}

// 원본 영상의 확대 배율을 계산한다 (1 = 확대 안 함). 확대 전 영상 사각형(videoRect)과 플레이어 사각형(화면 기준)을 받는다
// 띠를 뺀 콘텐츠를 영상 중심 기준으로 키워 플레이어를 빈틈없이 채운다
// 띠가 없으면 확대하지 않는다. 배율은 config.zoom.maxScale을 넘지 않는다
// snapEdges가 켜져 있으면 확대된 콘텐츠의 좌우 가장자리가 정수 px가 되도록 배율을 맞춘다 (바깥쪽으로 1px 안쪽만 커진다)
function computeZoom({ playerRect, videoRect, barX, barY, config }) {
  const zoom = config.zoom;
  if (!zoom || !zoom.enabled || (barX <= 0 && barY <= 0)) return 1;
  const halfWidth = (videoRect.width * (1 - (barX / 100) * 2)) / 2;
  const halfHeight = (videoRect.height * (1 - (barY / 100) * 2)) / 2;
  if (!(halfWidth > 0) || !(halfHeight > 0)) return 1;
  const removal = Math.max(videoRect.width / (halfWidth * 2), videoRect.height / (halfHeight * 2));
  const maxScale = isPositiveNumber(zoom.maxScale) ? Math.max(1, zoom.maxScale) : 1;
  const minScale = Math.max(1, Number(zoom.minScale) || 1);
  const scale = Math.min(removal, maxScale);
  if (!(scale >= minScale)) return 1;
  if (!zoom.snapEdges) return Math.round(scale * 10000) / 10000;
  const centerX = videoRect.left + videoRect.width / 2;
  let left = Math.floor(centerX - halfWidth * scale + SNAP_TOLERANCE);
  if (centerX - left > halfWidth * maxScale) left += 1;
  const snapped = (centerX - left) / halfWidth;
  return snapped >= minScale ? snapped : scale;
}

// 원본 영상이 완전히 불투명하게 가리는 영역을 canvas 내부 좌표(px)로 계산한다 (반환: { x0, y0, x1, y1 } 또는 null)
// 영상 가장자리는 CSS 마스크로 투명해지므로(띠 + videoFeatherPercent), 그 안쪽만 "가려진 영역"이다. 안쪽이 남지 않으면 null
function computeHiddenRect({ videoRect, playerRect, canvasBox, scaleX, scaleY, barX, barY, featherPercent }) {
  const feather = Number.isFinite(featherPercent) && featherPercent > 0 ? featherPercent : 0;
  const insetX = (barX + feather) / 100;
  const insetY = (barY + feather) / 100;
  if (insetX >= 0.5 || insetY >= 0.5) return null;
  const left = videoRect.left - playerRect.left - canvasBox.left + videoRect.width * insetX;
  const top = videoRect.top - playerRect.top - canvasBox.top + videoRect.height * insetY;
  const width = videoRect.width * (1 - insetX * 2);
  const height = videoRect.height * (1 - insetY * 2);
  return {
    x0: left * scaleX,
    y0: top * scaleY,
    x1: (left + width) * scaleX,
    y1: (top + height) * scaleY,
  };
}

// canvas 안에서 화면에 보일 수 있는 영역을 canvas 내부 좌표(px)로 계산한다 (반환: { x0, y0, x1, y1 } 또는 null)
// bounds = 어떤 스크롤 위치에서도 절대 보이지 않는 바깥의 경계 { left, top, right }. getBoundingClientRect와 같은 좌표(화면 기준, px)다
// 아래쪽은 스크롤하면 보일 수 있어서 제한하지 않는다. 값이 숫자가 아니면 그 방향은 제한하지 않는다
// 제한이 없거나(전부 보임) 보이는 곳이 없으면 null (null이면 전부 그린다)
function computeVisibleRect({ playerRect, canvasBox, scaleX, scaleY, bounds }) {
  if (!bounds) return null;
  const canvasLeft = playerRect.left + canvasBox.left;
  const canvasTop = playerRect.top + canvasBox.top;
  const canvasRight = canvasLeft + canvasBox.width;
  const canvasBottom = canvasTop + canvasBox.height;
  const left = Number.isFinite(bounds.left) ? Math.max(canvasLeft, bounds.left) : canvasLeft;
  const top = Number.isFinite(bounds.top) ? Math.max(canvasTop, bounds.top) : canvasTop;
  const right = Number.isFinite(bounds.right) ? Math.min(canvasRight, bounds.right) : canvasRight;
  if (!(right > left) || !(canvasBottom > top)) return null;
  const clipsNothing = left - canvasLeft <= EPSILON && top - canvasTop <= EPSILON && canvasRight - right <= EPSILON;
  if (clipsNothing) return null;
  return {
    x0: (left - canvasLeft) * scaleX,
    y0: (top - canvasTop) * scaleY,
    x1: (right - canvasLeft) * scaleX,
    y1: (canvasBottom - canvasTop) * scaleY,
  };
}

// 플레이어/영상 사각형(화면 기준)과 검은 띠 크기를 받아 앰비언트 배치 정보를 계산한다.
// bars = { x, y }: 영상 가로/세로 대비 한쪽 띠 크기(%). x는 좌우, y는 위아래 (없으면 띠 없음)
// 층과 가장자리 투명 폭은 띠를 뺀 영역(contentRect) 기준이다
// 반환: wrapperBox(부모 기준), canvasBox(wrapper 기준), canvasPx, captureSize, feather(가장자리 투명 비율),
//       crop(capture 이미지에서 띠를 뺀 영역, px), bars(정리된 띠 크기, %), hidden(원본 영상이 완전히 가리는 영역, canvas px, 없으면 null),
//       visible(화면에 보일 수 있는 canvas 영역, canvas px, 제한 없으면 null),
//       zoom(원본 영상 확대 배율, 1 = 확대 안 함), draws(바깥층부터)
// videoRect = 확대 전(CSS scale 적용 전) 영상 사각형. 확대 배율은 여기서 정하고, 이후 계산은 확대된 영상 기준이다
// bounds = 어떤 스크롤 위치에서도 보이지 않는 바깥의 경계 { left, top, right } (화면 기준 좌표, 없으면 화면 밖 건너뛰기를 하지 않는다)
export function computeLayout({ playerRect, videoRect: rawVideoRect, parentRect, bounds, bars, config }) {
  const { layerGapPx, captureLongSide, canvasLongSide, maxLayers } = config || {};
  if (!isSizedRect(playerRect) || !isSizedRect(rawVideoRect) || !isPositionedRect(parentRect)) {
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

  // 원본 영상 확대: 이후 계산은 확대된 영상 사각형 기준 (띠 %와 페더링 %는 요소 크기 대비라 같이 커진다)
  const zoom = computeZoom({ playerRect, videoRect: rawVideoRect, barX, barY, config });
  const videoRect = zoom > 1 ? scaleRectAboutCenter(rawVideoRect, zoom) : rawVideoRect;
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

  // 원본 영상이 완전히 가리는 영역 (GPU가 그리지 않아도 되는 곳). 설정이 꺼져 있으면 null
  const skipEnabled = !!(config.hiddenSkip && config.hiddenSkip.enabled);
  const hidden = skipEnabled
    ? computeHiddenRect({ videoRect, playerRect, canvasBox, scaleX, scaleY, barX, barY, featherPercent: config.videoFeatherPercent })
    : null;

  // 화면 밖(어떤 스크롤 위치에서도 보이지 않는 곳)을 뺀 canvas 영역. 설정이 꺼져 있거나 제한이 없으면 null
  const offscreenEnabled = !!(config.offscreenSkip && config.offscreenSkip.enabled);
  const visible = offscreenEnabled ? computeVisibleRect({ playerRect, canvasBox, scaleX, scaleY, bounds }) : null;

  return {
    valid: true,
    wrapperBox,
    canvasBox,
    canvasPx,
    captureSize,
    feather: computeFeather(contentRect, layerGapPx),
    crop,
    bars: { x: barX, y: barY },
    hidden,
    visible,
    zoom,
    videoBox: { left: videoRect.left, top: videoRect.top, width: videoRect.width, height: videoRect.height },   // 확대된 영상 사각형(화면 기준)
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

// 영역({ x0, y0, x1, y1 }) 두 개가 같은지 확인 (가려진 영역 hidden, 보이는 영역 visible에 쓴다. 둘 다 없으면 같음)
function hiddenEquals(a, b) {
  if (!a || !b) return a === b;
  return near(a.x0, b.x0) && near(a.y0, b.y0) && near(a.x1, b.x1) && near(a.y1, b.y1);
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
  if (!hiddenEquals(a.hidden, b.hidden)) return false;
  if (!hiddenEquals(a.visible, b.visible)) return false;
  if (Math.abs(a.zoom - b.zoom) > 0.0001) return false;
  if (!rectEquals(a.videoBox, b.videoBox)) return false;
  if (a.draws.length !== b.draws.length) return false;
  return a.draws.every((d, i) => near(d.dx, b.draws[i].dx) && near(d.dy, b.draws[i].dy)
    && near(d.dw, b.draws[i].dw) && near(d.dh, b.draws[i].dh));
}
