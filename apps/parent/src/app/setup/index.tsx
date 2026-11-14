import { Redirect } from 'expo-router';

export default function SetupStart() {
  return <Redirect href={{ pathname: '/setup/[step]', params: { step: 'pair' } }} />;
}
