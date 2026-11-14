// SkSL for the voice orb: a soft fluid terracotta/teal blob.
// Uniforms: res (canvas px), t (seconds), energy (0 idle → 1 listening).
// Idle: slow breathing and gentle edge wobble. Listening: faster flow, bigger wobble, brighter halo.
export const ORB_SKSL = `
uniform float2 res;
uniform float t;
uniform float energy;

const float3 terracotta = float3(0.773, 0.322, 0.227);
const float3 teal = float3(0.122, 0.478, 0.447);
const float3 cream = float3(0.992, 0.976, 0.973);
const float3 deep = float3(0.494, 0.184, 0.122);

half4 main(float2 p) {
  float2 uv = (p - res * 0.5) / (min(res.x, res.y) * 0.5);
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float sp = mix(0.55, 2.2, energy);

  // Edge: sum of slow sine lobes, larger when listening.
  float wob = 0.030 * sin(3.0 * a + t * sp * 1.30)
            + 0.024 * sin(5.0 * a - t * sp * 1.70 + 1.3)
            + 0.018 * sin(2.0 * a + t * sp * 0.90 + 2.1);
  wob *= 0.75 + energy * 1.7;
  float breathe = mix(0.022, 0.035, energy) * sin(t * mix(1.1, 4.2, energy));
  float R = 0.74 + wob + breathe;

  // Fluid colour: two warped sine fields mixing terracotta and teal.
  float2 q = uv * 1.5;
  float tt = t * sp;
  float n1 = sin(q.x * 2.1 + tt * 0.7 + sin(q.y * 3.1 - tt * 0.5));
  float n2 = sin(q.y * 2.6 - tt * 0.6 + sin(q.x * 2.4 + tt * 0.45));
  float n = clamp((n1 + n2) * 0.25 + 0.5, 0.0, 1.0);
  float3 col = mix(terracotta, teal, smoothstep(0.25, 0.85, n));
  col = mix(col, deep, smoothstep(0.55, 1.0, r / R) * 0.35);

  // Soft highlight top-left, like light on glass.
  float hl = 1.0 - smoothstep(0.0, 0.85, length(uv - float2(-0.26, -0.34)));
  col = mix(col, cream, hl * 0.42);

  float inside = 1.0 - smoothstep(R - 0.025, R + 0.005, r);
  float halo = (1.0 - smoothstep(R, R + 0.28, r)) * mix(0.16, 0.34, energy);
  float3 haloCol = mix(terracotta, teal, 0.5 + 0.5 * sin(t * 0.6));
  float alpha = inside + halo * (1.0 - inside);
  float3 outc = mix(haloCol, col, inside);
  return half4(half3(outc * alpha), half(alpha));
}
`;
