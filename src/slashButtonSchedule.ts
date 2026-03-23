// ---------------------------------------------------------------------------
// slashButtonSchedule.ts — スケジュール関連ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------

import {
    ButtonInteraction,
    ActionRowBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalBuilder,
} from 'discord.js';

import { logDebug } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { t } from './i18n';
import { buildScheduleListEmbed, buildDeleteConfirmEmbed } from './scheduleButtons';
import { BridgeContext } from './bridgeContext';
import { getTimezone } from './configHelper';
import { getRunningWsNames } from './workspaceHandler';
import { TemplateStore } from './templateStore';
import { debouncedRename } from './slashHelpers';

/**
 * スケジュール関連ボタンを処理する。
 * @returns true: 処理済み, false: 未処理（他のハンドラに委譲）
 */
export async function handleScheduleButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
    customId: string,
): Promise<boolean> {
    const timezone = getTimezone();

    if (customId === 'sched_list') {
        const plans = ctx.planStore!.getAll();
        const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
        await interaction.update({ embeds, components: components as any });
        return true;
    }

    // ➕ 新規作成ボタン → モーダルを表示
    if (customId === 'sched_new') {
        const modal = new ModalBuilder()
            .setCustomId('sched_modal_new')
            .setTitle(t('btnSched.newTitle'));

        const promptInput = new TextInputBuilder()
            .setCustomId('sched_prompt')
            .setLabel(t('btnSched.promptLabel'))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000)
            .setPlaceholder(t('btnSched.promptPlaceholder'));

        const cronInput = new TextInputBuilder()
            .setCustomId('sched_cron_text')
            .setLabel(t('btnSched.cronLabel'))
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
            .setPlaceholder(t('btnSched.cronPlaceholder'));

        const summaryInput = new TextInputBuilder()
            .setCustomId('sched_summary')
            .setLabel(t('btnSched.nameLabel'))
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(60)
            .setPlaceholder(t('btnSched.namePlaceholder'));

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput) as any,
            new ActionRowBuilder<TextInputBuilder>().addComponents(cronInput) as any,
            new ActionRowBuilder<TextInputBuilder>().addComponents(summaryInput) as any,
        );

        await interaction.showModal(modal);
        return true;
    }

    if (customId.startsWith('sched_toggle_')) {
        const planId = customId.replace('sched_toggle_', '');
        const plan = ctx.planStore!.get(planId);
        if (!plan) {
            await interaction.reply({ embeds: [buildEmbed(t('btnSched.planNotFound', planId), EmbedColor.Warning)] });
            return true;
        }

        let renameChannelId: string | undefined;
        let renameNewName: string | undefined;

        if (plan.status === 'active') {
            ctx.planStore!.update(planId, { status: 'paused' });
            ctx.scheduler!.unregister(planId);
            logDebug(`ButtonHandler: paused plan ${planId}`);

            if (plan.channel_id && ctx.bot) {
                const baseName = plan.human_summary || planId;
                if (!baseName.endsWith('（停止中）')) {
                    renameChannelId = plan.channel_id;
                    renameNewName = baseName + '（停止中）';
                }
            }
        } else if (plan.status === 'paused') {
            ctx.planStore!.update(planId, { status: 'active' });
            const updated = ctx.planStore!.get(planId);
            if (updated) { ctx.scheduler!.register(updated); }
            logDebug(`ButtonHandler: resumed plan ${planId}`);

            if (plan.channel_id && ctx.bot) {
                const baseName = (plan.human_summary || planId).replace(/（停止中）$/, '');
                renameChannelId = plan.channel_id;
                renameNewName = baseName;
            }
        }

        const plans = ctx.planStore!.getAll();
        const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
        await interaction.update({ embeds, components: components as any });

        if (renameChannelId && renameNewName && ctx.bot) {
            debouncedRename(ctx, renameChannelId, renameNewName);
        }
        return true;
    }

    if (customId.startsWith('sched_delete_')) {
        const planId = customId.replace('sched_delete_', '');
        const plan = ctx.planStore!.get(planId);
        if (!plan) {
            await interaction.reply({ embeds: [buildEmbed(t('btnSched.planNotFound', planId), EmbedColor.Warning)] });
            return true;
        }

        const { embeds, components } = buildDeleteConfirmEmbed(plan);
        await interaction.update({ embeds, components: components as any });
        return true;
    }

    if (customId.startsWith('sched_confirm_delete_')) {
        const planId = customId.replace('sched_confirm_delete_', '');
        const planToDelete = ctx.planStore!.get(planId);
        ctx.scheduler!.unregister(planId);
        const removed = ctx.planStore!.remove(planId);

        if (removed) {
            logDebug(`ButtonHandler: deleted plan ${planId}`);
            if (planToDelete?.channel_id && ctx.bot) {
                await ctx.bot.deletePlanChannel(planToDelete.channel_id);
            }
        }

        const plans = ctx.planStore!.getAll();
        const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
        await interaction.update({ embeds, components: components as any });
        return true;
    }

    if (customId === 'sched_cancel_delete') {
        const plans = ctx.planStore!.getAll();
        const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
        await interaction.update({ embeds, components: components as any });
        return true;
    }

    // ▶️ 即時実行ボタン
    if (customId.startsWith('sched_run_')) {
        const planId = customId.replace('sched_run_', '');
        const plan = ctx.planStore!.get(planId);
        if (!plan) {
            await interaction.reply({ embeds: [buildEmbed(t('btnSched.planNotFound', planId), EmbedColor.Warning)] });
            return true;
        }

        const summary = plan.human_summary || plan.prompt.substring(0, 60);
        await interaction.reply({
            embeds: [buildEmbed(t('btnSched.runImmediate', summary), EmbedColor.Info)],
        });

        // 変数展開
        const expandedPrompt = TemplateStore.expandVariables(plan.prompt);

        // 即時実行用の Plan を複製（元の Plan は変更しない）
        const immediatePlan: import('./types').Plan = {
            ...plan,
            plan_id: plan.plan_id + '_run_' + Date.now(),
            prompt: expandedPrompt,
            cron: null,
            notify_channel_id: interaction.channelId || plan.notify_channel_id,
        };

        const wsName = plan.workspace_name || '';
        if (ctx.executorPool) {
            await ctx.executorPool.enqueueImmediate(wsName, immediatePlan);
        } else if (ctx.executor) {
            await ctx.executor.enqueueImmediate(immediatePlan);
        }
        logDebug(`sched_run: enqueued immediate execution for plan ${planId}`);
        return true;
    }

    // ✏️ 編集ボタン → モーダル表示
    if (customId.startsWith('sched_edit_')) {
        const planId = customId.replace('sched_edit_', '');
        const plan = ctx.planStore!.get(planId);
        if (!plan) {
            await interaction.reply({ embeds: [buildEmbed(t('btnSched.planNotFound', planId), EmbedColor.Warning)] });
            return true;
        }

        const modal = new ModalBuilder()
            .setCustomId(`sched_modal_edit_${planId}`)
            .setTitle(t('btnSched.editTitle'));

        const promptInput = new TextInputBuilder()
            .setCustomId('sched_edit_prompt')
            .setLabel(t('btnSched.promptLabel'))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000)
            .setValue(plan.prompt.substring(0, 2000));

        const cronInput = new TextInputBuilder()
            .setCustomId('sched_edit_cron_text')
            .setLabel(t('btnSched.cronLabel'))
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
            .setValue(plan.cron || '')
            .setPlaceholder(t('btnSched.cronPlaceholderEdit'));

        const summaryInput = new TextInputBuilder()
            .setCustomId('sched_edit_summary')
            .setLabel(t('btnSched.nameLabel'))
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(60)
            .setValue(plan.human_summary || '');

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput) as any,
            new ActionRowBuilder<TextInputBuilder>().addComponents(cronInput) as any,
            new ActionRowBuilder<TextInputBuilder>().addComponents(summaryInput) as any,
        );

        await interaction.showModal(modal);
        return true;
    }

    return false;
}
