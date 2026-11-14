import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

import ShieldTestScreen from './src/debug/ShieldTestScreen';

export default function App() {
  // Debug builds show the Shield phone test screen. The real UI comes later.
  if (__DEV__) {
    return (
      <>
        <ShieldTestScreen />
        <StatusBar style="auto" />
      </>
    );
  }
  return (
    <View style={styles.container}>
      <Text>Sahaj Maa</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
