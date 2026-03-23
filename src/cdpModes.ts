// ---------------------------------------------------------------------------
// cdpModes.ts — ファサード（後方互換 re-export）
// ---------------------------------------------------------------------------
// 元の巨大ファイルを以下のモジュールに分割:
//   - cdpModeScripts.ts : モードボタン検出用 JS スニペット
//   - cdpModeQuery.ts   : getCurrentMode, getAvailableModes, ModeDebugEntry
//   - cdpModeSelect.ts  : selectMode
//
// 既存の import { ... } from './cdpModes' を壊さないよう、
// 全公開シンボルをここから re-export する。
// ---------------------------------------------------------------------------

export { getCurrentMode, getAvailableModes } from './cdpModeQuery';
export type { ModeDebugEntry } from './cdpModeQuery';
export { selectMode } from './cdpModeSelect';
