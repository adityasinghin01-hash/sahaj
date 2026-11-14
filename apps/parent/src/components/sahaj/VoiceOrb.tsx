// Voice orb (native): Skia runtime shader, ChatGPT-voice-mode style. Breathes when idle,
// flows and pulses faster while listening. Web uses VoiceOrb.web.tsx (no CanvasKit download).
import { Canvas, Circle, Fill, RadialGradient, Shader, Skia, useClock, vec } from '@shopify/react-native-skia';
import * as React from 'react';
import { useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';

import { ORB_SKSL } from '@/components/sahaj/orbShader';

const effect = Skia.RuntimeEffect.Make(ORB_SKSL);

export function VoiceOrb({ size, listening }: { size: number; listening: boolean }) {
  const clock = useClock();
  const energy = useSharedValue(0);
  React.useEffect(() => {
    energy.value = withTiming(listening ? 1 : 0, { duration: listening ? 450 : 900 });
  }, [listening, energy]);
  const uniforms = useDerivedValue(() => ({ res: [size, size], t: clock.value / 1000, energy: energy.value }));

  if (!effect) {
    // Shader failed to compile on this device: calm static gradient instead.
    return (
      <Canvas style={{ width: size, height: size }}>
        <Circle cx={size / 2} cy={size / 2} r={size * 0.37}>
          <RadialGradient c={vec(size * 0.4, size * 0.35)} r={size * 0.45} colors={['#F8E6E0', '#C5523A', '#1F7A72']} />
        </Circle>
      </Canvas>
    );
  }
  return (
    <Canvas style={{ width: size, height: size }}>
      <Fill>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
    </Canvas>
  );
}
