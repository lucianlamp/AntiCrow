// ---------------------------------------------------------------------------
// src/licensing/index.ts — ライセンスモジュールの公開 API
// ---------------------------------------------------------------------------

export { LicenseChecker } from './licenseChecker';
export type { LicenseStatus, LicenseType, LicenseReason, LicenseCache, LicenseChangeListener } from './licenseChecker';
export { LicenseGate, FREE_DAILY_TASK_LIMIT, FREE_WEEKLY_TASK_LIMIT, PRO_ONLY_FEATURES, PURCHASE_URL, PURCHASE_URL_MONTHLY, PURCHASE_URL_LIFETIME } from './licenseGate';
export type { GateLevel } from './licenseGate';
export { registerLicenseCommands } from './licenseCommands';
