// ---------------------------------------------------------------------------
// discordUtils.test.ts — Discord ユーティリティテスト
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { snowflakeToTimestamp } from '../discordUtils';

describe('snowflakeToTimestamp', () => {
    it('should convert a known snowflake to correct timestamp', () => {
        // Snowflake "0" should return the Discord epoch (2015-01-01T00:00:00.000Z)
        expect(snowflakeToTimestamp('0')).toBe(1420070400000);
    });

    it('should extract timestamp from a real-ish snowflake', () => {
        // 2024-01-01T00:00:00.000Z = 1704067200000 ms
        // offset from Discord epoch = 1704067200000 - 1420070400000 = 283996800000
        // snowflake = offset << 22 = 283996800000 * 4194304 = BigInt
        const offsetMs = 283996800000n;
        const snowflake = (offsetMs << 22n).toString();
        const ts = snowflakeToTimestamp(snowflake);
        expect(ts).toBe(1704067200000);
    });

    it('should handle large snowflake values', () => {
        // A typical Discord snowflake from ~2023
        const snowflake = '1095000000000000000';
        const ts = snowflakeToTimestamp(snowflake);
        // Should be a reasonable date (after 2020)
        expect(ts).toBeGreaterThan(1577836800000); // 2020-01-01
        expect(ts).toBeLessThan(2000000000000);    // ~2033
    });

    it('should return a number', () => {
        expect(typeof snowflakeToTimestamp('1234567890123456789')).toBe('number');
    });
});
