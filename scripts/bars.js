// 영상 속 검은 띠(레터박스) 계산 모듈 (순수 함수: 화면 요소에 접근하지 않고 숫자만 다룬다)

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
