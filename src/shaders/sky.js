/** Gradient sky dome with sun disc and horizon haze. */

export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // pin to the far plane
}`;

export const SKY_FRAG = /* glsl */ `
precision highp float;
uniform vec3 sunDir;
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.2, 1.0);
  vec3 col = mix(horizon, zenith, pow(smoothstep(-0.05, 0.9, h), 0.55));
  float s = max(dot(d, sunDir), 0.0);
  col += sunColor * (pow(s, 600.0) * 12.0 + pow(s, 12.0) * 0.28);
  col = mix(col, horizon * 0.92, smoothstep(0.0, -0.12, d.y));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
