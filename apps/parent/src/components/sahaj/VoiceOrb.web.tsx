// Voice orb (web): same look without Skia/CanvasKit. Two soft gradient blobs drift inside a
// breathing circle; listening speeds them up and grows the halo.
import { LinearGradient } from 'expo-linear-gradient';
import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

export function VoiceOrb({ size, listening }: { size: number; listening: boolean }) {
  const spin = useSharedValue(0);
  const breathe = useSharedValue(0);
  const energy = useSharedValue(0);

  React.useEffect(() => {
    energy.value = withTiming(listening ? 1 : 0, { duration: 500 });
    cancelAnimation(spin);
    cancelAnimation(breathe);
    spin.value = 0;
    breathe.value = 0;
    spin.value = withRepeat(withTiming(1, { duration: listening ? 2600 : 9000, easing: Easing.linear }), -1, false);
    breathe.value = withRepeat(withTiming(1, { duration: listening ? 520 : 2600, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [listening, spin, breathe, energy]);

  const d = size * 0.74;
  const body = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + breathe.value * (0.03 + energy.value * 0.05) }],
  }));
  const blob = useAnimatedStyle(() => ({ transform: [{ translateX: Math.sin(spin.value * Math.PI * 2) * d * 0.12 }, { rotate: `${-spin.value * 720}deg` }] }));
  const halo = useAnimatedStyle(() => ({
    opacity: 0.18 + energy.value * 0.2,
    transform: [{ scale: 1.08 + breathe.value * (0.04 + energy.value * 0.1) }],
  }));

  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      <Animated.View style={[halo, { width: d, height: d, borderRadius: d, position: 'absolute' }]} className="bg-teal" />
      <Animated.View style={[body, { width: d, height: d, borderRadius: d, overflow: 'hidden' }]}>
        <LinearGradient colors={['#C5523A', '#A9432E', '#1F7A72']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1 }} />
        <Animated.View style={[blob, { position: 'absolute', left: d * 0.2, top: d * 0.35, width: d * 0.9, height: d * 0.7, borderRadius: d }]}>
          <LinearGradient colors={['rgba(31,122,114,0)', 'rgba(31,122,114,0.85)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1, borderRadius: d }} />
        </Animated.View>
        <View style={{ position: 'absolute', left: d * 0.12, top: d * 0.08, width: d * 0.5, height: d * 0.4, borderRadius: d, backgroundColor: 'rgba(253,249,248,0.32)' }} />
      </Animated.View>
    </View>
  );
}
