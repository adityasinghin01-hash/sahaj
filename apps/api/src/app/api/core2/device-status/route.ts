import { deviceRoutes } from '@/lib/core2-device/routes';
import { productionDeviceService } from '@/lib/core2-device/supabase';
export const runtime = 'nodejs';
export const { GET, POST } = deviceRoutes(productionDeviceService);
