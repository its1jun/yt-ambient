// 영상 속 검은 띠(레터박스)를 분석하고 측정하는 모듈 (YouTube를 모른다)
// analyzeBarStrip, createBarStabilizer = 숫자만 다루는 순수 함수. createLetterboxDetector = 영상에서 픽셀을 읽어 띠를 측정하고 확정되면 알린다

// 검은 픽셀인지 판정 (data는 RGBA 배열, index는 그 픽셀의 R 위치, 값 범위 0~255)
function isBlackPixel(data, index, sumMax, diffMax) {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  if (r + g + b > sumMax) return false;
  return Math.abs(r - g) <= diffMax && Math.abs(g - b) <= diffMax && Math.abs(b - r) <= diffMax;
}

// 가운데 값을 구한다 (개수가 짝수면 작은 쪽 가운데 값)
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// 한 줄(세로 스캔라인)에서 위/아래로 연속된 검은 픽셀 수를 센다 (단위: 행)
function countBlackRows(data, columns, height, column, options) {
  const { blackSumMax, blackChannelDiffMax } = options;
  const indexOf = (row) => (row * columns + column) * 4;
  let top = 0;
  while (top < height && isBlackPixel(data, indexOf(top), blackSumMax, blackChannelDiffMax)) top += 1;
  let bottom = 0;
  while (bottom < height && isBlackPixel(data, indexOf(height - 1 - bottom), blackSumMax, blackChannelDiffMax)) bottom += 1;
  return { top, bottom };
}

// 세로 스캔라인 이미지에서 위/아래 검은 띠 크기를 구한다
// - data: getImageData의 RGBA 배열 (가로 = columns줄, 세로 = height행)
// - 반환: { status, percent }
//   status 'ok'     → percent = 영상 높이 대비 한쪽 띠 크기(%). 띠가 없거나 minBarPercent보다 작으면 0
//   status 'black'  → 모든 줄이 끝까지 검정(화면 전체가 검음). 이번 측정은 버린다
//   status 'tooBig' → 띠가 maxBarPercent보다 큼. 이번 측정은 버린다
//   status 'invalid'→ 입력이 올바르지 않음
export function analyzeBarStrip(data, columns, height, options) {
  if (!data || !(columns >= 1) || !(height >= 1)) return { status: 'invalid', percent: 0 };

  const tops = [];
  const bottoms = [];
  let blackColumns = 0;
  for (let column = 0; column < columns; column += 1) {
    const { top, bottom } = countBlackRows(data, columns, height, column, options);
    if (top >= height) blackColumns += 1;
    tops.push(top);
    bottoms.push(bottom);
  }
  if (blackColumns === columns) return { status: 'black', percent: 0 };

  // 줄마다 값이 다를 수 있으므로(자막, 로고) 가운데 값을 쓰고, 위/아래 중 작은 쪽을 띠로 본다 (영상 내용을 자르지 않기 위해)
  const rows = Math.min(median(tops), median(bottoms));
  const rawPercent = (rows / height) * 100;
  if (rawPercent > options.maxBarPercent) return { status: 'tooBig', percent: rawPercent };
  if (rawPercent < options.minBarPercent) return { status: 'ok', percent: 0 };

  // 경계 픽셀이 섞여 가는 선이 남지 않도록 edgeMarginRows행을 더 자른다
  const margin = Math.max(0, Number(options.edgeMarginRows) || 0);
  const percent = Math.min(options.maxBarPercent, ((rows + margin) / height) * 100);
  return { status: 'ok', percent };
}

// 띠 크기를 안정화하는 도구를 만든다.
// push(percent)로 측정값(%)을 넣으면, 오차(stableTolerance) 안의 같은 값이 stableCount번 연속일 때 그 값을 돌려주고
// 아직 확정 전이면 null을 돌려준다. reset()은 처음 상태로 되돌린다
export function createBarStabilizer(options) {
  const need = Math.max(1, Math.floor(Number(options && options.stableCount) || 1));
  const tolerance = Math.max(0, Number(options && options.stableTolerance) || 0);
  let anchor = null;   // 연속 비교의 기준값 (%)
  let count = 0;       // 기준값과 같은 값이 연속으로 나온 횟수

  function push(percent) {
    if (anchor !== null && Math.abs(percent - anchor) <= tolerance) {
      count += 1;
    } else {
      anchor = percent;
      count = 1;
    }
    return count >= need ? anchor : null;
  }

  function reset() {
    anchor = null;
    count = 0;
  }

  return { push, reset };
}

