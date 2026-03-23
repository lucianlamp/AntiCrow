// ---------------------------------------------------------------------------
// autoModeContinuation.test.ts — shouldContinue / wsKey フォールバックのテスト
// ---------------------------------------------------------------------------
// テスト対象:
//   - shouldContinue: maxSteps / maxDuration / 完了フレーズ / 類似検知
//   - resolveState: wsKey 省略時のフォールバック
//   - getActiveAutoModeWsKey: アクティブWSキーの取得
//   - isAutoModeActive: wsKey 指定/省略の動作
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TextChannel } from 'discord.js';

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------

const { mockBuildSuggestionRow, mockStoreSuggestions, mockGetAllSuggestions } = vi.hoisted(() => ({
    mockBuildSuggestionRow: vi.fn(),
    mockStoreSuggestions: vi.fn(),
    mockGetAllSuggestions: vi.fn(() => []),
}));

vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue?: unknown) => defaultValue,
        }),
    },
}));

vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
}));

vi.mock('../embedHelper', () => ({
    EmbedColor: {
        Success: 0x2ecc71,
        Info: 0x3498db,
        Warning: 0xe67e22,
        Danger: 0xe74c3c,
        Progress: 0x3498db,
    },
    buildEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
}));

vi.mock('../messageQueue', () => ({
    cancelPlanGeneration: vi.fn(),
}));

vi.mock('../suggestionButtons', () => ({
    AUTO_PROMPT: 'テスト用オートプロンプト',
    buildSuggestionRow: mockBuildSuggestionRow,
    getAllSuggestions: mockGetAllSuggestions,
    storeSuggestions: mockStoreSuggestions,
}));

vi.mock('../i18n', () => ({
    t: vi.fn((...args: string[]) => args.join(' ')),
}));

vi.mock('../autoModeConfig', () => ({
    AUTO_MODE_DEFAULTS: {
        selectionMode: 'ai-select',
        confirmMode: 'auto',
        maxSteps: 10,
        maxDuration: 3600000,
    },
}));

vi.mock('child_process', () => ({
    exec: vi.fn(),
}));

vi.mock('util', () => ({
    promisify: vi.fn(() => vi.fn().mockResolvedValue({ stdout: '', stderr: '' })),
}));

// ---------------------------------------------------------------------------
// テスト対象のインポート
// ---------------------------------------------------------------------------
import {
    startAutoMode,
    stopAutoMode,
    isAutoModeActive,
    onStepComplete,
    getActiveAutoModeWsKey,
    getAutoModeStateMapSize,
    cleanupAutoModeState,
} from '../autoModeController';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function createMockChannel(overrides: Partial<TextChannel> = {}): TextChannel {
    return {
        id: 'test-channel-id',
        send: vi.fn().mockResolvedValue(undefined),
        name: 'test-channel',
        ...overrides,
    } as unknown as TextChannel;
}

// ---------------------------------------------------------------------------
// shouldContinue のテスト（onStepComplete 経由で間接的にテスト）
// ---------------------------------------------------------------------------

