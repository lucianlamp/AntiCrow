// ---------------------------------------------------------------------------
// accessControl.test.ts — accessControl モジュールのユニットテスト
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { isDeveloper } from '../accessControl';

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('accessControl', () => {
    // -------------------------------------------------------------------
    // isDeveloper
    // -------------------------------------------------------------------

    describe('isDeveloper', () => {
        it('should return true for registered developer ID', () => {
            expect(isDeveloper('386216074095624202')).toBe(true);
        });

        it('should return false for non-developer ID', () => {
            expect(isDeveloper('123456789012345678')).toBe(false);
        });

        it('should return false for empty string', () => {
            expect(isDeveloper('')).toBe(false);
        });

        it('should return false for partial developer ID', () => {
            expect(isDeveloper('386216074095')).toBe(false);
        });

        it('should return false for developer ID with extra characters', () => {
            expect(isDeveloper('386216074095624202x')).toBe(false);
        });

        it('should return false for undefined-like strings', () => {
            expect(isDeveloper('undefined')).toBe(false);
            expect(isDeveloper('null')).toBe(false);
        });
    });
});
