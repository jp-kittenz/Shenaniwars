/** GLSL for the mobile post-processing chain (fullscreen-triangle passes). */

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Bright-pass + 4-tap downsample (scene -> half res). */
export const BRIGHT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform vec2 texel;
uniform float threshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tScene, vUv + texel * vec2(-1.0, -1.0)).rgb
         + texture2D(tScene, vUv + texel * vec2( 1.0, -1.0)).rgb
         + texture2D(tScene, vUv + texel * vec2(-1.0,  1.0)).rgb
         + texture2D(tScene, vUv + texel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = smoothstep(threshold, threshold * 2.0, luma);
  gl_FragColor = vec4(min(c * w, vec3(8.0)), 1.0);
}`;

/** Separable 9-tap gaussian using 5 bilinear fetches. */
export const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tInput, vUv).rgb * 0.2270270270;
  c += texture2D(tInput, vUv + dir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tInput, vUv - dir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tInput, vUv + dir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tInput, vUv - dir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

/**
 * Composite: crease-style SSAO from the depth buffer, bloom add, ACES tone
 * map, stylised split-tone colour grade, vignette, damage flash, sRGB encode.
 * SSAO is compiled out entirely unless USE_SSAO is defined.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tDepth;
uniform vec2 texel;
uniform float near;
uniform float far;
uniform float bloomStrength;
uniform float aoStrength;
uniform float damage;
uniform float exposure;
varying vec2 vUv;

float linDepth(vec2 uv) {
  float ndc = texture2D(tDepth, uv).x * 2.0 - 1.0;
  return 2.0 * near * far / (far + near - ndc * (far - near));
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 col = texture2D(tScene, vUv).rgb;

#ifdef USE_SSAO
  float d0 = linDepth(vUv);
  if (d0 > 1.4 && d0 < 90.0) { // skip the first-person view-model
    // Opposing sample pairs: a flat surface averages to its own depth, so only
    // concave creases (contact points, wall bases, under vehicles) darken.
    float ang = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
    vec2 rot = vec2(cos(ang), sin(ang));
    float aspect = texel.y / texel.x;
    float radius = clamp(0.3 / d0, 0.002, 0.022);
    float bias = 0.03 + d0 * 0.004;
    float occ = 0.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float a = fi * 0.7853982;
      vec2 dir = vec2(cos(a) * rot.x - sin(a) * rot.y, cos(a) * rot.y + sin(a) * rot.x);
      vec2 off = dir * radius * (0.45 + 0.18 * fi) * vec2(1.0, aspect);
      float crease = d0 - 0.5 * (linDepth(vUv + off) + linDepth(vUv - off));
      occ += smoothstep(bias, bias * 5.0, crease) * (1.0 - smoothstep(0.35, 0.9, crease));
    }
    col *= 1.0 - aoStrength * occ * 0.25 * (1.0 - smoothstep(60.0, 90.0, d0));
  }
#endif

  col += texture2D(tBloom, vUv).rgb * bloomStrength;
  col = aces(col * exposure);

  // Split-tone grade: cool shadows, warm highlights, gentle S-curve and saturation lift.
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, 1.14);
  col *= mix(vec3(0.94, 1.0, 1.07), vec3(1.06, 1.01, 0.93), smoothstep(0.0, 0.8, luma));
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.35);

  vec2 q = vUv - 0.5;
  float vig = dot(q, q);
  col *= 1.0 - vig * 0.55;
  col = mix(col, vec3(0.75, 0.05, 0.03), clamp(damage * vig * 2.6, 0.0, 0.8));

  gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;
