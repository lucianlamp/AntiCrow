// HUD.ts — HUD描画（資源表示バー）
export function drawHUD(ctx: CanvasRenderingContext2D, gold: number, food: number, soldiers: number, width: number) {
    // HUD背景
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, width, 44);
    ctx.strokeStyle = '#3a2a1a';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, width, 44);

    ctx.font = 'bold 14px monospace';
    const items = [
        { icon: '💰', label: 'Gold', value: Math.floor(gold), color: '#ffd700' },
        { icon: '🌾', label: 'Food', value: Math.floor(food), color: '#88cc44' },
        { icon: '⚔️', label: 'Army', value: Math.floor(soldiers), color: '#cc4444' },
    ];

    items.forEach((item, i) => {
        const x = 20 + i * 250;
        // アイコン
        ctx.font = '18px serif';
        ctx.fillText(item.icon, x, 30);
        // ラベル
        ctx.font = 'bold 12px monospace';
        ctx.fillStyle = '#888888';
        ctx.fillText(item.label, x + 28, 18);
        // 値
        ctx.font = 'bold 16px monospace';
        ctx.fillStyle = item.color;
        ctx.fillText(item.value.toLocaleString(), x + 28, 36);
    });

    // タイトル
    ctx.font = 'bold 12px monospace';
    ctx.fillStyle = '#ffd700';
    ctx.textAlign = 'right';
    ctx.fillText('⚜️ Pixel Kingdoms', width - 16, 28);
    ctx.textAlign = 'left';
}
