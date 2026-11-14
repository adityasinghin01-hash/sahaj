import { Btn, Pop, Screen, T, TopBar } from '@/components/sahaj/ui';
import { router } from 'expo-router';
export default function NotFoundScreen() {
  return (
    <Screen>
      <TopBar title="Page not found" />
      <Pop>
        <T v="title">Let’s get you home.</T>
        <T v="body" className="mt-3">
          This page isn’t part of your family’s app.
        </T>
        <Btn label="Go home" className="mt-6" onPress={() => router.replace('/')} />
      </Pop>
    </Screen>
  );
}
