import { Notice } from '../sahaj/ui';
import { useDeviceBattery } from '../../lib/useDeviceStatus';
import { useCore2Text } from './common';
export function DeviceBatteryBanner() {
  const { battery_level } = useDeviceBattery();
  const t = useCore2Text();
  return battery_level !== null && battery_level <= 15
    ? <Notice tone="sand">{t('phoneLow')}</Notice> : null;
}
