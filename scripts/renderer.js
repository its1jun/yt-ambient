// 영상 프레임을 앰비언트 canvas 한 장에 WebGL2로 그리는 렌더러 (YouTube를 모른다. 영상/canvas는 인자로만 받는다)
import { analyzeBarStrip, createBarStabilizer } from './bars.js';

// 프레임 도착 시각의 흔들림(지터)을 흡수하는 여유 시간 (ms).
// 여유가 없으면 60fps 영상에서 30fps 제한을 걸 때 간격이 살짝 모자라 한 프레임을 더 건너뛰어 20fps처럼 보일 수 있다.
const FRAME_SLACK_MS = 2;

// 한 번에 합성할 수 있는 층 수의 상한. layout.js의 MAX_LAYER_COUNT와 같은 값이어야 한다
const MAX_LAYERS = 40;

// 부채꼴 샘플링에서 중심선 양쪽으로 각각 읽는 점의 수. 한 층·한 픽셀당 읽는 횟수는 (2 × 이 값 + 1)번이다
const FAN_TAPS = 2;

// 부채꼴 각도(config.fanAngleDeg)의 허용 범위 (도)
const MAX_FAN_ANGLE_DEG = 60;

// 영상을 줄여 옮길 때 목적지 픽셀 하나당 읽는 점의 수 (가로, 세로 각각). mipmap 대신 이 점들의 평균을 쓴다
const CAPTURE_TAPS = 4;

// 가우시안 블러가 중심에서 한쪽으로 다룰 수 있는 최대 칸 수 (canvas 내부 px, 짝수여야 한다). 보통은 표준편차의 3배까지 다룬다
// 이웃한 두 칸을 한 번에 읽으므로 실제 텍스처 읽기는 한쪽 기준 이 값의 절반이다
const MAX_BLUR_RADIUS = 24;

// video.readyState가 이 값 이상이어야 현재 프레임을 GPU로 올릴 수 있다 (HAVE_CURRENT_DATA = 2)
const MIN_READY_STATE = 2;

// 사각형 하나를 그리는 정점 셰이더 (두 단계가 함께 쓴다). a_corner는 (0,0)=좌상단, (1,1)=우하단인 단위 사각형
// u_rect = clip 좌표계의 (x, yTop, width, height). 위에서 아래로 그리므로 height는 음수로 넘긴다
// u_uv   = 텍스처에서 읽을 영역 (u0, v0, du, dv). v=0이 영상의 위쪽이다
const VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform vec4 u_rect;
uniform vec4 u_uv;
out vec2 v_local;
out vec2 v_uv;
void main() {
  v_local = a_corner;
  v_uv = u_uv.xy + a_corner * u_uv.zw;
  gl_Position = vec4(u_rect.xy + a_corner * u_rect.zw, 0.0, 1.0);
}`;

// 영상 텍스처를 줄여 옮기는 조각 셰이더 (1단계). 목적지 픽셀 하나가 덮는 영역을 격자로 나눠 읽고 평균낸다 (mipmap 없이 축소)
// u_footprint = 목적지 픽셀 하나의 크기 (텍스처 좌표, 영상 전체가 0~1)
const CAPTURE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
#define CAPTURE_TAPS ${CAPTURE_TAPS}
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_footprint;
out vec4 outColor;
void main() {
  vec3 sum = vec3(0.0);
  for (int y = 0; y < CAPTURE_TAPS; y++) {
    for (int x = 0; x < CAPTURE_TAPS; x++) {
      vec2 offset = (vec2(float(x), float(y)) + 0.5) / float(CAPTURE_TAPS) - 0.5;
      sum += texture(u_tex, v_uv + offset * u_footprint).rgb;
    }
  }
  outColor = vec4(sum / float(CAPTURE_TAPS * CAPTURE_TAPS), 1.0);
}`;

// 모든 층을 한 번에 합성하는 조각 셰이더 (2단계). 화면 전체 사각형 1장만 그린다
// u_boxes   = 층 사각형 목록 (x, y, width, height / canvas 내부 px, 바깥층이 먼저)
// u_crop    = capture 텍스처에서 읽을 영역 (u0, v0, du, dv). 층마다 이 영역을 자기 사각형에 맞춰 늘려 읽는다
// u_feather = 한쪽 가장자리에서 투명해지는 폭 (층 크기 대비 비율 0~0.5, 0이면 그 방향은 끔)
// 결과는 "바깥층부터 안쪽층 순으로 검은 바탕 위에 겹쳐 그리기"와 같다. 계산은 안쪽층부터 앞→뒤로 쌓고, 불투명해지면 바깥층 읽기를 건너뛴다 (premultiplied 알파 합성)
const COMPOSITE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
#define MAX_LAYERS ${MAX_LAYERS}
#define FAN_TAPS ${FAN_TAPS}
const float OPAQUE_LIMIT = 0.999;  // 쌓인 불투명도가 이 값 이상이면 더 바깥 층은 보이지 않으므로 읽지 않는다
in vec2 v_local;
uniform sampler2D u_tex;
uniform vec2 u_canvasSize;
uniform vec4 u_crop;
uniform vec2 u_feather;
uniform float u_fanAngle;
uniform int u_layerCount;
uniform vec4 u_boxes[MAX_LAYERS];
out vec4 outColor;