describe('autoModeContinuation — shouldContinue の動作検証', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // 前回テストの状態をクリーンアップ
        cleanupAutoModeState();
    });

    // -----------------------------------------------------------------------
    // ガード1: maxSteps — ステップ数上限
    // -----------------------------------------------------------------------

    describe('ガード1: maxSteps（ステップ数上限）', () => {
        it('maxSteps に到達した場合、onStepComplete は null を返す', async () => {
            const channel = createMockChannel();

            // maxSteps=2 で開始
            await startAutoMode(channel, 'test-ws-maxsteps', 'テスト', { maxSteps: 2 });

            // ステップ1: 続行（maxSteps=2, currentStep=1）
            const result1 = await onStepComplete(channel, [], 'ステップ1の結果なのだ');
            // ステップ1完了後は currentStep=1 < maxSteps=2 なので続行
            // ただし step<2 なので完了検知スキップ、類似検知もスキップ（history<2）
            expect(result1).not.toBeNull();

            // ステップ2: 停止（maxSteps=2, currentStep=2）
            const result2 = await onStepComplete(channel, [], 'ステップ2の結果なのだ');
            expect(result2).toBeNull();

            // 状態がリセットされている
            expect(isAutoModeActive('test-ws-maxsteps')).toBe(false);
        });

        it('maxSteps=1 で即座に停止する', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws-1step', 'テスト', { maxSteps: 1 });

            // ステップ1完了 → maxSteps=1 に到達 → 停止
            const result = await onStepComplete(channel, [], '結果');
            expect(result).toBeNull();
            expect(isAutoModeActive('test-ws-1step')).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // ガード3: 完了フレーズ検出
    // -----------------------------------------------------------------------

    describe('ガード3: 完了フレーズ検出', () => {
        it('「全てのタスクが完了しました」を含むレスポンスで停止する（step>=2 かつ suggestionsなし）', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws-completion', 'テスト', { maxSteps: 10 });

            // ステップ1,2: 通常のレスポンス
            await onStepComplete(channel, [], 'まだ作業中のだ！');
            await onStepComplete(channel, [], 'なんか別のレスポンスなのだ');

            // ステップ3: 完了フレーズを含むレスポンス
            const result = await onStepComplete(
                channel,
                [],
                '素晴らしい結果が出たのだ！\n\n全てのタスクが完了しました\n\n以上で報告終了なのだ！',
            );
            expect(result).toBeNull();
        });

        it('完了フレーズがコードブロック内にある場合は無視される', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws-codeblock', 'テスト', { maxSteps: 10 });

            await onStepComplete(channel, [], 'ステップ1なのだ');
            await onStepComplete(channel, [], 'ステップ2なのだ');

            // コードブロック内の完了フレーズは除去されるため、検出されない
            const result = await onStepComplete(
                channel,
                [],
                '結果のだ:\n```\n全てのタスクが完了しました\n```\nまだ作業は残っているのだ',
            );
            expect(result).not.toBeNull();

            // クリーンアップ
            await stopAutoMode(channel, 'manual', 'test-ws-codeblock');
        });

        it('suggestionsがある場合、完了フレーズがあっても停止しない', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws-sugg-override', 'テスト', { maxSteps: 10 });

            await onStepComplete(channel, [], 'ステップ1');
            await onStepComplete(channel, [], 'ステップ2');

            // 完了フレーズ + suggestions あり → 続行
            const suggestions = [
                { label: '次のタスク', description: '追加作業', prompt: '追加作業を実行' },
            ];
            const result = await onStepComplete(
                channel,
                suggestions,
                '全てのタスクが完了しました\nでも提案もあるのだ',
            );
            expect(result).not.toBeNull();

            await stopAutoMode(channel, 'manual', 'test-ws-sugg-override');
        });

        it('step < 2 の場合は完了フレーズ検出をスキップする（誤検知防止）', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws-early', 'テスト', { maxSteps: 10 });

            // ステップ1: 完了フレーズありだが step=1 < 2 なのでスキップ
            const result = await onStepComplete(
                channel,
                [],
                '全てのタスクが完了しました',
            );
            expect(result).not.toBeNull();

            await stopAutoMode(channel, 'manual', 'test-ws-early');
        });

        it('完了フレーズがレスポンス末尾15行以内にある場合のみ検出される', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws-tail', 'テスト', { maxSteps: 10 });

            await onStepComplete(channel, [], 'ステップ1');
            await onStepComplete(channel, [], 'ステップ2');

            // 完了フレーズが20行以上離れた冒頭にある場合、検出されない
            const manyLines = Array(20).fill('何かの行のだ').join('\n');
            const result = await onStepComplete(
                channel,
                [],
                `全てのタスクが完了しました\n${manyLines}\nまだまだやるのだ`,
            );
            expect(result).not.toBeNull();

            await stopAutoMode(channel, 'manual', 'test-ws-tail');
        });
    });

    // -----------------------------------------------------------------------
    // ガード4: 類似検知（calculateSimilarity）
    // -----------------------------------------------------------------------

    describe('ガード4: 類似検知', () => {
        it('直前2ステップが非常に類似している場合、停止する', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws-sim', 'テスト', { maxSteps: 10 });

            // ステップ1
            const longText = 'これは長いレスポンスのテストです。同じ内容を繰り返すことで類似度を検証します。\n'.repeat(10);
            await onStepComplete(channel, [], longText);

            // ステップ2: ほぼ同じテキスト（類似度 >= 0.9）
            const result = await onStepComplete(channel, [], longText);
            expect(result).toBeNull();
            expect(isAutoModeActive('test-ws-sim')).toBe(false);
        });

        it('直前2ステップが異なる内容の場合、続行する', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws-diff', 'テスト', { maxSteps: 10 });

            // ステップ1
            await onStepComplete(channel, [], 'プログラミングの基礎を学んでいます。変数と関数が重要です。');

            // ステップ2: 全く異なるテキスト
            const result = await onStepComplete(channel, [], '天気予報によると明日は晴れです。気温は20度の予定です。');
            expect(result).not.toBeNull();

            await stopAutoMode(channel, 'manual', 'test-ws-diff');
        });

        it('history が1ステップのみの場合は類似検知をスキップ', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws-single', 'テスト', { maxSteps: 10 });

            // ステップ1: history が1件しかないので類似検知はスキップされる
            const result = await onStepComplete(channel, [], '何かのレスポンス');
            expect(result).not.toBeNull();

            await stopAutoMode(channel, 'manual', 'test-ws-single');
        });
    });
});

