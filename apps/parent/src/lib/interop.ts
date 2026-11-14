// NativeWind: let Reanimated's Animated.View take className (bg, size, position) on every platform.
// Without this, classes on Animated.View are dropped on web.
import { cssInterop } from 'nativewind';
import Animated from 'react-native-reanimated';

cssInterop(Animated.View, { className: 'style' });
