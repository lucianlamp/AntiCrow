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
    isUserAllowed,
    DEFAULT_RESPONSE_TIMEOUT_MS,
    DEFAULT_TIMEZONE,
    DEFAULT_ARCHIVE_DAYS,
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

        it('should return default timeout (0 = unlimited) when not configured', () => {
            mockGet.mockReturnValue(undefined);
            expect(getResponseTimeout()).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
            expect(getResponseTimeout()).toBe(0);
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

    // ----- isUserAllowed -----\r\n\r\n    describe('isUserAllowed', () => {\r\n        it('should deny all users when allowedUserIds is empty', () => {\r\n            mockGet.mockImplementation((key: string) => {\r\n                if (key === 'allowedUserIds') { return []; }\r\n                return undefined;\r\n            });\r\n            const result = isUserAllowed('123456');\r\n            expect(result.allowed).toBe(false);\r\n            expect(result.reason).toContain('設定されていません');\r\n        });\r\n\r\n        it('should deny all users when allowedUserIds is not configured', () => {\r\n            mockGet.mockReturnValue(undefined);\r\n            const result = isUserAllowed('123456');\r\n            expect(result.allowed).toBe(false);\r\n        });\r\n\r\n        it('should allow user in the allowed list', () => {\r\n            mockGet.mockImplementation((key: string) => {\r\n                if (key === 'allowedUserIds') { return ['111', '222', '333']; }\r\n                return undefined;\r\n            });\r\n            const result = isUserAllowed('222');\r\n            expect(result.allowed).toBe(true);\r\n            expect(result.reason).toBeUndefined();\r\n        });\r\n\r\n        it('should deny user not in the allowed list', () => {\r\n            mockGet.mockImplementation((key: string) => {\r\n                if (key === 'allowedUserIds') { return ['111', '222']; }\r\n                return undefined;\r\n            });\r\n            const result = isUserAllowed('999');\r\n            expect(result.allowed).toBe(false);\r\n            expect(result.reason).toContain('許可されていません');\r\n        });\r\n\r\n        it('should allow the only configured user', () => {\r\n            mockGet.mockImplementation((key: string) => {\r\n                if (key === 'allowedUserIds') { return ['SOLE_USER']; }\r\n                return undefined;\r\n            });\r\n            expect(isUserAllowed('SOLE_USER').allowed).toBe(true);\r\n            expect(isUserAllowed('OTHER').allowed).toBe(false);\r\n        });\r\n\r\n        it('should be case-sensitive for user IDs', () => {\r\n            mockGet.mockImplementation((key: string) => {\r\n                if (key === 'allowedUserIds') { return ['Abc123']; }\r\n                return undefined;\r\n            });\r\n            expect(isUserAllowed('Abc123').allowed).toBe(true);\r\n            expect(isUserAllowed('abc123').allowed).toBe(false);\r\n            expect(isUserAllowed('ABC123').allowed).toBe(false);\r\n        });\r\n\r\n        it('should handle empty string user ID', () => {\r\n            mockGet.mockImplementation((key: string) => {\r\n                if (key === 'allowedUserIds') { return ['123']; }\r\n                return undefined;\r\n            });\r\n            expect(isUserAllowed('').allowed).toBe(false);\r\n        });\r\n    });\r\n\r\n    // ----- getMaxMessageLength -----

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

});