// 띠 측정기를 만든다. env.createCanvas는 테스트에서 가짜 canvas를 넣기 위한 선택 인자
// 영상마다 처음에 몇 번 측정해 확정하면 그 영상에서는 더 측정하지 않는다. 측정은 작은 2D canvas로 픽셀을 읽는 일이라 WebGL 렌더링과 별개다
export function createLetterboxDetector({ config, env = {} }) {
  const createCanvas = env.createCanvas || (() => document.createElement('canvas'));
  const barOptions = config.bars || { enabled: false };
  const stabilizer = createBarStabilizer(barOptions);
  let barLocked = false;               // true면 띠 크기가 확정돼 측정을 하지 않는다
  let barStrip = null;                 // 측정용 작은 canvas (측정 중에만 있고, 확정/해제 시 버린다)
  let barStripCtx = null;
  let lastSampleMs = 0;                // 마지막으로 띠를 측정한 시각 (0 = 아직 없음)
  let emittedBars = { x: 0, y: 0 };    // 마지막으로 알린 띠 크기 (영상 대비 한쪽 %)
  let barsListener = null;             // 띠 크기가 바뀌면 부를 함수

  // 띠 측정용 canvas를 준비한다 (가로 = 스캔라인 수, 세로 = 측정 해상도). 크기가 바뀔 때만 대입한다
  function ensureBarStrip(columns, rows) {
    if (!barStrip) {
      barStrip = createCanvas();
      barStripCtx = barStrip.getContext('2d', { willReadFrequently: true });
    }
    if (barStrip.width !== columns) barStrip.width = columns;
    if (barStrip.height !== rows) barStrip.height = rows;
    return barStripCtx;
  }

  // 측정용 canvas를 버린다
  function releaseBarStrip() {
    barStrip = null;
    barStripCtx = null;
  }

  // 띠 크기가 이전에 알린 값과 다르면 듣는 쪽(controller)에 알린다 (단위: %)
  function emitBars(next) {
    if (emittedBars.x === next.x && emittedBars.y === next.y) return;
    emittedBars = next;
    if (barsListener) barsListener(next);
  }

  // 측정을 처음 상태로 되돌리고 띠를 0으로 알린다 (새 영상, 렌더 시작 때 호출)
  function reset() {
    stabilizer.reset();
    barLocked = false;
    lastSampleMs = 0;
    emitBars({ x: 0, y: 0 });
  }

  // 영상 세로 스캔라인 몇 줄을 읽어 검은 띠를 측정한다. 같은 값이 연속으로 나오면 확정하고 측정을 끝낸다
  // 확정 뒤에는 바로 돌아가므로 비용이 없다. 화면 전체가 검거나 띠가 너무 크면 그 측정은 버리고 계속한다
  function sample(video, stamp) {
    if (!barOptions.enabled || barLocked || !video) return;
    if (lastSampleMs > 0 && stamp - lastSampleMs < barOptions.measureIntervalMs) return;
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!(videoWidth > 0) || !(videoHeight > 0)) return;
    lastSampleMs = stamp;
    try {
      const columns = Math.max(1, Math.floor(barOptions.scanColumns));
      const rows = Math.max(1, Math.min(videoHeight, Math.floor(barOptions.stripHeight)));
      const stripCtx = ensureBarStrip(columns, rows);
      for (let i = 0; i < columns; i += 1) {
        // 가로로 고르게 (i + 0.5) / columns 위치의 1px 폭 세로줄을 rows 높이로 줄여 그린다
        const sx = Math.min(videoWidth - 1, Math.floor((videoWidth * (i + 0.5)) / columns));
        stripCtx.drawImage(video, sx, 0, 1, videoHeight, i, 0, 1, rows);
      }
      const { data } = stripCtx.getImageData(0, 0, columns, rows);
      const result = analyzeBarStrip(data, columns, rows, barOptions);
      if (result.status !== 'ok') return;
      const locked = stabilizer.push(result.percent);
      if (locked === null) return;
      barLocked = true;
      releaseBarStrip();
      emitBars({ x: 0, y: locked });
    } catch (error) {
      // 읽을 수 없는 영상(DRM 등)이면 이번 측정은 건너뛴다
    }
  }

  // 띠 크기가 확정/초기화될 때 부를 함수를 등록한다 (null이면 해제). 값은 { x, y } (영상 대비 한쪽 %)
  function onChange(listener) {
    barsListener = typeof listener === 'function' ? listener : null;
  }

  return { sample, reset, release: releaseBarStrip, onChange };
}
