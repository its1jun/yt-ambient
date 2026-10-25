// WebGL 자원(셰이더 프로그램, 텍스처, 프레임버퍼)을 관리하고 영상 한 프레임을 canvas에 그리는 모듈 (YouTube를 모른다)
// 그리기 4단계: 축소(capture) → 층 합성(composite) → 가로 블러 → 세로 블러. 컨텍스트 유실/복구도 여기서 처리한다
// 프레임 루프, fps 제한, 연속 오류 중단은 renderer.js가 맡는다
import {
  VERTEX_SOURCE,
  CAPTURE_FRAGMENT_SOURCE,
  buildCompositeSource,
  BLUR_FRAGMENT_SOURCE,
  MAX_BLUR_RADIUS,
  FAN_TAPS,
} from './shaders.js';

// 부채꼴 각도(config.fanAngleDeg)의 허용 범위 (도)
const MAX_FAN_ANGLE_DEG = 60;

// video.readyState가 이 값 이상이어야 현재 프레임을 GPU로 올릴 수 있다 (HAVE_CURRENT_DATA = 2)
const MIN_READY_STATE = 2;

// 바깥 범위(outer) 안에서 구멍(hole)을 뺀 나머지를 덮는 사각형 목록 (위/아래/왼쪽/오른쪽 띠). 좌표는 canvas 내부 px, 위쪽이 y=0이다
// outer = { x0, y0, x1, y1 } 그릴 수 있는 범위. hole = { x0, y0, x1, y1 } 건너뛸 구멍 (null이면 구멍 없음, outer 밖으로 나간 부분은 무시한다)
function complementRects(outer, hole) {
  const width = outer.x1 - outer.x0;
  const whole = [{ x: outer.x0, y: outer.y0, w: width, h: outer.y1 - outer.y0 }];
  if (!hole) return whole.filter((rect) => rect.w > 0 && rect.h > 0);
  const cut = {
    x0: Math.max(hole.x0, outer.x0),
    y0: Math.max(hole.y0, outer.y0),
    x1: Math.min(hole.x1, outer.x1),
    y1: Math.min(hole.y1, outer.y1),
  };
  if (cut.x1 <= cut.x0 || cut.y1 <= cut.y0) return whole.filter((rect) => rect.w > 0 && rect.h > 0);
  return [
    { x: outer.x0, y: outer.y0, w: width, h: cut.y0 - outer.y0 },
    { x: outer.x0, y: cut.y1, w: width, h: outer.y1 - cut.y1 },
    { x: outer.x0, y: cut.y0, w: cut.x0 - outer.x0, h: cut.y1 - cut.y0 },
    { x: cut.x1, y: cut.y0, w: outer.x1 - cut.x1, h: cut.y1 - cut.y0 },
  ].filter((rect) => rect.w > 0 && rect.h > 0);
}

// 셰이더 하나를 컴파일한다. 실패하면 로그를 담은 오류를 던진다
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