// ---------------------------------------------------------------------------
// wsKey フォールバック / resolveState のテスト
// ---------------------------------------------------------------------------

describe('autoModeContinuation — wsKey フォールバック', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        cleanupAutoModeState();
    });

    // -----------------------------------------------------------------------
    // resolveState: wsKey 指定/省略の動作
    // -----------------------------------------------------------------------

    describe('isAutoModeActive の wsKey 指定/省略', () => {
        it('wsKey 指定で正しい WS のみチェックされる', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'ws-a', 'タスクA');

            expect(isAutoModeActive('ws-a')).toBe(true);
            expect(isAutoModeActive('ws-b')).toBe(false);

            await stopAutoMode(channel, 'manual', 'ws-a');
        });

        it('wsKey 省略でいずれかの WS がアクティブなら true', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'ws-c', 'タスクC');

            expect(isAutoModeActive()).toBe(true);
            expect(isAutoModeActive('ws-c')).toBe(true);
            expect(isAutoModeActive('ws-d')).toBe(false);

            await stopAutoMode(channel, 'manual', 'ws-c');
        });

        it('全 WS が停止していれば false', async () => {
            expect(isAutoModeActive()).toBe(false);
            expect(isAutoModeActive('anything')).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // getActiveAutoModeWsKey: アクティブWSキーの取得
    // -----------------------------------------------------------------------

    describe('getActiveAutoModeWsKey', () => {
        it('アクティブなWSキーを返す', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'active-ws-key', 'テスト');

            const wsKey = getActiveAutoModeWsKey();
            expect(wsKey).toBe('active-ws-key');

            await stopAutoMode(channel, 'manual', 'active-ws-key');
        });

        it('アクティブなWSがない場合は null を返す', () => {
            const wsKey = getActiveAutoModeWsKey();
            expect(wsKey).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // wsKey 不一致時のフォールバック（executor.ts の autoModeContinueLoop で使用）
    // -----------------------------------------------------------------------

    describe('wsKey 不一致のフォールバックロジック', () => {
        it('plan.workspace_name と stateMap の wsKey が不一致の場合、getActiveAutoModeWsKey で修正できる', async () => {
            const channel = createMockChannel();

            // stateMap に 'actual-ws-key' で登録
            await startAutoMode(channel, 'actual-ws-key', 'テスト');

            // plan.workspace_name = 'wrong-ws-key' ではヒットしない
            expect(isAutoModeActive('wrong-ws-key')).toBe(false);

            // しかし、引数なしならアクティブと判定される
            expect(isAutoModeActive()).toBe(true);

            // getActiveAutoModeWsKey で正しいキーを取得
            const actualKey = getActiveAutoModeWsKey();
            expect(actualKey).toBe('actual-ws-key');

            // 取得したキーで正しく操作できる
            expect(isAutoModeActive(actualKey!)).toBe(true);

            await stopAutoMode(channel, 'manual', 'actual-ws-key');
        });
    });

    // -----------------------------------------------------------------------
    // 複数 WS の同時管理
    // -----------------------------------------------------------------------

    describe('複数 WS の同時管理', () => {
        it('複数WSで同時にオートモードを実行できる', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'ws-1', 'タスク1');
            await startAutoMode(channel, 'ws-2', 'タスク2');

            expect(getAutoModeStateMapSize()).toBe(2);
            expect(isAutoModeActive('ws-1')).toBe(true);
            expect(isAutoModeActive('ws-2')).toBe(true);

            // ws-1 だけ停止
            await stopAutoMode(channel, 'manual', 'ws-1');

            expect(isAutoModeActive('ws-1')).toBe(false);
            expect(isAutoModeActive('ws-2')).toBe(true);

            // 全体でまだアクティブ
            expect(isAutoModeActive()).toBe(true);

            await stopAutoMode(channel, 'manual', 'ws-2');

            // 全WSが停止
            expect(isAutoModeActive()).toBe(false);
        });

        it('同じWSで startAutoMode を再度呼ぶと前のセッションがリセットされる', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'ws-reset', 'タスク1');
            expect(getAutoModeStateMapSize()).toBe(1);

            // 同じWSで再度開始 → 前のセッションがサイレントリセット
            await startAutoMode(channel, 'ws-reset', 'タスク2（新）');
            expect(getAutoModeStateMapSize()).toBe(1);
            expect(isAutoModeActive('ws-reset')).toBe(true);

            await stopAutoMode(channel, 'manual', 'ws-reset');
        });
    });

    // -----------------------------------------------------------------------
    // cleanupAutoModeState のテスト
    // -----------------------------------------------------------------------

    describe('cleanupAutoModeState', () => {
        it('wsKey 指定で特定WSだけクリーンアップされる', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'ws-x', 'タスクX');
            await startAutoMode(channel, 'ws-y', 'タスクY');

            cleanupAutoModeState('ws-x');

            expect(isAutoModeActive('ws-x')).toBe(false);
            expect(isAutoModeActive('ws-y')).toBe(true);

            cleanupAutoModeState('ws-y');
        });

        it('wsKey 省略で全WSがクリーンアップされる', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'ws-p', 'タスクP');
            await startAutoMode(channel, 'ws-q', 'タスクQ');

            cleanupAutoModeState();

            expect(isAutoModeActive()).toBe(false);
            expect(getAutoModeStateMapSize()).toBe(0);
        });
    });
});

