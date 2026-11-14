// Hidden route: long-press the app title on Home for 3 s. Shield phone test screen (T1–T6, Phase 2).
import { SafeAreaView } from 'react-native-safe-area-context';

import ShieldTestScreen from '@/debug/ShieldTestScreen';

export default function Debug() {
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: '#fff' }}>
      <ShieldTestScreen />
    </SafeAreaView>
  );
}