// 정점/조각 셰이더를 묶어 프로그램을 만든다. 실패하면 로그를 담은 오류를 던진다
function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log}`);
  }
  return program;
}

// 텍스처 하나를 만들고 필터/가장자리 규칙을 정한다 (minFilter: 축소할 때의 필터)
function createTexture(gl, minFilter) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

// 파이프라인을 만든다
// onRestored = 컨텍스트가 복구돼 자원을 다시 만든 뒤 부르는 함수 (실행 중이면 한 프레임 다시 그리게 한다)
// onError = 복구 중 자원 재생성이 실패했을 때 부르는 함수 (오류를 인자로 받는다)
export function createGlPipeline({ config, logger, onRestored, onError }) {
  let canvas = null;
  let layout = null;

  // WebGL 자원. setup 때 만들고 release 때 지운다
  let gl = null;
  let glReady = false;          // false이면 그리지 않는다 (자원이 없거나 컨텍스트가 유실된 상태)
  let glAbort = null;           // canvas의 컨텍스트 유실/복구 리스너를 한 번에 해제하기 위한 컨트롤러
  let captureProgram = null;    // 1단계(줄여 옮기기) 프로그램
  let captureUniforms = null;   // { rect, uv, tex } 셰이더 변수 위치
  let compositeProgram = null;  // 2단계(모든 층 합성) 프로그램
  let compositeUniforms = null; // { rect, uv, tex, canvasSize, crop, feather, layerCount, boxes } 셰이더 변수 위치
  const maxLayers = config.maxLayers;   // 합성 층 수 상한 (셰이더 배열 크기와 같다)
  const layerBoxes = new Float32Array(maxLayers * 4);  // 층 사각형을 셰이더로 넘기기 위한 버퍼
  const fanTaps = new Float32Array((FAN_TAPS * 2 + 1) * 3);  // 부채꼴 점마다 (cos, sin, 정규화된 가중치). 셰이더로 넘기기 위한 버퍼
  let layerCount = 0;           // 실제로 합성할 층 수
  let layoutDirty = true;       // true면 다음 프레임 전에 배치 관련 셰이더 값을 다시 올린다
  let quadVao = null;           // 단위 사각형 정점 묶음
  let quadBuffer = null;
  let videoTexture = null;      // 영상 프레임이 올라가는 텍스처 (축소용 mipmap 포함)
  let videoTextureWidth = 0;    // videoTexture에 현재 할당된 크기 (0 = 아직 없음)
  let videoTextureHeight = 0;
  let captureTexture = null;    // 영상을 작게 한 번 옮겨 담는 텍스처 (captureSize 크기)
  let captureFramebuffer = null;
  let captureWidth = 0;         // captureTexture에 현재 할당된 크기 (0 = 아직 없음)
  let captureHeight = 0;

  let blurProgram = null;       // 3·4단계(가로/세로 블러) 프로그램
  let blurUniforms = null;      // { rect, uv, tex, step, sigma, saturate } 셰이더 변수 위치
  let sceneTexture = null;      // 층 합성 결과가 담기는 텍스처 (canvas 내부 해상도)
  let sceneFramebuffer = null;
  let blurTexture = null;       // 가로 블러 결과가 담기는 텍스처 (canvas 내부 해상도)
  let blurFramebuffer = null;
  let targetWidth = 0;          // sceneTexture/blurTexture에 현재 할당된 크기 (0 = 아직 없음)
  let targetHeight = 0;
  let skipPlan = null;          // 가려진 영역을 빼고 그릴 사각형 목록 { composite, horizontal, vertical }. null이면 전부 그린다
  let warnedNoGl = false;

  // captureTexture를 지정한 크기로 (다시) 할당하고 프레임버퍼에 연결한다 (단위: px)
  function allocateCapture(width, height) {
    gl.bindTexture(gl.TEXTURE_2D, captureTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, captureFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, captureTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    captureWidth = width;
    captureHeight = height;
  }

  // sceneTexture와 blurTexture를 지정한 크기로 (다시) 할당하고 각 프레임버퍼에 연결한다 (단위: px)
  function allocateTargets(width, height) {
    [[sceneTexture, sceneFramebuffer], [blurTexture, blurFramebuffer]].forEach(([texture, framebuffer]) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    targetWidth = width;
    targetHeight = height;
  }

  // 셰이더, 정점, 텍스처, 프레임버퍼를 만든다 (컨텍스트가 새로 생겼거나 복구됐을 때 호출)
  function buildGlResources() {
    captureProgram = createProgram(gl, VERTEX_SOURCE, CAPTURE_FRAGMENT_SOURCE);
    captureUniforms = {
      rect: gl.getUniformLocation(captureProgram, 'u_rect'),
      uv: gl.getUniformLocation(captureProgram, 'u_uv'),
      tex: gl.getUniformLocation(captureProgram, 'u_tex'),
      footprint: gl.getUniformLocation(captureProgram, 'u_footprint'),
    };
    compositeProgram = createProgram(gl, VERTEX_SOURCE, buildCompositeSource(maxLayers));
    compositeUniforms = {
      rect: gl.getUniformLocation(compositeProgram, 'u_rect'),
      uv: gl.getUniformLocation(compositeProgram, 'u_uv'),
      tex: gl.getUniformLocation(compositeProgram, 'u_tex'),
      canvasSize: gl.getUniformLocation(compositeProgram, 'u_canvasSize'),
      crop: gl.getUniformLocation(compositeProgram, 'u_crop'),
      feather: gl.getUniformLocation(compositeProgram, 'u_feather'),
      fanAngle: gl.getUniformLocation(compositeProgram, 'u_fanAngle'),
      layerCount: gl.getUniformLocation(compositeProgram, 'u_layerCount'),
      boxes: gl.getUniformLocation(compositeProgram, 'u_boxes'),
      fanTaps: gl.getUniformLocation(compositeProgram, 'u_fanTaps'),
    };
    blurProgram = createProgram(gl, VERTEX_SOURCE, BLUR_FRAGMENT_SOURCE);
    blurUniforms = {
      rect: gl.getUniformLocation(blurProgram, 'u_rect'),
      uv: gl.getUniformLocation(blurProgram, 'u_uv'),
      tex: gl.getUniformLocation(blurProgram, 'u_tex'),
      step: gl.getUniformLocation(blurProgram, 'u_step'),
      sigma: gl.getUniformLocation(blurProgram, 'u_sigma'),
      saturate: gl.getUniformLocation(blurProgram, 'u_saturate'),
    };

    // 단위 사각형 (TRIANGLE_STRIP 순서: 좌상, 우상, 좌하, 우하)
    quadVao = gl.createVertexArray();
    gl.bindVertexArray(quadVao);
    quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    videoTexture = createTexture(gl, gl.LINEAR);
    captureTexture = createTexture(gl, gl.LINEAR);
    captureFramebuffer = gl.createFramebuffer();
    sceneTexture = createTexture(gl, gl.LINEAR);
    sceneFramebuffer = gl.createFramebuffer();
    blurTexture = createTexture(gl, gl.LINEAR);
    blurFramebuffer = gl.createFramebuffer();
    targetWidth = 0;
    targetHeight = 0;
    videoTextureWidth = 0;
    videoTextureHeight = 0;
    captureWidth = 0;
    captureHeight = 0;
    layoutDirty = true;
    glReady = true;
  }

  // WebGL 자원을 모두 지운다 (이미 지워졌거나 컨텍스트가 유실돼도 안전하다)
  function releaseGlResources() {
    glReady = false;
    if (gl) {
      if (captureProgram) gl.deleteProgram(captureProgram);
      if (compositeProgram) gl.deleteProgram(compositeProgram);
      if (blurProgram) gl.deleteProgram(blurProgram);
      if (quadBuffer) gl.deleteBuffer(quadBuffer);
      if (quadVao) gl.deleteVertexArray(quadVao);
      if (videoTexture) gl.deleteTexture(videoTexture);
      if (captureTexture) gl.deleteTexture(captureTexture);
      if (captureFramebuffer) gl.deleteFramebuffer(captureFramebuffer);
      if (sceneTexture) gl.deleteTexture(sceneTexture);
      if (sceneFramebuffer) gl.deleteFramebuffer(sceneFramebuffer);
      if (blurTexture) gl.deleteTexture(blurTexture);
      if (blurFramebuffer) gl.deleteFramebuffer(blurFramebuffer);
    }
    captureProgram = null;
    captureUniforms = null;
    compositeProgram = null;
    compositeUniforms = null;
    quadVao = null;
    quadBuffer = null;
    videoTexture = null;
    captureTexture = null;
    captureFramebuffer = null;
    videoTextureWidth = 0;
    videoTextureHeight = 0;
    captureWidth = 0;
    captureHeight = 0;
    blurProgram = null;
    blurUniforms = null;
    sceneTexture = null;
    sceneFramebuffer = null;
    blurTexture = null;
    blurFramebuffer = null;
    targetWidth = 0;
    targetHeight = 0;
  }

  // 컨텍스트가 GPU 문제로 유실되면 복구될 때까지 그리기를 멈춘다 (preventDefault가 있어야 복구가 시도된다)
  function onContextLost(event) {
    event.preventDefault();
    glReady = false;
  }

  // 컨텍스트가 복구되면 자원을 다시 만들고 renderer에 알린다 (실행 중이면 renderer가 바로 한 프레임을 그린다)
  function onContextRestored() {
    if (!canvas || !gl) return;
    try {
      buildGlResources();
      applySizes();
      onRestored();
    } catch (error) {
      onError(error);
    }
  }

  // canvas를 받아 WebGL2 컨텍스트를 얻고 자원을 만든다. 쓸 수 없으면 false (한 번만 경고)
  // alpha:false(불투명)로 만든다. 가장자리가 투명해지는 곳이 YouTube 배경 대신 검은색으로 채워진다
  function setup(nextCanvas) {
    canvas = nextCanvas;
    gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      if (!warnedNoGl) {
        warnedNoGl = true;
        logger.warn('[yt-ambient] WebGL2 is not available, so the ambient light is disabled.');
      }
      return false;
    }
    glAbort = new AbortController();
    const options = { signal: glAbort.signal };
    canvas.addEventListener('webglcontextlost', onContextLost, options);
    canvas.addEventListener('webglcontextrestored', onContextRestored, options);
    try {
      buildGlResources();
    } catch (error) {
      logger.warn('[yt-ambient] Failed to set up WebGL resources.', error);
      releaseGlResources();
      gl = null;
      return false;
    }
    return true;
  }

  // canvas 내부 해상도와 capture 텍스처 크기를 layout에 맞춘다. 값이 바뀔 때만 대입한다 (대입하면 canvas가 지워지므로)
  // 하나라도 바꿨으면 true
  function applySizes() {
    if (!layout || !layout.valid) return false;
    let changed = false;
    const { captureSize, canvasPx } = layout;
    if (glReady && (captureWidth !== captureSize.width || captureHeight !== captureSize.height)) {
      allocateCapture(captureSize.width, captureSize.height);
      changed = true;
    }
    if (glReady && (targetWidth !== canvasPx.width || targetHeight !== canvasPx.height)) {
      allocateTargets(canvasPx.width, canvasPx.height);
      changed = true;
    }
    if (canvas && (canvas.width !== canvasPx.width || canvas.height !== canvasPx.height)) {
      canvas.width = canvasPx.width;
      canvas.height = canvasPx.height;
      changed = true;
    }
    return changed;
  }

  // 현재 영상 프레임을 videoTexture로 올린다 (mipmap은 만들지 않는다. 축소는 캡처 셰이더가 격자로 읽어 처리)
  // 올릴 프레임이 아직 없으면 false (오류가 아니므로 실패 횟수에 넣지 않는다)
  // 영상 크기가 바뀌면 텍스처를 새로 할당하고, 같으면 내용만 덮어쓴다
  function uploadVideoFrame(video) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (video.readyState < MIN_READY_STATE || !(width > 0) || !(height > 0)) return false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    if (width !== videoTextureWidth || height !== videoTextureHeight) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      videoTextureWidth = width;
      videoTextureHeight = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    return true;
  }

  // 1단계: 영상 전체를 captureSize 크기의 captureTexture에 줄여 옮긴다 (가장자리 처리 없음)
  // 프레임버퍼의 0번째 줄이 영상의 위쪽이 되도록 clip 좌표를 (-1,-1)부터 잡는다
  function renderCapture() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, captureFramebuffer);
    gl.viewport(0, 0, captureWidth, captureHeight);
    gl.disable(gl.BLEND);
    gl.useProgram(captureProgram);
    gl.bindVertexArray(quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.uniform1i(captureUniforms.tex, 0);
    gl.uniform4f(captureUniforms.rect, -1, -1, 2, 2);
    gl.uniform4f(captureUniforms.uv, 0, 0, 1, 1);
    gl.uniform2f(captureUniforms.footprint, 1 / captureWidth, 1 / captureHeight);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // 배치가 바뀐 뒤 첫 프레임 전에, 합성 셰이더가 쓰는 값(층 사각형, 읽을 영역, 투명 폭, canvas 크기, 부채꼴 점)을 올린다
  // 이 값들은 배치가 바뀔 때만 달라지므로 프레임마다 올리지 않는다. 프로그램을 쓰는 중(useProgram 뒤)에 불러야 한다
  function uploadLayoutUniforms() {
    const { crop, captureSize, feather, draws } = layout;
    const u = compositeUniforms;
    layerCount = Math.min(maxLayers, draws.length);
    for (let i = 0; i < layerCount; i += 1) {
      const d = draws[i];
      layerBoxes[i * 4] = d.dx;
      layerBoxes[i * 4 + 1] = d.dy;
      layerBoxes[i * 4 + 2] = d.dw;
      layerBoxes[i * 4 + 3] = d.dh;
    }
    if (layerCount > 0) gl.uniform4fv(u.boxes, layerBoxes.subarray(0, layerCount * 4));
    gl.uniform1i(u.layerCount, layerCount);
    gl.uniform2f(u.canvasSize, canvas.width, canvas.height);
    // 읽을 영역은 가장자리에서 반 칸(텍셀) 안쪽으로 줄인다. 잘라 낸 검은 띠가 보간으로 번져 들어오지 않게 한다
    const halfTexelX = 0.5 / captureSize.width;
    const halfTexelY = 0.5 / captureSize.height;
    gl.uniform4f(
      u.crop,
      crop.sx / captureSize.width + halfTexelX,
      crop.sy / captureSize.height + halfTexelY,
      crop.sw / captureSize.width - halfTexelX * 2,
      crop.sh / captureSize.height - halfTexelY * 2,
    );
    gl.uniform2f(
      u.feather,
      Math.min(0.5, Number(feather && feather.x) || 0),
      Math.min(0.5, Number(feather && feather.y) || 0),
    );
    // 부채꼴 각도: 도(0~MAX_FAN_ANGLE_DEG)를 라디안으로 바꿔 올린다. 0이면 셰이더가 부채꼴을 건너뛴다
    const fanDeg = Math.min(MAX_FAN_ANGLE_DEG, Math.max(0, Number(config.fanAngleDeg) || 0));
    const fanAngle = (fanDeg * Math.PI) / 180;
    gl.uniform1f(u.fanAngle, fanAngle);
    // 부채꼴 점마다 cos/sin/가중치를 미리 계산한다. 점 위치 t는 -1~1 사이 (중심선 = 0), 가중치는 중심선이 가장 크고 끝으로 갈수록 0에 가깝다
    let weightSum = 0;
    for (let k = -FAN_TAPS; k <= FAN_TAPS; k += 1) {
      const t = k / (FAN_TAPS + 1);
      const weight = Math.cos((t * Math.PI) / 2) ** 2;
      const i = (k + FAN_TAPS) * 3;
      fanTaps[i] = Math.cos(t * fanAngle);
      fanTaps[i + 1] = Math.sin(t * fanAngle);
      fanTaps[i + 2] = weight;
      weightSum += weight;
    }
    for (let i = 2; i < fanTaps.length; i += 3) fanTaps[i] /= weightSum;   // 가중치의 합이 1이 되게 한다
    gl.uniform3fv(u.fanTaps, fanTaps);
    layoutDirty = false;
  }

  // 2단계: 화면 전체 사각형 1장으로 모든 층을 합성해 sceneTexture에 그린다 (층 순서는 셰이더가 픽셀마다 계산)
  // 셰이더가 모든 픽셀을 직접 채우므로 따로 지우지 않고, GPU 블렌딩도 쓰지 않는다
  function renderLayers() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFramebuffer);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(compositeProgram);
    gl.bindVertexArray(quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, captureTexture);
    gl.uniform1i(compositeUniforms.tex, 0);
    gl.uniform4f(compositeUniforms.rect, -1, -1, 2, 2);   // 텍스처에 그릴 때는 0번째 줄이 위쪽이 되도록 (-1,-1)부터 잡는다
    gl.uniform4f(compositeUniforms.uv, 0, 0, 1, 1);
    if (layoutDirty) uploadLayoutUniforms();
    drawQuad(skipPlan && skipPlan.composite, canvas.height, false);
  }

  // 블러 표준편차를 canvas 내부 px로 계산한다 (config.blurPx는 CSS px)
  function computeBlurSigma() {
    const { canvasBox, canvasPx } = layout;
    const blurCssPx = Math.max(0, Number(config.blurPx) || 0);
    return blurCssPx * (canvasPx.width / canvasBox.width);
  }

  // 각 단계에서 그릴 사각형 목록(skipPlan)을 만든다 (배치가 바뀔 때만 호출)
  // 그릴 곳 = 화면에 보일 수 있는 영역(layout.visible) 안에서, 원본 영상이 가리는 영역(layout.hidden)을 뺀 곳
  // 주변 블러가 읽는 칸은 건너뛴 곳에서도 필요하므로, 앞 단계일수록 보이는 영역은 블러 반경만큼 넓히고 가려진 영역은 블러 반경만큼 줄인다
  //   세로 블러(최종) = 여유만큼 / 가로 블러 = 위아래를 반경만큼 더 / 층 합성 = 사방을 반경만큼 더
  function buildSkipPlan() {
    skipPlan = null;
    const hidden = layout && layout.valid ? layout.hidden : null;
    const visible = layout && layout.valid ? layout.visible : null;
    if (!hidden && !visible) return;
    const { width, height } = layout.canvasPx;
    const skipConfig = config.hiddenSkip || {};
    const margin = Math.max(0, Number(skipConfig.marginPx) || 0);
    // 블러 셰이더가 실제로 읽는 최대 거리 + 선형 보간 여유 1칸
    const reach = Math.min(MAX_BLUR_RADIUS, Math.ceil(computeBlurSigma() * 3)) + 1;
    const plan = (insetX, insetY) => {
      // 그릴 수 있는 바깥 범위: 보이는 영역을 여유만큼 넓힌 것 (없으면 canvas 전체)
      const outer = visible
        ? {
          x0: Math.max(0, Math.floor(visible.x0 - insetX)),
          y0: Math.max(0, Math.floor(visible.y0 - insetY)),
          x1: Math.min(width, Math.ceil(visible.x1 + insetX)),
          y1: Math.min(height, Math.ceil(visible.y1 + insetY)),
        }
        : { x0: 0, y0: 0, x1: width, y1: height };
      // 건너뛸 구멍: 가려진 영역을 여유만큼 줄인 것 (남는 게 없으면 구멍 없음)
      let hole = null;
      if (hidden) {
        const inner = {
          x0: Math.max(0, Math.ceil(hidden.x0 + insetX)),
          y0: Math.max(0, Math.ceil(hidden.y0 + insetY)),
          x1: Math.min(width, Math.floor(hidden.x1 - insetX)),
          y1: Math.min(height, Math.floor(hidden.y1 - insetY)),
        };
        if (inner.x1 > inner.x0 && inner.y1 > inner.y0) hole = inner;
      }
      if (!visible && !hole) return null;
      return complementRects(outer, hole);
    };
    skipPlan = {
      composite: plan(margin + reach, margin + reach),
      horizontal: plan(margin, margin + reach),
      vertical: plan(margin, margin),
    };
  }

  // 전체 사각형 1장을 그린다. rects가 있으면 그 사각형들 안쪽만 그린다 (scissor: 밖은 GPU가 계산하지 않는다)
  // flipY = 최종 canvas에 그릴 때 true (GL 좌표는 아래가 0이고, 텍스처 대상은 위쪽이 0)
  function drawQuad(rects, height, flipY) {
    if (!rects) {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }
    gl.enable(gl.SCISSOR_TEST);
    for (let i = 0; i < rects.length; i += 1) {
      const r = rects[i];
      gl.scissor(r.x, flipY ? height - r.y - r.h : r.y, r.w, r.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  // 3·4단계: 합성 결과를 가로, 세로로 가우시안 블러하고 채도를 적용해 canvas에 그린다
  // 블러 크기는 config.blurPx(CSS px, CSS blur()의 표준편차와 같은 뜻)를 canvas 내부 px로 바꿔 쓴다
  function renderBlur() {
    const sigma = computeBlurSigma();
    const saturate = Number.isFinite(config.saturate) ? config.saturate : 1;
    const u = blurUniforms;
    gl.useProgram(blurProgram);
    gl.bindVertexArray(quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.tex, 0);
    gl.uniform4f(u.uv, 0, 0, 1, 1);
    gl.uniform1f(u.sigma, sigma);

    // 가로 패스: sceneTexture → blurTexture (채도는 마지막 패스에서 한 번만 적용)
    gl.bindFramebuffer(gl.FRAMEBUFFER, blurFramebuffer);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
    gl.uniform4f(u.rect, -1, -1, 2, 2);
    gl.uniform2f(u.step, 1 / canvas.width, 0);
    gl.uniform1f(u.saturate, 1);
    drawQuad(skipPlan && skipPlan.horizontal, canvas.height, false);

    // 세로 패스: blurTexture → canvas (화면에는 위에서 아래로 그리므로 높이는 음수)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, blurTexture);
    gl.uniform4f(u.rect, -1, 1, 2, -2);
    gl.uniform2f(u.step, 0, 1 / canvas.height);
    gl.uniform1f(u.saturate, saturate);
    drawQuad(skipPlan && skipPlan.vertical, canvas.height, true);
  }

  // 배치 결과를 반영한다 (null이면 배치 없음). 값이 바뀔 때만 canvas 크기를 대입한다
  function setLayout(nextLayout) {
    layout = nextLayout || null;
    layoutDirty = true;
    buildSkipPlan();
    applySizes();
  }

  // 영상의 현재 프레임으로 4단계를 그린다 (축소 → 층 합성 → 가로 블러 → 세로 블러)
  // 그릴 수 없거나(자원/배치/영상 프레임 없음) 아직 그릴 프레임이 없으면 false, 그렸으면 true. 그리기 실패는 예외로 던진다
  function draw(video) {
    if (!canvas || !gl || !glReady) return false;
    if (!layout || !layout.valid) return false;
    if (!uploadVideoFrame(video)) return false;
    renderCapture();
    renderLayers();
    renderBlur();
    return true;
  }

  // WebGL 자원과 컨텍스트 리스너를 모두 지우고 canvas 참조를 놓는다 (이미 지워졌어도 안전하다)
  function release() {
    if (glAbort) {
      glAbort.abort();
      glAbort = null;
    }
    releaseGlResources();
    gl = null;
    canvas = null;
  }

  // WebGL 컨텍스트를 얻었는지 알려준다 (얻지 못했으면 false)
  function hasGl() {
    return gl !== null;
  }

  return { setup, setLayout, draw, release, hasGl };
}
