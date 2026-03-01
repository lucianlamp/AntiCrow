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
    TextChannel,
} from 'discord.js';
import { DiscordBot } from './discordBot';
import { parsePlanJson, buildPlan } from './planParser';
import { logDebug, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { BridgeContext } from './bridgeContext';
import { buildPlanPrompt } from './messageHandler';
import { getResponseTimeout } from './configHelper';

import { TemplateStore, parseTemplateArgs } from './templateStore';

// ---------------------------------------------------------------------------
// テンプレート一覧パネル生成
// ---------------------------------------------------------------------------

export function buildTemplateListPanel(
    templateStore: TemplateStore,
): { embeds: ReturnType<typeof buildEmbed>[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const templates = templateStore.getAll();

    const guideText = [
        '\n📖 **変数ガイド**',
        '**組み込み変数:** `{{date}}` `{{time}}` `{{datetime}}` `{{year}}` `{{month}}` `{{day}}`',
        '**環境変数:** `{{env:VARIABLE_NAME}}` — OS環境変数を展開',
        '**カスタム引数:** `{{引数名}}` 形式で定義 → 実行時にモーダルで入力（最大5個）',
    ].join('\n');

    if (templates.length === 0) {
        const embed = buildEmbed('📋 **テンプレート一覧**\n\n保存済みテンプレートはありません。\n「➕ 新規作成」ボタンからテンプレートを追加できます。' + guideText, EmbedColor.Info);
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
    lines.push(guideText);

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
        await interaction.reply({ embeds: [buildEmbed('⚠️ TemplateStore が初期化されていません。', EmbedColor.Warning)] });
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

    // ▶ 実行ボタン（一覧から）
    if (customId.startsWith('tpl_run_')) {
        const name = customId.slice('tpl_run_'.length);
        const template = templateStore.get(name);
        if (!template) {
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)] });
            return;
        }

        // 引数を検出（保存済み or 再パース）
        const args = template.args ?? parseTemplateArgs(template.prompt);

        if (args.length > 0) {
            // 引数あり → 引数入力モーダルを表示
            const safeName = name.substring(0, 30);
            const modal = new ModalBuilder()
                .setCustomId(`tpl_modal_args_${safeName}`)
                .setTitle(`テンプレート「${safeName}」実行`);

            const maxArgs = Math.min(args.length, 5); // Discord モーダル上限: 5
            for (let i = 0; i < maxArgs; i++) {
                const arg = args[i];
                const input = new TextInputBuilder()
                    .setCustomId(`tpl_arg_${arg.name}`)
                    .setLabel(arg.label)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(arg.required !== false)
                    .setMaxLength(500);
                if (arg.placeholder) { input.setPlaceholder(arg.placeholder); }
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(input) as any,
                );
            }

            await interaction.showModal(modal);
            return;
        }

        // 引数なし → 従来通りプレビュー確認に遷移
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
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)] });
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
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)] });
            return;
        }

        const fileIpc = ctx.fileIpc;
        const planStore = ctx.planStore;

        if (!fileIpc || !planStore) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Bridge が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        // ワークスペース解決（チャンネルの親カテゴリーから）
        const channel = interaction.channel as TextChannel | null;
        const wsNameFromCategory = (channel && 'parent' in channel)
            ? DiscordBot.resolveWorkspaceFromChannel(channel as TextChannel) ?? undefined
            : undefined;

        // CdpBridge 取得: CdpPool がある場合はワークスペース名で acquire
        let activeCdp = ctx.cdp;
        if (wsNameFromCategory && ctx.cdpPool) {
            try {
                activeCdp = await ctx.cdpPool.acquire(wsNameFromCategory);
                logDebug(`handleTemplateButton: acquired CdpBridge for workspace "${wsNameFromCategory}"`);
            } catch (e) {
                logWarn(`handleTemplateButton: failed to acquire CdpBridge for "${wsNameFromCategory}": ${e instanceof Error ? e.message : e}`);
                // フォールバック: ctx.cdp を使用
            }
        }

        if (!activeCdp) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        await interaction.update({ embeds: [buildEmbed(`⏳ テンプレート「${name}」を実行中...`, EmbedColor.Info)], components: [] });

        const tplIpcDir = fileIpc.getIpcDir();
        const expandedPrompt = TemplateStore.expandVariables(template.prompt);
        const { requestId: tplReqId, responsePath } = fileIpc.createRequestId();
        fileIpc.writeRequestMeta(tplReqId, interaction.channelId, wsNameFromCategory);
        const { prompt: tplPlanPrompt, tempFiles: tplTempFiles } = buildPlanPrompt(expandedPrompt, 'agent-chat', 'template-run', responsePath, undefined, undefined, tplIpcDir);
        try {
            await activeCdp.sendPrompt(tplPlanPrompt);
            const responseTimeout = getResponseTimeout();
            fileIpc.registerActiveRequest(tplReqId, tplTempFiles);
            let planResponse: string;
            try {
                planResponse = await fileIpc.waitForResponse(responsePath, responseTimeout);
            } finally {
                fileIpc.unregisterActiveRequest(tplReqId, tplTempFiles);
            }

            const planOutput = parsePlanJson(planResponse);
            if (!planOutput) {
                const trimmedResp = planResponse.trim();
                if (/^(?:#|\*\*|[-•]|[✅❌🔧📋📸💡⚠️🎉])/.test(trimmedResp)) {
                    logWarn(`handleTemplateButton: plan_generation response appears to be Markdown instead of JSON`);
                }
                await interaction.editReply({ embeds: [buildEmbed('⚠️ 応答を解析できませんでした。', EmbedColor.Warning)] });
                return;
            }

            const plan = buildPlan(planOutput, interaction.channelId, interaction.channelId);
            if (plan.discord_templates.ack) {
                await interaction.editReply({ embeds: [buildEmbed(plan.discord_templates.ack, EmbedColor.Info)] });
            }

            const wsName = wsNameFromCategory || activeCdp.getActiveWorkspaceName() || undefined;
            if (wsName) { plan.workspace_name = wsName; }

            // ExecutorPool がある場合はワークスペース指定で enqueue
            if (ctx.executorPool && wsName) {
                await ctx.executorPool.enqueueImmediate(wsName, plan);
            } else if (ctx.executor) {
                await ctx.executor.enqueueImmediate(plan);
            }
            logDebug(`handleTemplateButton: tpl_confirm_run "${name}" — plan ${plan.plan_id} enqueued (ws=${wsName || 'default'})`);
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
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)] });
        }
        return;
    }

    logWarn(`handleTemplateButton: unknown tpl_ customId: ${customId}`);
    await interaction.reply({ embeds: [buildEmbed(`⚠️ 不明なテンプレートボタン: ${customId}`, EmbedColor.Warning)] });
}

