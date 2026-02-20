// ---------------------------------------------------------------------------
// templateHandler.ts — テンプレート管理ハンドラ
// ---------------------------------------------------------------------------
// 責務:
//   1. テンプレートボタンインタラクション処理
//   2. テンプレート一覧パネル生成
//   3. テンプレートモーダル送信ハンドラ
// ---------------------------------------------------------------------------
import * as fs from 'fs';

import {
    ButtonInteraction,
    ModalSubmitInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { parsePlanJson, buildPlan } from './planParser';
import { logDebug, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { BridgeContext } from './bridgeContext';
import { buildPlanPrompt } from './messageHandler';
import { getResponseTimeout } from './configHelper';

import { TemplateStore } from './templateStore';

// ---------------------------------------------------------------------------
// テンプレート一覧パネル生成
// ---------------------------------------------------------------------------

export function buildTemplateListPanel(
    templateStore: TemplateStore,
): { embeds: ReturnType<typeof buildEmbed>[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const templates = templateStore.getAll();

    if (templates.length === 0) {
        const embed = buildEmbed('📋 **テンプレート一覧**\n\n保存済みテンプレートはありません。\n「➕ 新規作成」ボタンからテンプレートを追加できます。', EmbedColor.Info);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('tpl_new')
                .setLabel('➕ 新規作成')
                .setStyle(ButtonStyle.Success),
        );
        return { embeds: [embed], components: [row] };
    }

    const lines = ['📋 **テンプレート一覧**\n'];
    templates.forEach((t, i) => {
        const shortPrompt = t.prompt.length > 60 ? t.prompt.substring(0, 60) + '...' : t.prompt;
        lines.push(`**${i + 1}. ${t.name}**\n\`${shortPrompt}\``);
    });

    // 各テンプレートに ▶実行 / 🗑️削除 ボタンを追加（ActionRow 上限考慮: 新規作成ボタン用に4行まで）
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    const maxRows = Math.min(templates.length, 4);
    for (let i = 0; i < maxRows; i++) {
        const t = templates[i];
        const safeName = t.name.substring(0, 40);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`tpl_run_${safeName}`)
                .setLabel(`▶ ${safeName}`)
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`tpl_del_${safeName}`)
                .setLabel(`🗑️ ${safeName}`)
                .setStyle(ButtonStyle.Danger),
        );
        rows.push(row);
    }

    // 新規作成ボタン（最後の ActionRow）
    const createRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('tpl_new')
            .setLabel('➕ 新規作成')
            .setStyle(ButtonStyle.Success),
    );
    rows.push(createRow);

    return { embeds: [buildEmbed(lines.join('\n'), EmbedColor.Info)], components: rows };
}

// ---------------------------------------------------------------------------
// テンプレートボタンハンドラ
// ---------------------------------------------------------------------------

