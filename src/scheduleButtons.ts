// ---------------------------------------------------------------------------
// scheduleButtons.ts — Discord インタラクティブボタン UI for スケジュール管理
// ---------------------------------------------------------------------------

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { Plan } from './types';
import { DateTime } from 'luxon';

// -----------------------------------------------------------------------
// 次回実行時刻の簡易算出
// -----------------------------------------------------------------------

/**
 * cron 式から次回実行時刻の表示用文字列を返す。
 * node-cron は nextDate() を持たないため、luxon で簡易推定する。
 */
export function getNextRunDisplay(cron: string, timezone: string = 'Asia/Tokyo'): string {
    try {
        const parts = cron.split(/\s+/);
        if (parts.length !== 5) { return '—'; }

        const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
        const now = DateTime.now().setZone(timezone);

        // 簡易推定: 分と時が固定の場合のみ正確に計算
        if (minute !== '*' && hour !== '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
            // 毎日 HH:MM のパターン
            let next = now.set({ hour: parseInt(hour), minute: parseInt(minute), second: 0, millisecond: 0 });
            if (next <= now) { next = next.plus({ days: 1 }); }
            return next.toFormat('MM/dd HH:mm');
        }

        if (minute !== '*' && hour === '*') {
            // 毎時 XX 分のパターン
            let next = now.set({ minute: parseInt(minute), second: 0, millisecond: 0 });
            if (next <= now) { next = next.plus({ hours: 1 }); }
            return next.toFormat('HH:mm');
        }

        // */N 分パターン
        const everyMatch = minute.match(/^\*\/(\d+)$/);
        if (everyMatch && hour === '*') {
            const interval = parseInt(everyMatch[1]);
            const currentMin = now.minute;
            const nextMin = Math.ceil((currentMin + 1) / interval) * interval;
            let next = now.set({ minute: nextMin % 60, second: 0, millisecond: 0 });
            if (nextMin >= 60) { next = next.plus({ hours: 1 }).set({ minute: nextMin % 60 }); }
            return next.toFormat('HH:mm');
        }

        return '次回実行は cron 式に従います';
    } catch {
        return '—';
    }
}

// -----------------------------------------------------------------------
// cron 式の人間可読表示
// -----------------------------------------------------------------------

export function cronToHuman(cron: string): string {
    const parts = cron.split(/\s+/);
    if (parts.length !== 5) { return cron; }

    const [minute, hour, dayOfMonth, , dayOfWeek] = parts;

    // */N 分
    const everyMatch = minute.match(/^\*\/(\d+)$/);
    if (everyMatch && hour === '*') {
        return `${everyMatch[1]}分毎`;
    }

    // 毎分
    if (minute === '*' && hour === '*') { return '毎分'; }

    // 毎時
    if (minute !== '*' && hour === '*') {
        return `毎時 ${minute}分`;
    }

    // 毎日
    if (minute !== '*' && hour !== '*' && dayOfMonth === '*' && dayOfWeek === '*') {
        return `毎日 ${hour}:${minute.padStart(2, '0')}`;
    }

    // 週次
    if (dayOfWeek !== '*') {
        const days = ['日', '月', '火', '水', '木', '金', '土'];
        const dayName = days[parseInt(dayOfWeek)] || dayOfWeek;
        return `毎週${dayName} ${hour}:${minute.padStart(2, '0')}`;
    }

    // 月次
    if (dayOfMonth !== '*') {
        return `毎月${dayOfMonth}日 ${hour}:${minute.padStart(2, '0')}`;
    }

    return cron;
}

// -----------------------------------------------------------------------
// 状態バッジ
// -----------------------------------------------------------------------

function statusBadge(status: string, wsName?: string, runningWsNames?: Set<string>): string {
    if (status === 'active') {
        if (runningWsNames && wsName && !runningWsNames.has(wsName)) {
            return '🟡'; // 接続待機中
        }
        return '🟢'; // 稼働中
    }
    if (status === 'paused') return '🔴';
    if (status === 'pending_confirmation') return '⏳';
    if (status === 'completed') return '✅';
    return '❓';
}

// -----------------------------------------------------------------------
// スケジュール一覧 Embed + ボタン
// -----------------------------------------------------------------------