// 층 안의 위치(local)를 층 중심 기준으로 angle(라디안)만큼 돌린다. aspect = 층의 가로/세로 비율 (비율을 보정해야 원호로 돈다)
vec2 rotateAroundCenter(vec2 local, float angle, float aspect) {
  vec2 v = (local - 0.5) * vec2(aspect, 1.0);
  float s = sin(angle);
  float c = cos(angle);
  v = vec2(c * v.x - s * v.y, s * v.x + c * v.y);
  return clamp(v / vec2(aspect, 1.0) + 0.5, 0.0, 1.0);
}

// 부채꼴 샘플링: 중심에서 같은 거리인 점을 -u_fanAngle ~ +u_fanAngle 범위에서 여러 곳 읽어 평균낸다
// 가중치는 중심선이 가장 크고 부채꼴 끝으로 갈수록 0에 가까워져, 각도 범위의 가장자리가 부드럽게 사라진다
vec3 sampleFan(vec2 local, float aspect) {
  vec3 sum = vec3(0.0);
  float weightSum = 0.0;
  for (int k = -FAN_TAPS; k <= FAN_TAPS; k++) {
    float t = float(k) / float(FAN_TAPS + 1);
    float w = cos(t * 1.5707963);
    w *= w;
    vec2 p = rotateAroundCenter(local, t * u_fanAngle, aspect);
    sum += textureLod(u_tex, u_crop.xy + p * u_crop.zw, 0.0).rgb * w;
    weightSum += w;
  }
  return sum / weightSum;
}

void main() {
  vec2 pixel = v_local * u_canvasSize;
  vec3 accum = vec3(0.0);   // 지금까지 쌓인 색 (불투명도를 미리 곱한 값)
  float covered = 0.0;      // 지금까지 쌓인 불투명도 (0~1)
  for (int j = 0; j < MAX_LAYERS; j++) {
    if (j >= u_layerCount) break;
    vec4 box = u_boxes[u_layerCount - 1 - j];
    vec2 local = (pixel - box.xy) / box.zw;
    if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) continue;
    vec2 edge = min(local, 1.0 - local);
    float alphaX = u_feather.x > 0.0 ? clamp(edge.x / u_feather.x, 0.0, 1.0) : 1.0;
    float alphaY = u_feather.y > 0.0 ? clamp(edge.y / u_feather.y, 0.0, 1.0) : 1.0;
    float alpha = alphaX * alphaY;
    if (alpha <= 0.0) continue;
    vec3 color = u_fanAngle > 0.0
      ? sampleFan(local, box.z / box.w)
      : textureLod(u_tex, u_crop.xy + local * u_crop.zw, 0.0).rgb;
    accum += (1.0 - covered) * alpha * color;
    covered += (1.0 - covered) * alpha;
    if (covered >= OPAQUE_LIMIT) break;
  }
  outColor = vec4(accum, 1.0);
}`;

// 층 합성 결과를 한 방향(가로 또는 세로)으로 가우시안 블러하는 조각 셰이더 (3·4단계)
// u_step = 한 칸 이동량 (텍스처 좌표), u_sigma = 표준편차 (canvas 내부 px), u_saturate = 채도 배율 (1 = 원본)
// 이웃한 두 칸(k, k+1)은 두 칸 사이의 가중 평균 위치를 LINEAR 필터로 한 번만 읽어 합친다 (결과는 두 번 읽는 것과 같다)
const BLUR_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
#define MAX_BLUR_RADIUS ${MAX_BLUR_RADIUS}
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_step;
uniform float u_sigma;
uniform float u_saturate;
out vec4 outColor;
void main() {
  vec3 sum = texture(u_tex, v_uv).rgb;
  float weightSum = 1.0;
  int radius = min(MAX_BLUR_RADIUS, int(ceil(u_sigma * 3.0)));
  float falloff = u_sigma > 0.0 ? -0.5 / (u_sigma * u_sigma) : 0.0;
  for (int k = 1; k <= MAX_BLUR_RADIUS; k += 2) {
    if (k > radius) break;
    float w0 = exp(float(k * k) * falloff);
    float w1 = (k + 1 <= radius) ? exp(float((k + 1) * (k + 1)) * falloff) : 0.0;
    float w = w0 + w1;
    float shift = w > 0.0 ? w1 / w : 0.0;
    vec2 offset = u_step * (float(k) + shift);
    sum += (texture(u_tex, v_uv + offset).rgb + texture(u_tex, v_uv - offset).rgb) * w;
    weightSum += 2.0 * w;
  }
  vec3 color = sum / weightSum;
  float gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
  outColor = vec4(mix(vec3(gray), color, u_saturate), 1.0);
}`;

