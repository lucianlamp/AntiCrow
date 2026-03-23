// ---------------------------------------------------------------------------
// slashModalHandlers.ts — モーダル送信ハンドラ群
// ---------------------------------------------------------------------------

import { ModalSubmitInteraction } from 'discord.js';

import { logDebug, logError } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { t } from './i18n';
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
                embeds: [buildEmbed(t('modal.soulUpdated', String(bytes)), EmbedColor.Success)],
            });
        } else {
            await interaction.reply({
                embeds: [buildEmbed(t('modal.soulFailed', result.error || t('modal.unknownError')), EmbedColor.Error)],
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
                embeds: [buildEmbed(t('modal.msgEmpty'), EmbedColor.Warning)],
            });
            return;
        }

        const { editWaitingMessage } = await import('./messageHandler');
        const edited = editWaitingMessage(msgId, newContent);
        if (edited) {
            await interaction.reply({
                embeds: [buildEmbed(t('modal.msgEdited'), EmbedColor.Success)],
            });
        } else {
            await interaction.reply({
                embeds: [buildEmbed(t('modal.msgAlreadyProcessed'), EmbedColor.Warning)],
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
                embeds: [buildEmbed(t('modal.promptEmpty'), EmbedColor.Warning)],
            });
            return;
        }

        // 自然文 → cron 変換
        const cron = naturalTextToCron(cronText);
        if (!cron) {
            await interaction.reply({
                embeds: [buildEmbed(
                    t('modal.cronConvertFailed', cronText),
                    EmbedColor.Warning,
                )],
            });
            return;
        }

        if (!ctx.planStore || !ctx.scheduler) {
            await interaction.reply({
                embeds: [buildEmbed(t('modal.bridgeNotInit'), EmbedColor.Warning)],
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
                t('modal.schedCreated', plan.human_summary || '', cron, humanCron, plan.plan_id.substring(0, 8), cronText),
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
                embeds: [buildEmbed(t('modal.promptEmpty'), EmbedColor.Warning)],
            });
            return;
        }

        const cron = naturalTextToCron(cronText);
        if (!cron) {
            await interaction.reply({
                embeds: [buildEmbed(
                    t('modal.cronConvertFailed', cronText),
                    EmbedColor.Warning,
                )],
            });
            return;
        }

        if (!ctx.planStore || !ctx.scheduler) {
            await interaction.reply({
                embeds: [buildEmbed(t('modal.bridgeNotInit'), EmbedColor.Warning)],
            });
            return;
        }

        const oldPlan = ctx.planStore.get(planId);
        if (!oldPlan) {
            await interaction.reply({
                embeds: [buildEmbed(t('modal.planNotFound', planId), EmbedColor.Warning)],
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
                t('modal.schedUpdated', summary || prompt.substring(0, 60), cron, humanCron, oldCron !== cron ? (oldCron || '') : '', oldCron !== cron ? oldHumanCron : '', planId.substring(0, 8)),
                EmbedColor.Success,
            )],
        });
        return;
    }
}
