// ---------------------------------------------------------------------------
// configHelper.test.ts — 設定値管理テスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vscode モジュールをモック
const mockGet = vi.fn();
vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
    workspace: {
        getConfiguration: () => ({
            get: mockGet,
        }),
    },
}));

import {
    getResponseTimeout,
    getTimezone,
    getArchiveDays,
    getAllowedUserIds,
    getMaxMessageLength,
    DEFAULT_RESPONSE_TIMEOUT_MS,
    DEFAULT_TIMEZONE,
    DEFAULT_ARCHIVE_DAYS,
    EXCLUDED_CDP_PORTS,
} from '../configHelper';

describe('configHelper', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    // ----- getResponseTimeout -----

    describe('getResponseTimeout', () => {
        it('should return configured timeout', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'responseTimeoutMs') { return 60000; }
                return undefined;
            });
            expect(getResponseTimeout()).toBe(60000);
        });

        it('should return default timeout (1,800,000ms = 30min) when not configured', () => {
            mockGet.mockReturnValue(undefined);
            expect(getResponseTimeout()).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
            expect(getResponseTimeout()).toBe(1_800_000);
        });

        it('should return default when configured value is 0', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'responseTimeoutMs') { return 0; }
                return undefined;
            });
            // 0 is falsy, so || default kicks in
            expect(getResponseTimeout()).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
        });
    });

    // ----- getTimezone -----

    describe('getTimezone', () => {
        it('should return configured timezone', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'timezone') { return 'America/New_York'; }
                return undefined;
            });
            expect(getTimezone()).toBe('America/New_York');
        });

        it('should auto-detect OS timezone when not configured', () => {
            mockGet.mockReturnValue(undefined);
            const result = getTimezone();
            // OS のタイムゾーンを正しく取得できること
            expect(result).toBeTruthy();
            expect(typeof result).toBe('string');
            // IANA 形式であること（/ を含む）
            expect(result).toMatch(/\//);
        });

        it('should return empty-string-configured as auto-detect', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'timezone') { return ''; }
                return undefined;
            });
            const result = getTimezone();
            expect(result).toBeTruthy();
            // 空文字列の場合は OS 自動取得
            expect(result).not.toBe('');
        });
    });

    // ----- getArchiveDays -----

    describe('getArchiveDays', () => {
        it('should return configured archive days', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'categoryArchiveDays') { return 30; }
                return undefined;
            });
            expect(getArchiveDays()).toBe(30);
        });

        it('should return default archive days (7) when not configured', () => {
            mockGet.mockReturnValue(undefined);
            expect(getArchiveDays()).toBe(DEFAULT_ARCHIVE_DAYS);
            expect(getArchiveDays()).toBe(7);
        });

        it('should allow 0 days (uses ?? not ||)', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'categoryArchiveDays') { return 0; }
                return undefined;
            });
            // ?? は null/undefined のみフォールバック、0 は有効値
            expect(getArchiveDays()).toBe(0);
        });
    });

    // ----- getAllowedUserIds -----

    describe('getAllowedUserIds', () => {
        it('should return configured user IDs', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'allowedUserIds') { return ['123', '456']; }
                return undefined;
            });
            expect(getAllowedUserIds()).toEqual(['123', '456']);
        });

        it('should return empty array when not configured', () => {
            mockGet.mockReturnValue(undefined);
            expect(getAllowedUserIds()).toEqual([]);
        });
    });

    // ----- getMaxMessageLength -----

    describe('getMaxMessageLength', () => {
        it('should return configured max length', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'maxMessageLength') { return 10000; }
                return undefined;
            });
            expect(getMaxMessageLength()).toBe(10000);
        });

        it('should return default (6000) when not configured', () => {
            mockGet.mockReturnValue(undefined);
            expect(getMaxMessageLength()).toBe(6000);
        });

        it('should allow 0 as unlimited (uses ?? not ||)', () => {
            mockGet.mockImplementation((key: string) => {
                if (key === 'maxMessageLength') { return 0; }
                return undefined;
            });
            expect(getMaxMessageLength()).toBe(0);
        });
    });

    // ----- EXCLUDED_CDP_PORTS -----

    describe('EXCLUDED_CDP_PORTS', () => {
        it('should exclude port 9222', () => {
            expect(EXCLUDED_CDP_PORTS.has(9222)).toBe(true);
        });

        it('should not exclude common CDP ports', () => {
            expect(EXCLUDED_CDP_PORTS.has(9229)).toBe(false);
            expect(EXCLUDED_CDP_PORTS.has(9515)).toBe(false);
        });
    });
});
