import { NativeModule, registerWebModule } from 'expo';

import type { SahajShieldModuleEvents } from './SahajShield.types';

// Shield is Android-only. On web the module has no methods; callers must check Platform.OS.
class SahajShieldModule extends NativeModule<SahajShieldModuleEvents> {}

export default registerWebModule(SahajShieldModule, 'SahajShieldModule');