// ---------------------------------------------------------------------------
// onStepComplete の wsKey フォールバックテスト
// ---------------------------------------------------------------------------

describe('autoModeContinuation — onStepComplete の wsKey フォールバック', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        cleanupAutoModeState();
    });

    it('wsKey 省略で onStepComplete を呼んでも最初のアクティブWSに対して動作する', async () => {
        const channel = createMockChannel();

        await startAutoMode(channel, 'ws-fallback', 'テスト', { maxSteps: 5 });

        // wsKey を省略して onStepComplete を呼ぶ（resolveState のフォールバック）
        const result = await onStepComplete(channel, [], '結果のだ');
        expect(result).not.toBeNull();

        // 状態はまだアクティブ
        expect(isAutoModeActive('ws-fallback')).toBe(true);

        await stopAutoMode(channel, 'manual', 'ws-fallback');
    });

    it('wsKey 指定で正しいWSの onStepComplete が実行される', async () => {
        const channel = createMockChannel();

        await startAutoMode(channel, 'ws-specific', 'テスト', { maxSteps: 2 });

        // ステップ1
        const result1 = await onStepComplete(channel, [], '結果1', 'ws-specific');
        expect(result1).not.toBeNull();

        // ステップ2: maxSteps に到達
        const result2 = await onStepComplete(channel, [], '結果2', 'ws-specific');
        expect(result2).toBeNull();
    });
});
