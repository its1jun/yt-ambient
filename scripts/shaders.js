// WebGL 셰이더(GLSL) 문자열과 셰이더 안에서만 쓰는 상수 모음 (그리기 4단계: 축소 → 층 합성 → 가로 블러 → 세로 블러)
// 이 파일은 문자열만 담는다. GPU 자원 관리와 그리기 순서는 gl-pipeline.js가 맡는다

// 부채꼴 샘플링에서 중심선 양쪽으로 각각 읽는 점의 수. 한 층·한 픽셀당 읽는 횟수는 (2 × 이 값 + 1)번이다
const FAN_TAPS = 2;

// 영상을 줄여 옮길 때 목적지 픽셀 하나당 읽는 점의 수 (가로, 세로 각각). mipmap 대신 이 점들의 평균을 쓴다
const CAPTURE_TAPS = 4;

// 가우시안 블러가 중심에서 한쪽으로 다룰 수 있는 최대 칸 수 (canvas 내부 px, 짝수여야 한다). 보통은 표준편차의 3배까지 다룬다
// 이웃한 두 칸을 한 번에 읽으므로 실제 텍스처 읽기는 한쪽 기준 이 값의 절반이다
const MAX_BLUR_RADIUS = 24;

// 사각형 하나를 그리는 정점 셰이더 (두 단계가 함께 쓴다). a_corner는 (0,0)=좌상단, (1,1)=우하단인 단위 사각형
// u_rect = clip 좌표계의 (x, yTop, width, height). 위에서 아래로 그리므로 height는 음수로 넘긴다
// u_uv   = 텍스처에서 읽을 영역 (u0, v0, du, dv). v=0이 영상의 위쪽이다
export const VERTEX_SOURCE = `#version 300 es
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
export const CAPTURE_FRAGMENT_SOURCE = `#version 300 es
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
// maxLayers = 합성할 수 있는 층 수의 상한 (config.maxLayers). 셰이더의 층 배열 크기가 된다
export function buildCompositeSource(maxLayers) {
  return `#version 300 es
precision highp float;
#define MAX_LAYERS ${maxLayers}
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
  outColor = vec4(accum, covered);
}`;
}

// 층 합성 결과를 한 방향(가로 또는 세로)으로 가우시안 블러하는 조각 셰이더 (3·4단계)
// u_step = 한 칸 이동량 (텍스처 좌표), u_sigma = 표준편차 (canvas 내부 px), u_saturate = 채도 배율 (1 = 원본)
// 이웃한 두 칸(k, k+1)은 두 칸 사이의 가중 평균 위치를 LINEAR 필터로 한 번만 읽어 합친다 (결과는 두 번 읽는 것과 같다)
export const BLUR_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
#define MAX_BLUR_RADIUS ${MAX_BLUR_RADIUS}
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_step;
uniform float u_sigma;
uniform float u_saturate;
out vec4 outColor;
void main() {
  vec4 sum = texture(u_tex, v_uv);
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
    sum += (texture(u_tex, v_uv + offset) + texture(u_tex, v_uv - offset)) * w;
    weightSum += 2.0 * w;
  }
  vec4 c = sum / weightSum;
  float gray = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 rgb = mix(vec3(gray), c.rgb, u_saturate);
  outColor = vec4(clamp(rgb, 0.0, c.a), c.a);
}`;