// ---------------------------------------------------------------------------
// テンプレートモーダル送信ハンドラ
// ---------------------------------------------------------------------------

export async function handleModalSubmit(
    ctx: BridgeContext,
    interaction: ModalSubmitInteraction,
): Promise<void> {
    // テンプレート保存モーダル
    if (interaction.customId === 'tpl_modal_save') {
        const templateStore = ctx.templateStore;
        if (!templateStore) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ TemplateStore が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        const name = interaction.fields.getTextInputValue('tpl_name').trim();
        const prompt = interaction.fields.getTextInputValue('tpl_prompt').trim();

        if (!name || !prompt) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ テンプレート名とプロンプトの両方を入力してください。', EmbedColor.Warning)] });
            return;
        }

        templateStore.save(name, prompt);

        // 保存後にテンプレート一覧を再表示
        const { embeds, components } = buildTemplateListPanel(templateStore);
        const detectedArgs = parseTemplateArgs(prompt);
        const argInfo = detectedArgs.length > 0
            ? `\n検出された引数: ${detectedArgs.map(a => `\`{{${a.name}}}\``).join(', ')}`
            : '';
        const successEmbed = buildEmbed(`📝 テンプレート「${name}」を保存しました。${argInfo}`, EmbedColor.Success);
        await interaction.reply({ embeds: [successEmbed, ...embeds], components: components as any });
        return;
    }

    // テンプレート引数入力モーダル
    if (interaction.customId.startsWith('tpl_modal_args_')) {
        const name = interaction.customId.slice('tpl_modal_args_'.length);
        const templateStore = ctx.templateStore;
        if (!templateStore) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ TemplateStore が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        const template = templateStore.get(name);
        if (!template) {
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)] });
            return;
        }

        const fileIpc = ctx.fileIpc;
        const planStore = ctx.planStore;

        if (!fileIpc || !planStore) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Bridge が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        // ワークスペース解決（チャンネルの親カテゴリーから）
        const channel = interaction.channel as TextChannel | null;
        const wsNameFromCategory = (channel && 'parent' in channel)
            ? DiscordBot.resolveWorkspaceFromChannel(channel as TextChannel) ?? undefined
            : undefined;

        // CdpBridge 取得: CdpPool がある場合はワークスペース名で acquire
        let activeCdp = ctx.cdp;
        if (wsNameFromCategory && ctx.cdpPool) {
            try {
                activeCdp = await ctx.cdpPool.acquire(wsNameFromCategory);
                logDebug(`handleModalSubmit: acquired CdpBridge for workspace "${wsNameFromCategory}"`);
            } catch (e) {
                logWarn(`handleModalSubmit: failed to acquire CdpBridge for "${wsNameFromCategory}": ${e instanceof Error ? e.message : e}`);
                // フォールバック: ctx.cdp を使用
            }
        }

        if (!activeCdp) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        // 引数値を収集
        const args = template.args ?? parseTemplateArgs(template.prompt);
        const userArgs: Record<string, string> = {};
        for (const arg of args) {
            try {
                const value = interaction.fields.getTextInputValue(`tpl_arg_${arg.name}`);
                if (value) { userArgs[arg.name] = value; }
            } catch { /* optional arg not submitted */ }
        }

        await interaction.reply({ embeds: [buildEmbed(`⏳ テンプレート「${name}」を実行中...`, EmbedColor.Info)] });

        const tplIpcDir = fileIpc.getIpcDir();
        const expandedPrompt = TemplateStore.expandVariables(template.prompt, userArgs);
        const { requestId: tplReqId2, responsePath } = fileIpc.createRequestId();
        fileIpc.writeRequestMeta(tplReqId2, interaction.channelId ?? '', wsNameFromCategory);
        const { prompt: tplPlanPrompt, tempFiles: tplTempFiles } = buildPlanPrompt(expandedPrompt, 'agent-chat', 'template-run', responsePath, undefined, undefined, tplIpcDir);
        try {
            await activeCdp.sendPrompt(tplPlanPrompt);
            const responseTimeout = getResponseTimeout();
            fileIpc.registerActiveRequest(tplReqId2, tplTempFiles);
            let planResponse: string;
            try {
                planResponse = await fileIpc.waitForResponse(responsePath, responseTimeout);
            } finally {
                fileIpc.unregisterActiveRequest(tplReqId2, tplTempFiles);
            }

            const planOutput = parsePlanJson(planResponse);
            if (!planOutput) {
                const trimmedResp = planResponse.trim();
                if (/^(?:#|\*\*|[-•]|[✅❌🔧📋📸💡⚠️🎉])/.test(trimmedResp)) {
                    logWarn(`handleModalSubmit: plan_generation response appears to be Markdown instead of JSON`);
                }
                await interaction.editReply({ embeds: [buildEmbed('⚠️ 応答を解析できませんでした。', EmbedColor.Warning)] });
                return;
            }

            const channelId = interaction.channelId ?? '';
            const plan = buildPlan(planOutput, channelId, channelId);
            if (plan.discord_templates.ack) {
                await interaction.editReply({ embeds: [buildEmbed(plan.discord_templates.ack, EmbedColor.Info)] });
            }

            const wsName = wsNameFromCategory || activeCdp.getActiveWorkspaceName() || undefined;
            if (wsName) { plan.workspace_name = wsName; }

            // ExecutorPool がある場合はワークスペース指定で enqueue
            if (ctx.executorPool && wsName) {
                await ctx.executorPool.enqueueImmediate(wsName, plan);
            } else if (ctx.executor) {
                await ctx.executor.enqueueImmediate(plan);
            }
            logDebug(`handleModalSubmit: tpl_modal_args "${name}" — plan ${plan.plan_id} enqueued (ws=${wsName || 'default'})`);
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            logError('handleModalSubmit: tpl_modal_args failed', e);
            await interaction.editReply({ embeds: [buildEmbed(`❌ テンプレート実行エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
        } finally {
            for (const f of tplTempFiles) {
                try { fs.unlinkSync(f); } catch { /* ignore */ }
            }
        }
        return;
    }

    logWarn(`handleModalSubmit: unknown modal customId: ${interaction.customId}`);
}
