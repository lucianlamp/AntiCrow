// ---------------------------------------------------------------------------
// teamReporter.ts — チームモードのレポート生成・IPC指令ファイル書き出し
// ---------------------------------------------------------------------------
// teamOrchestrator.ts から分割。
// writeReportFile() と writeReportInstructionFile() を独立モジュールとして提供。
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logInfo } from './logger';
import { t } from './i18n';
import type { FileIpc } from './fileIpc';
import type { TeamInstruction } from './subagentTypes';
import type { OrchestrationResult } from './teamOrchestrator';
import { buildInstructionContent } from './instructionBuilder';

// ---------------------------------------------------------------------------
// writeReportInstructionFile
// ---------------------------------------------------------------------------

/**
 * メインエージェントへの報告指示をIPCファイルとして書き出す。
 * サブエージェントへのプロンプトと同じ「ファイル読み取り方式」に統一する。
 *
 * 書き出す JSON は tmp_exec_*.json と同じ構造化フォーマット。
 *
 * @returns 書き出した指示ファイルの絶対パスと進捗ファイルパス
 */
export function writeReportInstructionFile(
    fileIpc: FileIpc,
    teamRequestId: string,
    reportPath: string,
    reportResponsePath: string,
): { instructionPath: string; progressPath: string } {
    const ipcDir = fileIpc.getIpcDir();
    const instructionPath = path.join(ipcDir, `tmp_exec_anti-crow_req_${teamRequestId}_report.json`);
    const progressPath = path.join(ipcDir, `req_${teamRequestId}_report_progress.json`);

    // 共通ヘルパーで instruction.json を構築
    const fileContent = buildInstructionContent({
        prompt: '全サブエージェントの報告を確認し、統合レポートを作成してください。\n\n' +
            '1. report_path (context.report_path) のファイルを view_file ツールで読み込んでください\n' +
            '2. 全サブエージェントの報告を確認してください\n' +
            '3. 統合レポートを作成し、output.response_path に Markdown で書き込んでください（write_to_file）\n' +
            '4. レポートにはすべてのタスクの結果・成否・注意点をまとめてください\n' +
            '5. ユーザー向けにわかりやすい報告書を作成してください',
        context: {
            role: 'main_agent_report',
            report_path: reportPath,
        },
        responsePath: reportResponsePath,
        progressPath,
    });

    fs.writeFileSync(instructionPath, JSON.stringify(fileContent, null, 2), 'utf-8');
    logInfo(`[TeamReporter] Wrote report instruction file: ${instructionPath}`);
    return { instructionPath, progressPath };
}

// ---------------------------------------------------------------------------
// writeReportFile
// ---------------------------------------------------------------------------

/**
 * Phase 5: 全サブエージェントの結果を報告用 IPC ファイルとして書き出す。
 * Discord Bot がこれをメインエージェントにプロンプトとして送信する。
 */
export function writeReportFile(
    fileIpc: FileIpc,
    requestId: string,
    results: OrchestrationResult[],
    instructions: TeamInstruction[],
    _mainResponsePath: string,
): string {
    const ipcDir = fileIpc.getIpcDir();
    const reportPath = path.join(ipcDir, `req_${requestId}_report_all.json`);

    const allReports = results.map((r, i) => ({
        agentIndex: instructions[i]?.agentIndex ?? (i + 1),
        agentName: r.agentName,
        success: r.success,
        result: r.response,
        ...(r.retried ? { retried: true } : {}),
    }));

    // tmp_exec_*.json 互換フォーマット: データのみを構造化して書き出す
    const reportData: Record<string, unknown> = {
        type: 'team_report',
        requestId,
        timestamp: Date.now(),
        summary: {
            totalAgents: instructions.length,
            successCount: results.filter(r => r.success).length,
            failureCount: results.filter(r => !r.success).length,
            allSucceeded: results.every(r => r.success),
        },
        task_summary: instructions.map((inst, i) => `${t('team.subagentLabel')}${i + 1}: ${inst.task.substring(0, 80)}`).join('\n'),
        reports: allReports,
        // response_path は writeReportInstructionFile の output.response_path でのみ指定する（一本化）
    };

    fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf-8');
    logInfo(`[TeamReporter] Wrote report file: ${reportPath}`);
    return reportPath;
}
