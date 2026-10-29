// 앰비언트 wrapper/canvas를 만들고 지우고, 배치 값을 화면에 적용하는 모듈
// (앰비언트 요소를 직접 다루는 유일한 곳. YouTube 요소를 고르는 일은 하지 않는다)

// 세로 마스크를 거는 부모 상자를 영상 위아래로 더 늘리는 여유(px)
const VMASK_COVER_SLACK = 2;

// 숫자를 CSS px 문자열로 변환
function px(value) {
  return `${value}px`;
}

// 앰비언트 DOM 마운트를 만든다. env.doc은 테스트에서 가짜 document를 넣기 위한 선택 인자
export function createMount({ config, env = {} }) {
  const doc = env.doc || document;

  let wrapper = null;
  let canvas = null;
  // 마지막으로 실제 style에 쓴 값(문자열). 같은 값이면 다시 쓰지 않기 위한 캐시
  let applied = {};
  // 세로 마스크용: 마지막으로 얻은 유효한 영상 상자와 위아래 띠 크기(%). 입력이 비거나 이상할 때 대신 쓴다
  let lastBox = null;
  let lastBarY = 0;

  // 캐시와 다를 때만 style에 쓴다
  function setStyle(el, cacheKey, prop, value) {
    if (applied[cacheKey] === value) return;
    el.style[prop] = value;
    applied[cacheKey] = value;
  }

  // 검은 띠를 영상에서 잘라내는 CSS 변수를 <html>에 쓴다 (띠가 없으면 변수를 지운다)
  // clipVar-x = 좌우 띠 크기(%), clipVar-y = 위아래 띠 크기(%). clip-path와 가장자리 페더링이 둘 다 이 두 변수를 읽는다
  // 같은 값이면 다시 쓰지 않는다
  function applyClip(bars) {
    const x = bars ? bars.x : 0;
    const y = bars ? bars.y : 0;
    const inset = x > 0 || y > 0 ? `${+y.toFixed(3)}% ${+x.toFixed(3)}%` : '';
    if (applied.clip === inset) return;
    const rootStyle = doc.documentElement.style;
    const clipVar = config.bars.clipVar;
    if (inset) {
      rootStyle.setProperty(`${clipVar}-x`, `${+x.toFixed(3)}%`);
      rootStyle.setProperty(`${clipVar}-y`, `${+y.toFixed(3)}%`);
    } else {
      rootStyle.removeProperty(`${clipVar}-x`);
      rootStyle.removeProperty(`${clipVar}-y`);
    }
    applied.clip = inset;
  }

  // 원본 영상 확대 배율을 CSS 변수로 <html>에 쓴다 (1이면 변수를 지워 확대를 끈다). 같은 값이면 다시 쓰지 않는다
  function applyZoom(zoom) {
    const value = zoom > 1 ? String(zoom) : '';
    if (applied.zoom === value) return;
    const rootStyle = doc.documentElement.style;
    if (value) rootStyle.setProperty(config.zoom.scaleVar, value);
    else rootStyle.removeProperty(config.zoom.scaleVar);
    applied.zoom = value;
  }

  // box가 쓸 수 있는 값인지 (유한한 top, 0보다 큰 height)
  function isValidBox(box) {
    return !!box && Number.isFinite(box.top) && Number.isFinite(box.height) && box.height > 0;
  }

  // 영상 요소와 그 부모를 찾는다. 선택자는 ambient.css의 영상 선택자와 같아야 한다
  function findVideoAndParent() {
    try {
      const video = doc.querySelector('.html5-main-video');
      const parent = video && video.parentElement;
      return parent ? { video, parent } : null;
    } catch (e) {
      return null;
    }
  }

  // 호출자가 box를 못 줬을 때의 최후 수단: 영상과 그 부모를 직접 재서 box를 만든다
  // (getBoundingClientRect는 scale이 적용된 값이라 "확대된 영상 기준"과 같다. 스크롤은 뺄셈에서 상쇄된다)
  function measureVideoBox() {
    try {
      const found = findVideoAndParent();
      if (!found) return null;
      const v = found.video.getBoundingClientRect();
      const p = found.parent.getBoundingClientRect();
      const box = { top: v.top - p.top, height: v.height };
      return isValidBox(box) ? box : null;
    } catch (e) {
      return null;
    }
  }

  // <html> 인라인 스타일의 CSS 변수를 쓴다. 캐시가 아니라 실제 현재 값과 비교하므로, 외부에서 지워졌어도 같은 값을 다시 써 준다
  // (getPropertyValue가 없는 가짜 document에서는 캐시로 대신한다)
  function writeRootVar(name, value) {
    const style = doc.documentElement.style;
    const key = `var:${name}`;
    const current = typeof style.getPropertyValue === 'function' ? style.getPropertyValue(name) : applied[key];
    if (current === value) return;
    style.setProperty(name, value);
    applied[key] = value;
  }

  // 부모에 실제로 적용된 border 폭(계산값)을 읽는다. 지정한 값이 소수이면 브라우저가 내림해서 적용하므로(확인: 64.667px → 64px),
  // 상쇄하는 음수 margin은 지정값이 아니라 이 값을 써야 레이아웃이 밀리지 않는다. 못 읽으면 지정값을 그대로 쓴다
  function usedBorder(prop, fallback) {
    try {
      const found = findVideoAndParent();
      const win = doc.defaultView;
      if (found && win) {
        const value = win.getComputedStyle(found.parent)[prop];
        if (typeof value === 'string' && value.endsWith('px')) return value;
      }
    } catch (e) {
      // 아래 대체값을 쓴다
    }
    return fallback;
  }

  // 세로 가장자리 투명화 변수를 <html>에 쓴다. 마스크는 영상의 부모 요소에 걸리며, 마스크 이미지는 "확대된 영상 상자"와 정확히 겹친다
  //   --ambient-vmask-y = 마스크 이미지의 위쪽 위치(부모 위쪽 기준 px, 확대로 영상이 부모 위로 삐져나오면 음수)
  //   --ambient-vmask-h = 마스크 이미지 높이(= 영상 높이)
  //   --ambient-vmask-0~3 = 마스크 이미지 위쪽 기준 정지점(px)
  //   --ambient-vmask-cover-top/-bottom = 부모 상자를 영상 전체를 덮도록 늘릴 크기(px). Chromium은 마스크를 상자 주변에만 그리기 때문이다(ambient.css 참고)
  //   --ambient-vmask-margin-top/-bottom = 늘린 크기를 상쇄하는 음수 margin의 크기. 실제 적용된 border 폭과 같아야 한다
  // box = { top, height }. 이 함수는 어떤 입력에서도 변수를 빠뜨리지 않는다: box가 없거나 이상하면 직전 값 → 직접 측정 순으로 대신한다
  function applyVerticalMask(box, barYPercent) {
    if (Number.isFinite(barYPercent)) lastBarY = barYPercent;
    let useBox = isValidBox(box) ? box : null;
    if (!useBox) useBox = measureVideoBox();
    if (!useBox) useBox = lastBox;
    if (!useBox) return; // 한 번도 영상 상자를 못 얻었다. 이때만 변수가 없고, CSS는 마스크 없음(안전한 상태)으로 남는다
    lastBox = useBox;

    const height = useBox.height;
    const feather = Math.max(Number(config.videoFeatherPercent) || 0, 0);
    const half = height / 2;
    const bar = Math.min(Math.max((height * lastBarY) / 100, 0), half);
    const ramp = Math.min((height * feather) / 100, half - bar); // 두 페더가 가운데에서 겹쳐 뒤집히지 않게 한다
    const stops = [bar, bar + ramp, height - bar - ramp, height - bar].map((v) => `${+v.toFixed(3)}px`);
    // 부모 상자가 영상 전체(확대로 부모 위로 삐져나온 부분 포함)를 덮도록 위/아래로 늘릴 크기(정수 px, 여유 2px)
    const coverTop = `${Math.ceil(Math.max(-useBox.top, 0)) + VMASK_COVER_SLACK}px`;
    const coverBottom = `${Math.ceil(Math.max(useBox.top + height, 0)) + VMASK_COVER_SLACK}px`;

    stops.forEach((v, i) => writeRootVar(`--ambient-vmask-${i}`, v));
    writeRootVar('--ambient-vmask-y', `${+useBox.top.toFixed(3)}px`);
    writeRootVar('--ambient-vmask-h', `${+height.toFixed(3)}px`);
    writeRootVar('--ambient-vmask-cover-top', coverTop);
    writeRootVar('--ambient-vmask-cover-bottom', coverBottom);
    // margin은 반드시 cover를 쓴 뒤에 읽는다(방금 쓴 border가 반영된 계산값을 읽기 위해). 매 호출마다 확인하므로 줌 변경 등으로 적용 폭이 달라져도 따라간다
    writeRootVar('--ambient-vmask-margin-top', usedBorder('borderTopWidth', coverTop));
    writeRootVar('--ambient-vmask-margin-bottom', usedBorder('borderBottomWidth', coverBottom));
  }

  // 이전 실행(확장 새로고침 등)이 남긴 같은 id의 wrapper가 있으면 지운다
  function removeStaleWrapper() {
    const found = doc.getElementById(config.wrapperId);
    if (found && found !== wrapper) found.remove();
  }

  // wrapper와 canvas를 새로 만든다. 처음에는 숨김 상태(위치를 잡기 전 깜빡임 방지)
  function create() {
    applied = {};
    wrapper = doc.createElement('div');
    wrapper.id = config.wrapperId;
    wrapper.setAttribute('aria-hidden', 'true');
    wrapper.style.pointerEvents = 'none';
    wrapper.style.zIndex = '-1';
    setStyle(wrapper, 'display', 'display', 'none');

    canvas = doc.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.display = 'block';
    wrapper.appendChild(canvas);
  }

  // parent 맨 앞에 wrapper를 붙인다. 이미 있으면 기존 것을 돌려준다(멱등)
  function mount(parent) {
    removeStaleWrapper();
    if (!wrapper) create();
    if (wrapper.parentNode !== parent) parent.prepend(wrapper);
    return { wrapper, canvas };
  }

  // 배치 결과를 적용한다. 바뀐 값만 style에 쓴다 (좌표 단위: CSS px)
  // wrapperBox는 mountParent 기준, canvasBox는 wrapper 기준 좌표
  function applyLayout(layout, videoParentBox) {
    try {
      applyBoxes(layout);
    } finally {
      // 세로 마스크는 layout이 유효한지, wrapper가 있는지, 위 단계가 예외를 냈는지와 무관하게 항상 마지막에 적용한다
      // (위 단계가 일찍 return하거나 예외를 내도 마스크가 빠지지 않게 하기 위함. 확대(applyZoom)가 반영된 뒤라서 직접 측정해도 정확하다)
      // 마스크 쪽 예외는 삼켜서 위 단계의 예외를 가리지 않는다
      try {
        applyVerticalMask(videoParentBox, layout && layout.bars ? layout.bars.y : undefined);
      } catch (e) {
        console.warn('[ambient] vertical mask failed', e);
      }
    }
  }

  // wrapper/canvas 배치, 검은 띠 자르기, 확대를 적용한다 (세로 마스크는 applyLayout이 따로 처리한다)
  function applyBoxes(layout) {
    if (!wrapper || !canvas || !layout || !layout.valid) return;
    const { wrapperBox, canvasBox } = layout;

    setStyle(wrapper, 'wLeft', 'left', px(wrapperBox.left));
    setStyle(wrapper, 'wTop', 'top', px(wrapperBox.top));
    setStyle(wrapper, 'wWidth', 'width', px(wrapperBox.width));
    setStyle(wrapper, 'wHeight', 'height', px(wrapperBox.height));

    setStyle(canvas, 'cLeft', 'left', px(canvasBox.left));
    setStyle(canvas, 'cTop', 'top', px(canvasBox.top));
    setStyle(canvas, 'cWidth', 'width', px(canvasBox.width));
    setStyle(canvas, 'cHeight', 'height', px(canvasBox.height));

    applyClip(layout.bars);
    applyZoom(layout.zoom);
  }

  // 표시/숨김 (display 토글)
  function setVisible(visible) {
    if (!wrapper) return;
    setStyle(wrapper, 'display', 'display', visible ? '' : 'none');
  }

  // <html>의 속성을 켜고 끈다 (값은 'on' 또는 속성 없음)
  function setRootAttr(on) {
    const root = doc.documentElement;
    if (on) {
      root.setAttribute(config.rootAttr, 'on');
      root.style.setProperty('--video-feather', `${config.videoFeatherPercent}%`);
    } else {
      root.removeAttribute(config.rootAttr);
      root.style.removeProperty('--video-feather');
    }
  }

  // wrapper를 지우고 참조를 모두 놓는다 (<html> 속성은 건드리지 않고, clip/확대 변수만 지운다)
  function unmount() {
    doc.documentElement.style.removeProperty(`${config.bars.clipVar}-x`);
    doc.documentElement.style.removeProperty(`${config.bars.clipVar}-y`);
    doc.documentElement.style.removeProperty('--video-feather');
    doc.documentElement.style.removeProperty(config.zoom.scaleVar);
    for (let i = 0; i < 4; i += 1) doc.documentElement.style.removeProperty(`--ambient-vmask-${i}`);
    doc.documentElement.style.removeProperty('--ambient-vmask-h');
    doc.documentElement.style.removeProperty('--ambient-vmask-y');
    doc.documentElement.style.removeProperty('--ambient-vmask-cover-top');
    doc.documentElement.style.removeProperty('--ambient-vmask-cover-bottom');
    doc.documentElement.style.removeProperty('--ambient-vmask-margin-top');
    doc.documentElement.style.removeProperty('--ambient-vmask-margin-bottom');
    if (wrapper) wrapper.remove();
    wrapper = null;
    canvas = null;
    applied = {};
    lastBox = null;
    lastBarY = 0;
  }

  return { mount, applyLayout, setVisible, setRootAttr, unmount };
}
