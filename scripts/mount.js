// 앰비언트 wrapper/canvas를 만들고 지우고, 배치 값을 화면에 적용하는 모듈
// (앰비언트 요소를 직접 다루는 유일한 곳. YouTube 요소를 고르는 일은 하지 않는다)

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
  function applyLayout(layout) {
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
    if (wrapper) wrapper.remove();
    wrapper = null;
    canvas = null;
    applied = {};
  }

  return { mount, applyLayout, setVisible, setRootAttr, unmount };
}
