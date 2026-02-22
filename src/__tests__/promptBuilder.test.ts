// ---------------------------------------------------------------------------
// promptBuilder.test.ts — promptBuilder モジュールのテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';

// vscode モジュールをモック（promptBuilder → logger → vscode の依存を解決）
vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
}));

import { cronToPrefix, countChoiceItems } from '../promptBuilder';

// ---------------------------------------------------------------------------
// cronToPrefix
// ---------------------------------------------------------------------------

describe('cronToPrefix', () => {
    it('should return [5m] for */5 * * * *', () => {
        expect(cronToPrefix('*/5 * * * *')).toBe('[5m]');
    });

    it('should return [10m] for */10 * * * *', () => {
        expect(cronToPrefix('*/10 * * * *')).toBe('[10m]');
    });

    it('should return [1h] for 0 * * * *', () => {
        expect(cronToPrefix('0 * * * *')).toBe('[1h]');
    });

    it('should return [2h] for 0 */2 * * *', () => {
        expect(cronToPrefix('0 */2 * * *')).toBe('[2h]');
    });

    it('should return [daily] for 0 0 * * *', () => {
        expect(cronToPrefix('0 0 * * *')).toBe('[daily]');
    });

    it('should return [daily] for specific time 30 9 * * *', () => {
        expect(cronToPrefix('30 9 * * *')).toBe('[daily]');
    });

    it('should return [weekly] for 0 0 * * 1', () => {
        expect(cronToPrefix('0 0 * * 1')).toBe('[weekly]');
    });

    it('should return [monthly] for 0 0 1 * *', () => {
        expect(cronToPrefix('0 0 1 * *')).toBe('[monthly]');
    });

    it('should return [cron] for unrecognized patterns', () => {
        expect(cronToPrefix('5 4 * * 1,3,5')).toBe('[cron]');
    });

    it('should return [cron] for invalid format', () => {
        expect(cronToPrefix('invalid')).toBe('[cron]');
    });

    it('should handle leading/trailing whitespace', () => {
        // trim() removes leading/trailing spaces, split(/\s+/) handles internal spaces
        expect(cronToPrefix('  */5  *  *  *  *  ')).toBe('[5m]');
    });
});

// ---------------------------------------------------------------------------
// countChoiceItems
// ---------------------------------------------------------------------------

describe('countChoiceItems', () => {
    it('should return 0 for undefined input', () => {
        expect(countChoiceItems(undefined)).toBe(0);
    });

    it('should return 0 for empty string', () => {
        expect(countChoiceItems('')).toBe(0);
    });

    it('should count number emojis', () => {
        expect(countChoiceItems('1️⃣ Option A\n2️⃣ Option B\n3️⃣ Option C')).toBe(3);
    });

    it('should cap at 3 number emojis (4+ are ignored)', () => {
        const text = '1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟';
        expect(countChoiceItems(text)).toBe(3);
    });

    it('should return 0 for text without number emojis', () => {
        expect(countChoiceItems('✅ Approve ❌ Reject')).toBe(0);
    });

    it('should count only present emojis', () => {
        expect(countChoiceItems('1️⃣ First\n3️⃣ Third')).toBe(2);
    });
});