export function buildScheduleListEmbed(
    plans: Plan[],
    timezone: string = 'Asia/Tokyo',
    runningWsNames?: Set<string>,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const scheduledPlans = plans.filter(p => p.cron);

    const embed = new EmbedBuilder()
        .setTitle('📅 スケジュール管理')
        .setColor(0x5865F2)
        .setTimestamp();

    if (scheduledPlans.length === 0) {
        embed.setDescription('登録されたスケジュールはありません。');
        return { embeds: [embed], components: [] };
    }

    // ワークスペース別にグループ化
    const grouped = new Map<string, Plan[]>();
    for (const plan of scheduledPlans) {
        const wsKey = plan.workspace_name || '未割り当て';
        if (!grouped.has(wsKey)) { grouped.set(wsKey, []); }
        grouped.get(wsKey)!.push(plan);
    }

    const wsCount = grouped.size;
    embed.setDescription(`${scheduledPlans.length}件のスケジュール（${wsCount} ワークスペース）`);

    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    let fieldCount = 0;

    for (const [wsName, wsPlans] of grouped) {
        // ワークスペースセクションヘッダー
        if (fieldCount < 25) {
            embed.addFields({
                name: `📁 ${wsName}`,
                value: `${wsPlans.length}件のスケジュール`,
            });
            fieldCount++;
        }

        for (const plan of wsPlans.slice(0, 10)) {
            if (fieldCount >= 25) { break; } // Discord Embed 上限

            const badge = statusBadge(plan.status, plan.workspace_name, runningWsNames);
            const humanCron = cronToHuman(plan.cron!);
            const nextRun = plan.status === 'active'
                ? getNextRunDisplay(plan.cron!, timezone)
                : '(停止中)';
            const summary = plan.human_summary || plan.prompt.substring(0, 60);
            const execCount = plan.execution_count || 0;
            const lastExec = plan.last_executed_at
                ? DateTime.fromISO(plan.last_executed_at).setZone(timezone).toFormat('MM/dd HH:mm')
                : 'なし';

            embed.addFields({
                name: `${badge} ${summary}`,
                value: [
                    `📁 ${wsName}`,
                    `⏰ \`${plan.cron}\` (${humanCron})`,
                    `▶️ 次回: ${nextRun} | 実行回数: ${execCount} | 最終: ${lastExec}`,
                    `🆔 \`${plan.plan_id.substring(0, 8)}...\``,
                ].join('\n'),
            });
            fieldCount++;

            const toggleLabel = plan.status === 'active' ? '⏸️ 一時停止' : '▶️ 再開';
            const toggleStyle = plan.status === 'active' ? ButtonStyle.Secondary : ButtonStyle.Success;

            if (components.length < 4) { // ActionRow 上限 5 - リフレッシュ1
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`sched_toggle_${plan.plan_id}`)
                        .setLabel(toggleLabel)
                        .setStyle(toggleStyle),
                    new ButtonBuilder()
                        .setCustomId(`sched_delete_${plan.plan_id}`)
                        .setLabel('🗑️ 削除')
                        .setStyle(ButtonStyle.Danger),
                );
                components.push(row);
            }
        }
    }

    // リフレッシュボタン
    const refreshRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('sched_list')
            .setLabel('🔄 更新')
            .setStyle(ButtonStyle.Primary),
    );
    components.push(refreshRow);

    return { embeds: [embed], components };
}

// -----------------------------------------------------------------------
// 削除確認 Embed
// -----------------------------------------------------------------------

export function buildDeleteConfirmEmbed(
    plan: Plan,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const embed = new EmbedBuilder()
        .setTitle('⚠️ 削除の確認')
        .setDescription([
            `**${plan.human_summary || plan.prompt.substring(0, 60)}**`,
            '',
            `cron: \`${plan.cron}\``,
            `ID: \`${plan.plan_id}\``,
            '',
            'この操作は取り消せません。本当に削除しますか？',
        ].join('\n'))
        .setColor(0xED4245);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`sched_confirm_delete_${plan.plan_id}`)
            .setLabel('✅ 削除する')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('sched_cancel_delete')
            .setLabel('❌ キャンセル')
            .setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row] };
}
