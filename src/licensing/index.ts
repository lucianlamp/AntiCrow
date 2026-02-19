// ---------------------------------------------------------------------------
// src/licensing/index.ts — ライセンスモジュールの公開 API
// ---------------------------------------------------------------------------

export { LicenseChecker } from './licenseChecker';
export type { LicenseStatus, LicenseType, LicenseChangeListener } from './licenseChecker';
export { LicenseGate } from './licenseGate';
export type { GateLevel } from './licenseGate';
export { LicenseStatusBar } from './licenseStatusBar';
export { registerLicenseCommands } from './licenseCommands';
