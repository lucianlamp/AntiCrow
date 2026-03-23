// ---------------------------------------------------------------------------
// teamResponsePattern.test.ts — collectResponses の responsePattern スコープ検証
// ---------------------------------------------------------------------------
// テスト対象:
//   - teamRequestId でスコープされた responsePattern が正しくマッチするか
//   - 異なる teamRequestId / 異なるエージェント名ではマッチしないか
//   - 特殊文字エスケープが正しく行われているか
//
// 背景:
//   IPCディレクトリが全WSで共有されるため、responsePattern を teamRequestId で
//   スコープしないとクロスWS誤配信が発生する。このテストはその防止策の検証。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// ヘルパー: teamOrchestrator.ts L1237-1249 の responsePattern 生成ロジックを再現
// ---------------------------------------------------------------------------

/**
 * collectResponses 内で使用される responsePattern を生成する。
 * teamOrchestrator.ts L1237-1249 のロジックと完全に一致させること。
 */
function buildResponsePattern(
    agentName: string,
    teamRequestId: string,
    agentIndex: number,
): RegExp {
    const agentNameEscaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const teamReqEscaped = teamRequestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    return new RegExp(
        // ★優先: teamRequestId でスコープしたパターン（クロスWS防止）
        `^subagent_${agentNameEscaped}_response_${teamReqEscaped}_\\d+\\.json$` +
        // 後方互換: teamRequestId なしのパターン（旧バージョンのサブエージェント用）
        `|^subagent_${agentNameEscaped}_response_\\d+\\.json$` +
        // req_ パターン: teamRequestId でスコープ
        `|^req_${teamReqEscaped}_agent${agentIndex}_\\d+_[a-f0-9]+_response\\.md$` +
        // req_ パターン: 後方互換（agentName ベース）
        `|^req_${agentNameEscaped}_\\d+_[a-f0-9]+_response\\.md$` +
        `|^req_anti-crow-subagent-${agentIndex}_\\d+_[a-f0-9]+_response\\.md$`
    );
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('collectResponses responsePattern スコープ検証', () => {
    const AGENT_NAME = 'anti-crow-subagent-1';
    const TEAM_REQUEST_ID = 'req_anti-crow_1773484968702_b0f0588add6d';
    const AGENT_INDEX = 1;

    const pattern = buildResponsePattern(AGENT_NAME, TEAM_REQUEST_ID, AGENT_INDEX);

    // -----------------------------------------------------------------------
    // 1. 正規マッチ（5パターン）
    // -----------------------------------------------------------------------

    describe('正規マッチ', () => {
        it('teamRequestId スコープ付き subagent レスポンスファイルにマッチ', () => {
            const filename = `subagent_${AGENT_NAME}_response_${TEAM_REQUEST_ID}_1773485000000.json`;
            expect(pattern.test(filename)).toBe(true);
        });

        it('後方互換: teamRequestId なしの subagent レスポンスファイルにマッチ', () => {
            const filename = `subagent_${AGENT_NAME}_response_1773485000000.json`;
            expect(pattern.test(filename)).toBe(true);
        });

        it('req_ パターン: teamRequestId + agentIndex スコープにマッチ', () => {
            const filename = `req_${TEAM_REQUEST_ID}_agent${AGENT_INDEX}_1773485000000_abcdef01_response.md`;
            expect(pattern.test(filename)).toBe(true);
        });

        it('req_ パターン: agentName ベース（後方互換）にマッチ', () => {
            const filename = `req_${AGENT_NAME}_1773485000000_abcdef01_response.md`;
            expect(pattern.test(filename)).toBe(true);
        });

        it('req_ パターン: anti-crow-subagent-N 固定名にマッチ', () => {
            const filename = `req_anti-crow-subagent-${AGENT_INDEX}_1773485000000_abcdef01_response.md`;
            expect(pattern.test(filename)).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // 2. 非マッチ（3パターン）
    // -----------------------------------------------------------------------

    describe('非マッチ', () => {
        it('異なる teamRequestId のレスポンスにはマッチしない', () => {
            const differentRequestId = 'req_other-workspace_9999999999999_ffffffffffffffff';
            const filename = `subagent_${AGENT_NAME}_response_${differentRequestId}_1773485000000.json`;
            // subagent_{name}_response_\d+\.json の後方互換パターンにマッチしてしまう可能性があるが、
            // teamRequestId を含むファイル名は \d+ パターンにマッチしないため安全
            expect(pattern.test(filename)).toBe(false);
        });

        it('異なるエージェント名のレスポンスにはマッチしない', () => {
            const differentAgent = 'anti-crow-subagent-2';
            const filename = `subagent_${differentAgent}_response_${TEAM_REQUEST_ID}_1773485000000.json`;
            expect(pattern.test(filename)).toBe(false);
        });

        it('全く関係ないファイル名にはマッチしない', () => {
            const filename = 'tmp_exec_anti-crow_req_12345.json';
            expect(pattern.test(filename)).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // 3. エッジケース
    // -----------------------------------------------------------------------

    describe('エッジケース', () => {
        it('正規表現の特殊文字を含むエージェント名が正しくエスケープされる', () => {
            const specialAgentName = 'agent.special+test(1)';
            const specialPattern = buildResponsePattern(
                specialAgentName,
                TEAM_REQUEST_ID,
                1,
            );

            // エスケープされた特殊文字を含む正しいファイル名はマッチする
            const validFilename = `subagent_${specialAgentName}_response_${TEAM_REQUEST_ID}_1773485000000.json`;
            expect(specialPattern.test(validFilename)).toBe(true);

            // 特殊文字がワイルドカードとして解釈されないことを確認
            // "." が任意の1文字にマッチしないことを検証
            const exploitFilename = 'subagent_agentXspecial+test(1)_response_1773485000000.json';
            expect(specialPattern.test(exploitFilename)).toBe(false);
        });

        it('正規表現の特殊文字を含む teamRequestId が正しくエスケープされる', () => {
            const specialRequestId = 'req_test.ws+name_123';
            const specialPattern = buildResponsePattern(
                AGENT_NAME,
                specialRequestId,
                1,
            );

            // 正しいファイル名はマッチする
            const validFilename = `subagent_${AGENT_NAME}_response_${specialRequestId}_1773485000000.json`;
            expect(specialPattern.test(validFilename)).toBe(true);

            // "." が任意の1文字にマッチしないことを検証
            const exploitFilename = `subagent_${AGENT_NAME}_response_req_testXws+name_123_1773485000000.json`;
            expect(specialPattern.test(exploitFilename)).toBe(false);
        });

        it('agentIndex が異なる場合の req_ パターンで非マッチ', () => {
            const wrongIndexFilename = `req_${TEAM_REQUEST_ID}_agent2_1773485000000_abcdef01_response.md`;
            expect(pattern.test(wrongIndexFilename)).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // 4. パターン構造の検証
    // -----------------------------------------------------------------------

    describe('パターン構造', () => {
        it('パターンが5つの代替パターン（|区切り）を持つ', () => {
            // source プロパティから | の数を数える（5パターン = 4つの |）
            const pipeCount = (pattern.source.match(/\|/g) || []).length;
            expect(pipeCount).toBe(4);
        });

        it('パターンが行頭（^）と行末（$）のアンカーを持つ', () => {
            // 各代替パターンが ^ で始まり $ で終わることを確認
            const alternatives = pattern.source.split('|');
            for (const alt of alternatives) {
                expect(alt.startsWith('^')).toBe(true);
                expect(alt.endsWith('$')).toBe(true);
            }
        });
    });
});