// 이번 프레임을 그려야 하는지 판단하는 순수 함수 (단위: ms, fps)
// - maxFps가 0 이하이거나 숫자가 아니면 "제한 없음"을 뜻하며 항상 true
// - lastDrawMs가 0 이하이면 "아직 한 번도 그리지 않음"을 뜻하며 항상 true
export function shouldDrawFrame(nowMs, lastDrawMs, maxFps) {
  if (!Number.isFinite(maxFps) || maxFps <= 0) return true;
  if (!Number.isFinite(lastDrawMs) || lastDrawMs <= 0) return true;
  return nowMs - lastDrawMs >= 1000 / maxFps - FRAME_SLACK_MS;
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

// 렌더러를 만든다. env는 테스트에서 가짜 canvas/시계/로그를 넣기 위한 선택 인자
export function createRenderer({ config, env = {} }) {
  const createCanvas = env.createCanvas || (() => document.createElement('canvas'));
  const now = env.now || (() => performance.now());
  const logger = env.logger || console;

  let video = null;
  let canvas = null;
  let layout = null;

  // WebGL 자원. canvas에 연결(attach)할 때 만들고 떼어낼(detach) 때 지운다
  let gl = null;
  let glReady = false;          // false이면 그리지 않는다 (자원이 없거나 컨텍스트가 유실된 상태)
  let glAbort = null;           // canvas의 컨텍스트 유실/복구 리스너를 한 번에 해제하기 위한 컨트롤러
  let captureProgram = null;    // 1단계(줄여 옮기기) 프로그램
  let captureUniforms = null;   // { rect, uv, tex } 셰이더 변수 위치
  let compositeProgram = null;  // 2단계(모든 층 합성) 프로그램
  let compositeUniforms = null; // { rect, uv, tex, canvasSize, crop, feather, layerCount, boxes } 셰이더 변수 위치
  const layerBoxes = new Float32Array(MAX_LAYERS * 4);  // 층 사각형을 셰이더로 넘기기 위한 버퍼
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

  let running = false;
  let halted = false;         // 그리기가 연속 실패해 중단된 상태 (새 attach 전까지 유지)
  let frameHandle = null;     // 예약된 프레임 콜백 번호 (없으면 null)
  let mediaAbort = null;      // 미디어 이벤트 리스너를 한 번에 해제하기 위한 컨트롤러
  let errorCount = 0;         // 그리기 연속 실패 횟수
  let lastDrawMs = 0;         // 마지막으로 그린 시각 (0 = 아직 없음)
  let warnedNoRvfc = false;
  let warnedNoGl = false;

  // 검은 띠(레터박스) 측정 상태. 영상마다 처음에 몇 번 측정해 확정하면 그 영상에서는 더 측정하지 않는다
  // 측정은 작은 2D canvas로 픽셀을 읽는 일이라 WebGL 렌더링과 별개로 그대로 둔다
  const barOptions = config.bars || { enabled: false };
  const stabilizer = createBarStabilizer(barOptions);
  let barLocked = false;               // true면 띠 크기가 확정돼 측정을 하지 않는다
  let barStrip = null;                 // 측정용 작은 canvas (측정 중에만 있고, 확정/해제 시 버린다)
  let barStripCtx = null;
  let lastSampleMs = 0;                // 마지막으로 띠를 측정한 시각 (0 = 아직 없음)
  let emittedBars = { x: 0, y: 0 };    // 마지막으로 알린 띠 크기 (영상 대비 한쪽 %)
  let barsListener = null;             // 띠 크기가 바뀌면 부를 함수

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
    compositeProgram = createProgram(gl, VERTEX_SOURCE, COMPOSITE_FRAGMENT_SOURCE);
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

  // 컨텍스트가 복구되면 자원을 다시 만들고 바로 한 프레임을 그린다
  function onContextRestored() {
    if (!canvas || !gl) return;
    try {
      buildGlResources();
      applySizes();
      if (running) drawFrame(now());
    } catch (error) {
      handleDrawError(error);
    }
  }

  // canvas에서 WebGL2 컨텍스트를 얻고 자원을 만든다. 쓸 수 없으면 false (한 번만 경고)
  // alpha:false(불투명)로 만든다. 가장자리가 투명해지는 곳이 YouTube 배경 대신 검은색으로 채워진다
  function setupGl() {
    gl = canvas.getContext('webgl2', {
      alpha: false,
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
  function resetBars() {
    stabilizer.reset();
    barLocked = false;
    lastSampleMs = 0;
    emitBars({ x: 0, y: 0 });
  }

  // 영상 세로 스캔라인 몇 줄을 읽어 검은 띠를 측정한다. 같은 값이 연속으로 나오면 확정하고 측정을 끝낸다
  // 확정 뒤에는 바로 돌아가므로 비용이 없다. 화면 전체가 검거나 띠가 너무 크면 그 측정은 버리고 계속한다
  function sampleBars(stamp) {
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

  // 같은 video 요소에 다른 영상이 들어오면 띠 측정을 처음부터 다시 한다
  function onSourceChange() {
    resetBars();
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

  // 현재 영상 프레임을 videoTexture로 올린다 (mipmap은 만들지 않는다. 축소는 캡처 셰이더가 격자로 읽어 처리)
  // 올릴 프레임이 아직 없으면 false (오류가 아니므로 실패 횟수에 넣지 않는다)
  // 영상 크기가 바뀌면 텍스처를 새로 할당하고, 같으면 내용만 덮어쓴다
  function uploadVideoFrame() {
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

  // 배치가 바뀐 뒤 첫 프레임 전에, 합성 셰이더가 쓰는 값(층 사각형, 읽을 영역, 투명 폭, canvas 크기)을 올린다
  // 이 값들은 배치가 바뀔 때만 달라지므로 프레임마다 올리지 않는다. 프로그램을 쓰는 중(useProgram 뒤)에 불러야 한다
  function uploadLayoutUniforms() {
    const { crop, captureSize, feather, draws } = layout;
    const u = compositeUniforms;
    layerCount = Math.min(MAX_LAYERS, draws.length);
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
    gl.uniform1f(u.fanAngle, (fanDeg * Math.PI) / 180);
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
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // 3·4단계: 합성 결과를 가로, 세로로 가우시안 블러하고 채도를 적용해 canvas에 그린다
  // 블러 크기는 config.blurPx(CSS px, CSS blur()의 표준편차와 같은 뜻)를 canvas 내부 px로 바꿔 쓴다
  function renderBlur() {
    const { canvasBox, canvasPx } = layout;
    const blurCssPx = Math.max(0, Number(config.blurPx) || 0);
    const sigma = blurCssPx * (canvasPx.width / canvasBox.width);
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
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 세로 패스: blurTexture → canvas (화면에는 위에서 아래로 그리므로 높이는 음수)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, blurTexture);
    gl.uniform4f(u.rect, -1, 1, 2, -2);
    gl.uniform2f(u.step, 0, 1 / canvas.height);
    gl.uniform1f(u.saturate, saturate);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // 한 프레임을 그린다: 영상 → GPU 텍스처(1회) → 줄여 옮기기 → 모든 층을 한 번에 합성 → 블러
  // 띠 측정은 이 안에서 간격(measureIntervalMs)마다 한 번씩만 한다
  // stamp는 그린 시각(ms). 성공하면 lastDrawMs로 기록
  function drawFrame(stamp) {
    if (!video || !canvas || !gl || !glReady || halted) return;
    if (!layout || !layout.valid) return;
    try {
      if (!uploadVideoFrame()) return;
      renderCapture();
      renderLayers();
      renderBlur();
      errorCount = 0;
      lastDrawMs = stamp;
      sampleBars(stamp);
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
    setupGl();
    halted = false;
    errorCount = 0;
    lastDrawMs = 0;
    resetBars();
    applySizes();
  }

  // 배치 결과를 반영한다. 실행 중이면 지워진 canvas를 바로 다시 그린다(일시정지 중에도 빈 화면이 되지 않도록)
  function setLayout(nextLayout) {
    layout = nextLayout || null;
    layoutDirty = true;
    applySizes();
    if (running) drawFrame(now());
  }

  // 렌더 루프를 시작한다 (멱등). 시작 시 1프레임을 바로 그리고, 재생 중일 때만 프레임 콜백을 예약한다
  function start() {
    if (running || halted || !video || !canvas || !gl) return;
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
    resetBars();
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
    releaseBarStrip();
    if (glAbort) {
      glAbort.abort();
      glAbort = null;
    }
    releaseGlResources();
    gl = null;
    video = null;
    canvas = null;
  }

  // 모든 것을 해제한다
  function destroy() {
    detach();
    layout = null;
  }

  // 띠 크기가 확정/초기화될 때 부를 함수를 등록한다 (null이면 해제). 값은 { x, y } (영상 대비 한쪽 %)
  function onBarsChange(listener) {
    barsListener = typeof listener === 'function' ? listener : null;
  }

  return { attach, setLayout, start, stop, detach, destroy, onBarsChange };
}
