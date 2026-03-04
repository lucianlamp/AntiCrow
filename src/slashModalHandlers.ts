// ---------------------------------------------------------------------------
// slashModalHandlers.ts — モーダル送信ハンドラ群
// ---------------------------------------------------------------------------

import { ModalSubmitInteraction } from 'discord.js';

import { logDebug, logError } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { naturalTextToCron, cronToHuman } from './scheduleButtons';
import { BridgeContext } from './bridgeContext';
import { getTimezone } from './configHelper';
import { handleWorkspaceModalSubmit } from './workspaceHandler';
import { handleModalSubmit as handleTemplateModalSubmit } from './templateHandler';
import { updateAnticrowMd } from './anticrowCustomizer';

/**
 * モーダル送信を処理する。
 */
export async function handleModalSubmit(
    ctx: BridgeContext,
    interaction: ModalSubmitInteraction,
): Promise<void> {
    // ワークスペース作成モーダルは workspaceHandler に委譲
    if (interaction.customId === 'ws_modal_create') {
        await handleWorkspaceModalSubmit(ctx, interaction);
        return;
    }

    // SOUL.md 編集モーダル
    if (interaction.customId === 'soul_edit_modal') {
        const content = interaction.fields.getTextInputValue('soul_content');
        const result = updateAnticrowMd(content, 'overwrite');
        if (result.success) {
            const bytes = Buffer.byteLength(content, 'utf-8');
            await interaction.reply({
                embeds: [buildEmbed(`✅ SOUL.md を更新しました（${bytes} bytes）`, EmbedColor.Success)],
            });
        } else {
            await interaction.reply({
                embeds: [buildEmbed(`❌ SOUL.md の更新に失敗しました: ${result.error || '不明なエラー'}`, EmbedColor.Error)],
            });
        }
        return;
    }

    // Pro ライセンスキー入力モーダル
    if (interaction.customId === 'pro_key_modal') {
        const key = interaction.fields.getTextInputValue('license_key').trim();
        if (!key) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ ライセンスキーが空です。', EmbedColor.Warning)],
            });
            return;
        }

        if (!ctx.setLicenseKeyFn) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ ライセンスシステムが初期化されていません。VS Code 側で `AntiCrow: Set License Key` コマンドを実行してください。', EmbedColor.Warning)],
            });
            return;
        }

        try {
            const result = await ctx.setLicenseKeyFn(key);
            if (result.valid && result.planType !== 'free') {
                await interaction.reply({
                    embeds: [buildEmbed(`✅ ライセンス認証成功！\n\nプラン: **${result.planType}**\nキー: \`${key.substring(0, 8)}...\``, EmbedColor.Success)],
                });
            } else {
                await interaction.reply({
                    embeds: [buildEmbed(`⚠️ ライセンスキーが無効です。正しいキーを入力してください。\n\nキー: \`${key.substring(0, 8)}...\``, EmbedColor.Warning)],
                });
            }
            logDebug(`pro_key_modal: license key set, valid=${result.valid}, plan=${result.planType}`);
        } catch (e) {
            logError('pro_key_modal: failed to set license key', e);
            const errDetail = e instanceof Error ? e.message : String(e);
            await interaction.reply({
                embeds: [buildEmbed(`❌ ライセンスキーの設定中にエラーが発生しました。\n\n**エラー:** ${errDetail}\n\nキーが保存済みの場合は、次回の自動検証で反映されます。手動で再試行する場合は \`/pro\` → 🔑キー入力 を再度お試しください。`, EmbedColor.Error)],
            });
        }
        return;
    }

    // テンプレート系モーダルに委譲
    if (interaction.customId.startsWith('tpl_')) {
        await handleTemplateModalSubmit(ctx, interaction);
        return;
    }

    // ----- キュー編集モーダル -----
    if (interaction.customId.startsWith('queue_edit_modal_')) {
        const msgId = interaction.customId.replace('queue_edit_modal_', '');
        const newContent = interaction.fields.getTextInputValue('queue_edit_content').trim();
        if (!newContent) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ メッセージ内容が空です。', EmbedColor.Warning)],
            });
            return;
        }

        const { editWaitingMessage } = await import('./messageHandler');
        const edited = editWaitingMessage(msgId, newContent);
        if (edited) {
            await interaction.reply({
                embeds: [buildEmbed(`✅ 待機メッセージを編集しました`, EmbedColor.Success)],
            });
        } else {
            await interaction.reply({
                embeds: [buildEmbed(`⚠️ 該当のメッセージは既に処理済みか削除されています`, EmbedColor.Warning)],
            });
        }
        return;
    }

    // ----- スケジュール新規作成モーダル -----
    if (interaction.customId === 'sched_modal_new') {
        const prompt = interaction.fields.getTextInputValue('sched_prompt').trim();
        const cronText = interaction.fields.getTextInputValue('sched_cron_text').trim();
        const summary = interaction.fields.getTextInputValue('sched_summary')?.trim() || undefined;

        if (!prompt) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ プロンプトが空です。', EmbedColor.Warning)],
            });
            return;
        }

        // 自然文 → cron 変換
        const cron = naturalTextToCron(cronText);
        if (!cron) {
            await interaction.reply({
                embeds: [buildEmbed(
                    `⚠️ スケジュール「${cronText}」を cron 式に変換できませんでした。\n\n` +
                    '**対応形式の例:**\n' +
                    '- `毎日9時` / `毎日 09:30`\n' +
                    '- `毎週月曜の10時`\n' +
                    '- `平日の18時`\n' +
                    '- `3時間おき` / `30分おき`\n' +
                    '- `毎月1日の9時`\n' +
                    '- cron 式: `0 9 * * *`',
                    EmbedColor.Warning,
                )],
            });
            return;
        }

        if (!ctx.planStore || !ctx.scheduler) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ Bridge が初期化されていません。', EmbedColor.Warning)],
            });
            return;
        }

        // Plan 生成
        const { v4: uuidv4 } = await import('uuid');
        const plan: import('./types').Plan = {
            plan_id: uuidv4(),
            timezone: getTimezone(),
            cron,
            prompt,
            requires_confirmation: false,
            source_channel_id: interaction.channelId || '',
            notify_channel_id: interaction.channelId || '',
            discord_templates: {},
            human_summary: summary || prompt.substring(0, 60),
            status: 'active' as const,
            created_at: new Date().toISOString(),
            execution_count: 0,
        };

        ctx.planStore.add(plan);
        ctx.scheduler.register(plan);

        const humanCron = cronToHuman(cron);
        logDebug(`sched_modal_new: created plan ${plan.plan_id}, cron=${cron} (${humanCron})`);

        await interaction.reply({
            embeds: [buildEmbed(
                `✅ スケジュールを登録しました！\n\n` +
                `**${plan.human_summary}**\n` +
                `⏰ \`${cron}\` (${humanCron})\n` +
                `🆔 \`${plan.plan_id.substring(0, 8)}...\`\n\n` +
                `入力: 「${cronText}」`,
                EmbedColor.Success,
            )],
        });
        return;
    }

    // ----- スケジュール編集モーダル -----
    if (interaction.customId.startsWith('sched_modal_edit_')) {
        const planId = interaction.customId.replace('sched_modal_edit_', '');
        const prompt = interaction.fields.getTextInputValue('sched_edit_prompt').trim();
        const cronText = interaction.fields.getTextInputValue('sched_edit_cron_text').trim();
        const summary = interaction.fields.getTextInputValue('sched_edit_summary')?.trim() || undefined;

        if (!prompt) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ プロンプトが空です。', EmbedColor.Warning)],
            });
            return;
        }

        const cron = naturalTextToCron(cronText);
        if (!cron) {
            await interaction.reply({
                embeds: [buildEmbed(
                    `⚠️ スケジュール「${cronText}」を cron 式に変換できませんでした。\n\n` +
                    '**対応形式の例:**\n' +
                    '- `毎日9時` / `毎日 09:30`\n' +
                    '- `毎週月曜の10時`\n' +
                    '- `平日の18時`\n' +
                    '- `3時間おき` / `30分おき`\n' +
                    '- `毎月1日の9時`\n' +
                    '- cron 式: `0 9 * * *`',
                    EmbedColor.Warning,
                )],
            });
            return;
        }

        if (!ctx.planStore || !ctx.scheduler) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ Bridge が初期化されていません。', EmbedColor.Warning)],
            });
            return;
        }

        const oldPlan = ctx.planStore.get(planId);
        if (!oldPlan) {
            await interaction.reply({
                embeds: [buildEmbed(`⚠️ 計画 \`${planId}\` が見つかりません。`, EmbedColor.Warning)],
            });
            return;
        }

        const oldCron = oldPlan.cron;
        ctx.planStore.update(planId, {
            prompt,
            cron,
            human_summary: summary || prompt.substring(0, 60),
        });

        // Scheduler 再登録
        ctx.scheduler.unregister(planId);
        const updatedPlan = ctx.planStore.get(planId);
        if (updatedPlan && updatedPlan.status === 'active') {
            ctx.scheduler.register(updatedPlan);
        }

        const humanCron = cronToHuman(cron);
        const oldHumanCron = oldCron ? cronToHuman(oldCron) : '—';
        logDebug(`sched_modal_edit: updated plan ${planId}, cron=${oldCron} → ${cron}`);

        await interaction.reply({
            embeds: [buildEmbed(
                `✅ スケジュールを更新しました！\n\n` +
                `**${summary || prompt.substring(0, 60)}**\n` +
                `⏰ \`${cron}\` (${humanCron})\n` +
                (oldCron !== cron ? `📝 変更前: \`${oldCron}\` (${oldHumanCron})\n` : '') +
                `🆔 \`${planId.substring(0, 8)}...\``,
                EmbedColor.Success,
            )],
        });
        return;
    }
}
