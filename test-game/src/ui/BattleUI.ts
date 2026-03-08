// BattleUI.ts — バトル結果表示 & ランキング表示
import type { BattleResult } from '../game/Battle';
import type { RankEntry } from '../game/Ranking';

export class BattleUI {
    private result: BattleResult | null = null;
    private alpha: number = 0;
    private showTime: number = 0;
    private phase: 'in' | 'show' | 'out' | 'none' = 'none';

    // ランキング表示
    private rankings: RankEntry[] | null = null;
    private rankingVisible: boolean = false;
    private closeRankRect = { x: 0, y: 0, w: 0, h: 0 };

    showResult(result: BattleResult): void {
        this.result = result;
        this.alpha = 0;
        this.phase = 'in';
        this.showTime = 0;
    }

    showRanking(rankings: RankEntry[]): void {
        this.rankings = rankings;
        this.rankingVisible = true;
    }

    hideRanking(): void {
        this.rankingVisible = false;
        this.rankings = null;
    }

    get isRankingVisible(): boolean {
        return this.rankingVisible;
    }

    isRankingCloseClicked(mx: number, my: number): boolean {
        const r = this.closeRankRect;
        return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
    }

    update(dt: number): void {
        switch (this.phase) {
            case 'in':
                this.alpha += dt * 3;
                if (this.alpha >= 1) { this.alpha = 1; this.phase = 'show'; }
                break;
            case 'show':
                this.showTime += dt;
                if (this.showTime >= 2.5) this.phase = 'out';
                break;
            case 'out':
                this.alpha -= dt * 2;
                if (this.alpha <= 0) { this.alpha = 0; this.phase = 'none'; this.result = null; }
                break;
        }
    }

    draw(ctx: CanvasRenderingContext2D): void {
        // バトル結果
        if (this.result && this.phase !== 'none') {
            ctx.save();
            ctx.globalAlpha = this.alpha;

            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(150, 200, 500, 180);

            ctx.strokeStyle = this.result.won ? '#44cc44' : '#cc4444';
            ctx.lineWidth = 3;
            ctx.strokeRect(150, 200, 500, 180);

            ctx.font = 'bold 28px monospace';
            ctx.fillStyle = this.result.won ? '#44ff44' : '#ff4444';
            ctx.textAlign = 'center';
            ctx.fillText(this.result.won ? '⚔️ 勝利！' : '💀 敗北...', 400, 250);

            ctx.font = '14px monospace';
            ctx.fillStyle = '#cccccc';
            ctx.fillText(`vs ${this.result.enemyName} (兵力: ${this.result.enemySoldiers})`, 400, 285);

            if (this.result.won) {
                ctx.fillStyle = '#ffd700';
                ctx.fillText(`💰 獲得ゴールド: +${this.result.goldReward}`, 400, 315);
            }
            ctx.fillStyle = '#cc8888';
            ctx.fillText(`⚔️ 損失兵力: -${this.result.soldiersLost}`, 400, 345);

            ctx.textAlign = 'left';
            ctx.restore();
        }

        // ランキング表示
        if (this.rankingVisible && this.rankings) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.fillRect(100, 60, 600, 480);
            ctx.strokeStyle = '#ffd700';
            ctx.lineWidth = 2;
            ctx.strokeRect(100, 60, 600, 480);

            ctx.font = 'bold 22px monospace';
            ctx.fillStyle = '#ffd700';
            ctx.textAlign = 'center';
            ctx.fillText('🏆 ランキング TOP 10', 400, 100);

            ctx.font = '14px monospace';
            this.rankings.forEach((entry, i) => {
                const y = 135 + i * 36;
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                ctx.fillStyle = entry.isPlayer ? '#ffd700' : '#cccccc';
                ctx.textAlign = 'left';
                ctx.fillText(`${medal}`, 140, y);
                ctx.fillText(entry.name, 200, y);
                ctx.textAlign = 'right';
                ctx.fillText(entry.score.toLocaleString(), 660, y);
            });

            // 閉じるボタン
            const clsX = 320, clsY = 500, clsW = 160, clsH = 32;
            this.closeRankRect = { x: clsX, y: clsY, w: clsW, h: clsH };
            ctx.fillStyle = '#553333';
            ctx.fillRect(clsX, clsY, clsW, clsH);
            ctx.strokeStyle = '#cc6666';
            ctx.strokeRect(clsX, clsY, clsW, clsH);
            ctx.textAlign = 'center';
            ctx.fillStyle = '#ffcccc';
            ctx.fillText('✖ 閉じる', clsX + clsW / 2, clsY + 22);

            ctx.textAlign = 'left';
        }
    }
}
