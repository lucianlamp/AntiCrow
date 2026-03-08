// Panel.ts — アップグレードパネル
import type { Building } from '../game/Building';

export class UpgradePanel {
    visible: boolean = false;
    building: Building | null = null;
    x: number = 200;
    y: number = 180;
    width: number = 400;
    height: number = 220;
    private upgradeButtonRect = { x: 0, y: 0, w: 0, h: 0 };
    private closeButtonRect = { x: 0, y: 0, w: 0, h: 0 };

    show(building: Building): void {
        this.building = building;
        this.visible = true;
    }

    hide(): void {
        this.visible = false;
        this.building = null;
    }

    draw(ctx: CanvasRenderingContext2D, gold: number): void {
        if (!this.visible || !this.building) return;

        // Overlay
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, 800, 600);

        // Panel background
        const gradient = ctx.createLinearGradient(this.x, this.y, this.x, this.y + this.height);
        gradient.addColorStop(0, '#2a2a3a');
        gradient.addColorStop(1, '#1a1a2a');
        ctx.fillStyle = gradient;
        ctx.fillRect(this.x, this.y, this.width, this.height);
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 2;
        ctx.strokeRect(this.x, this.y, this.width, this.height);

        // Title
        ctx.font = 'bold 20px monospace';
        ctx.fillStyle = '#ffd700';
        ctx.textAlign = 'center';
        ctx.fillText(`${this.building.config.name} - Lv.${this.building.level}`, this.x + this.width / 2, this.y + 40);

        // Info
        ctx.font = '14px monospace';
        ctx.fillStyle = '#cccccc';
        ctx.fillText(`生産量: +${this.building.production}/s`, this.x + this.width / 2, this.y + 75);
        ctx.fillText(`次レベル生産: +${this.building.config.baseProduction * (this.building.level + 1)}/s`, this.x + this.width / 2, this.y + 100);

        // Cost
        const cost = this.building.upgradeCost;
        const canAfford = gold >= cost;
        ctx.fillStyle = canAfford ? '#ffd700' : '#cc4444';
        ctx.font = 'bold 16px monospace';
        ctx.fillText(`アップグレード費用: 💰 ${cost}`, this.x + this.width / 2, this.y + 135);

        // Upgrade button
        const btnX = this.x + 60;
        const btnY = this.y + 155;
        const btnW = 160;
        const btnH = 40;
        this.upgradeButtonRect = { x: btnX, y: btnY, w: btnW, h: btnH };

        const btnGradient = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnH);
        if (canAfford) {
            btnGradient.addColorStop(0, '#228822');
            btnGradient.addColorStop(1, '#115511');
        } else {
            btnGradient.addColorStop(0, '#444444');
            btnGradient.addColorStop(1, '#333333');
        }
        ctx.fillStyle = btnGradient;
        ctx.fillRect(btnX, btnY, btnW, btnH);
        ctx.strokeStyle = canAfford ? '#44cc44' : '#666666';
        ctx.strokeRect(btnX, btnY, btnW, btnH);
        ctx.font = 'bold 14px monospace';
        ctx.fillStyle = canAfford ? '#ffffff' : '#888888';
        ctx.fillText('⬆️ Upgrade', btnX + btnW / 2, btnY + 26);

        // Close button
        const clsX = this.x + this.width - 220;
        const clsY = this.y + 155;
        const clsW = 160;
        const clsH = 40;
        this.closeButtonRect = { x: clsX, y: clsY, w: clsW, h: clsH };

        ctx.fillStyle = '#553333';
        ctx.fillRect(clsX, clsY, clsW, clsH);
        ctx.strokeStyle = '#cc6666';
        ctx.strokeRect(clsX, clsY, clsW, clsH);
        ctx.fillStyle = '#ffcccc';
        ctx.fillText('✖ 閉じる', clsX + clsW / 2, clsY + 26);

        ctx.textAlign = 'left';
    }

    isUpgradeClicked(mx: number, my: number): boolean {
        const r = this.upgradeButtonRect;
        return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
    }

    isCloseClicked(mx: number, my: number): boolean {
        const r = this.closeButtonRect;
        return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
    }
}
