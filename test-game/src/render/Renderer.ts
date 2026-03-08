// Renderer.ts — メイン描画エンジン
import { Kingdom } from '../game/Kingdom';
import { drawBackground, drawBuilding } from './PixelArt';
import { drawHUD } from './HUD';

export class Renderer {
    private ctx: CanvasRenderingContext2D;
    private width: number;
    private height: number;

    constructor(ctx: CanvasRenderingContext2D, width: number, height: number) {
        this.ctx = ctx;
        this.width = width;
        this.height = height;
    }

    render(kingdom: Kingdom): void {
        // 背景
        drawBackground(this.ctx, this.width, this.height);

        // 建物描画
        for (const building of kingdom.buildings) {
            // 建物の選択可能エリアの背景ハイライト
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
            this.ctx.fillRect(building.x, building.y, building.width, building.height);
            this.ctx.strokeStyle = 'rgba(255, 200, 50, 0.2)';
            this.ctx.lineWidth = 1;
            this.ctx.strokeRect(building.x, building.y, building.width, building.height);

            // 建物名
            this.ctx.font = 'bold 13px monospace';
            this.ctx.fillStyle = building.config.accentColor;
            this.ctx.textAlign = 'center';
            this.ctx.fillText(building.config.name, building.x + building.width / 2, building.y + 16);
            this.ctx.textAlign = 'left';

            // ピクセルアート建物
            drawBuilding(this.ctx, building.type, building.x + 40, building.y + 10, building.level);

            // 生産量表示
            if (building.production > 0) {
                this.ctx.font = '10px monospace';
                this.ctx.fillStyle = '#aaaaaa';
                this.ctx.textAlign = 'center';
                this.ctx.fillText(`+${building.production}/s`, building.x + building.width / 2, building.y + building.height - 8);
                this.ctx.textAlign = 'left';
            }
        }

        // HUD
        drawHUD(this.ctx, kingdom.gold, kingdom.food, kingdom.soldiers, this.width);

        // バトルボタン領域
        this.drawBattleButton();

        // ランキングボタン領域
        this.drawRankingButton();
    }

    private drawBattleButton(): void {
        const bx = 620, by = 520, bw = 160, bh = 40;
        const gradient = this.ctx.createLinearGradient(bx, by, bx, by + bh);
        gradient.addColorStop(0, '#882222');
        gradient.addColorStop(1, '#551111');
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(bx, by, bw, bh);
        this.ctx.strokeStyle = '#cc4444';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(bx, by, bw, bh);
        this.ctx.font = 'bold 16px monospace';
        this.ctx.fillStyle = '#ffcccc';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('⚔️ 出撃！', bx + bw / 2, by + 26);
        this.ctx.textAlign = 'left';
    }

    private drawRankingButton(): void {
        const bx = 620, by = 470, bw = 160, bh = 40;
        const gradient = this.ctx.createLinearGradient(bx, by, bx, by + bh);
        gradient.addColorStop(0, '#886622');
        gradient.addColorStop(1, '#553311');
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(bx, by, bw, bh);
        this.ctx.strokeStyle = '#ccaa44';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(bx, by, bw, bh);
        this.ctx.font = 'bold 16px monospace';
        this.ctx.fillStyle = '#ffeedd';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('🏆 ランキング', bx + bw / 2, by + 26);
        this.ctx.textAlign = 'left';
    }

    // バトルボタンのクリック判定
    isBattleButtonClicked(mx: number, my: number): boolean {
        return mx >= 620 && mx <= 780 && my >= 520 && my <= 560;
    }

    // ランキングボタンのクリック判定
    isRankingButtonClicked(mx: number, my: number): boolean {
        return mx >= 620 && mx <= 780 && my >= 470 && my <= 510;
    }
}