export async function handleTemplateButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
    customId: string,
): Promise<void> {
    const templateStore = ctx.templateStore;
    if (!templateStore) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ TemplateStore が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
        return;
    }

    // ➕ 新規作成ボタン → モーダルを表示
    if (customId === 'tpl_new') {
        const modal = new ModalBuilder()
            .setCustomId('tpl_modal_save')
            .setTitle('テンプレート新規作成');

        const nameInput = new TextInputBuilder()
            .setCustomId('tpl_name')
            .setLabel('テンプレート名')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(40)
            .setPlaceholder('例: daily-report');

        const promptInput = new TextInputBuilder()
            .setCustomId('tpl_prompt')
            .setLabel('プロンプト内容')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000)
            .setPlaceholder('例: 今日のタスクをまとめてください。変数: {{date}}, {{time}}');

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput) as any,
            new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput) as any,
        );

        await interaction.showModal(modal);
        return;
    }

    // キャンセルボタン
    if (customId === 'tpl_cancel') {
        await interaction.update({ embeds: [buildEmbed('❌ キャンセルしました。', EmbedColor.Info)], components: [] });
        return;
    }

    // ▶ 実行ボタン（一覧から）→ プレビュー確認に遷移
    if (customId.startsWith('tpl_run_')) {
        const name = customId.slice('tpl_run_'.length);
        const template = templateStore.get(name);
        if (!template) {
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)], ephemeral: true });
            return;
        }

        const expandedPrompt = TemplateStore.expandVariables(template.prompt);
        const previewLines = [
            `📄 **テンプレート「${name}」プレビュー**`,
            '',
            '```',
            expandedPrompt.length > 500 ? expandedPrompt.substring(0, 500) + '...' : expandedPrompt,
            '```',
        ];

        const safeName = name.substring(0, 40);
        const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`tpl_confirm_run_${safeName}`)
                .setLabel('▶ 実行')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('tpl_cancel')
                .setLabel('❌ キャンセル')
                .setStyle(ButtonStyle.Secondary),
        );

        await interaction.reply({ embeds: [buildEmbed(previewLines.join('\n'), EmbedColor.Info)], components: [confirmRow as any] });
        return;
    }

    // 🗑️ 削除ボタン（一覧から）→ 削除確認に遷移
    if (customId.startsWith('tpl_del_') && !customId.startsWith('tpl_confirm_del_')) {
        const name = customId.slice('tpl_del_'.length);
        const template = templateStore.get(name);
        if (!template) {
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)], ephemeral: true });
            return;
        }

        const safeName = name.substring(0, 40);
        const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`tpl_confirm_del_${safeName}`)
                .setLabel('🗑️ 削除する')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('tpl_cancel')
                .setLabel('❌ キャンセル')
                .setStyle(ButtonStyle.Secondary),
        );

        await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」を本当に削除しますか？`, EmbedColor.Warning)], components: [confirmRow as any] });
        return;
    }

    // ✅ 実行確認ボタン
    if (customId.startsWith('tpl_confirm_run_')) {
        const name = customId.slice('tpl_confirm_run_'.length);
        const template = templateStore.get(name);
        if (!template) {
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)], ephemeral: true });
            return;
        }

        const cdp = ctx.cdp;
        const executor = ctx.executor;
        const fileIpc = ctx.fileIpc;
        const planStore = ctx.planStore;

        if (!executor || !cdp || !fileIpc || !planStore) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Bridge が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
            return;
        }

        await interaction.update({ embeds: [buildEmbed(`⏳ テンプレート「${name}」を実行中...`, EmbedColor.Info)], components: [] });

        const tplIpcDir = fileIpc.getIpcDir();
        const expandedPrompt = TemplateStore.expandVariables(template.prompt);
        const { responsePath } = fileIpc.createRequestId();
        const { prompt: tplPlanPrompt, tempFiles: tplTempFiles } = buildPlanPrompt(expandedPrompt, 'agent-chat', 'template-run', responsePath, undefined, undefined, tplIpcDir);
        try {
            await cdp.sendPrompt(tplPlanPrompt);
            const responseTimeout = getResponseTimeout();
            const planResponse = await fileIpc.waitForResponse(responsePath, responseTimeout);

            const planOutput = parsePlanJson(planResponse);
            if (!planOutput) {
                await interaction.editReply({ embeds: [buildEmbed('⚠️ 応答を解析できませんでした。', EmbedColor.Warning)] });
                return;
            }

            const plan = buildPlan(planOutput, interaction.channelId, interaction.channelId);
            if (plan.discord_templates.ack) {
                await interaction.editReply({ embeds: [buildEmbed(plan.discord_templates.ack, EmbedColor.Info)] });
            }

            const wsName = cdp.getActiveWorkspaceName() || undefined;
            if (wsName) { plan.workspace_name = wsName; }

            await executor.enqueueImmediate(plan);
            logDebug(`handleTemplateButton: tpl_confirm_run "${name}" — plan ${plan.plan_id} enqueued`);
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            logError('handleTemplateButton: tpl_confirm_run failed', e);
            await interaction.editReply({ embeds: [buildEmbed(`❌ テンプレート実行エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
        } finally {
            // 一時ファイルのクリーンアップ
            for (const f of tplTempFiles) {
                try { fs.unlinkSync(f); } catch { /* ignore */ }
            }
        }
        return;
    }

    // ✅ 削除確認ボタン → 削除後にリストを再表示
    if (customId.startsWith('tpl_confirm_del_')) {
        const name = customId.slice('tpl_confirm_del_'.length);
        const deleted = templateStore.delete(name);
        if (deleted) {
            // 削除成功 → 更新されたテンプレート一覧を再表示
            const { embeds, components } = buildTemplateListPanel(templateStore);
            const successEmbed = buildEmbed(`🗑️ テンプレート「${name}」を削除しました。`, EmbedColor.Success);
            await interaction.update({ embeds: [successEmbed, ...embeds], components: components as any });
        } else {
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)], ephemeral: true });
        }
        return;
    }

    logWarn(`handleTemplateButton: unknown tpl_ customId: ${customId}`);
    await interaction.reply({ embeds: [buildEmbed(`⚠️ 不明なテンプレートボタン: ${customId}`, EmbedColor.Warning)], ephemeral: true });
}

// ---------------------------------------------------------------------------
// テンプレートモーダル送信ハンドラ
// ---------------------------------------------------------------------------

export async function handleModalSubmit(
    ctx: BridgeContext,
    interaction: ModalSubmitInteraction,
): Promise<void> {
    if (interaction.customId !== 'tpl_modal_save') {
        logWarn(`handleModalSubmit: unknown modal customId: ${interaction.customId}`);
        return;
    }

    const templateStore = ctx.templateStore;
    if (!templateStore) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ TemplateStore が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
        return;
    }

    const name = interaction.fields.getTextInputValue('tpl_name').trim();
    const prompt = interaction.fields.getTextInputValue('tpl_prompt').trim();

    if (!name || !prompt) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ テンプレート名とプロンプトの両方を入力してください。', EmbedColor.Warning)], ephemeral: true });
        return;
    }

    templateStore.save(name, prompt);

    // 保存後にテンプレート一覧を再表示
    const { embeds, components } = buildTemplateListPanel(templateStore);
    const successEmbed = buildEmbed(`📝 テンプレート「${name}」を保存しました。`, EmbedColor.Success);
    await interaction.reply({ embeds: [successEmbed, ...embeds], components: components as any });
}
