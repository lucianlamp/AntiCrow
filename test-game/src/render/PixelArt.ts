// PixelArt.ts — ピクセルアート描画ユーティリティ
import type { BuildingType } from '../game/Building';

const PIXEL = 4; // ピクセルサイズ

function drawPixelBlock(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, px: number = PIXEL) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, px, px);
}

// 城の描画（ピクセルアート）
function drawCastle(ctx: CanvasRenderingContext2D, x: number, y: number, level: number) {
    const gold = level > 3 ? '#ffd700' : level > 1 ? '#c9a33a' : '#8a7a5a';
    const stone = level > 3 ? '#7a6a5a' : '#5a4a3a';
    const dark = '#2a1a0a';

    // 城壁
    for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 8; j++) {
            drawPixelBlock(ctx, x + i * PIXEL + 20, y + j * PIXEL + 40, stone);
        }
    }
    // 塔（左右）
    for (let j = 0; j < 10; j++) {
        drawPixelBlock(ctx, x + 12, y + j * PIXEL + 20, stone);
        drawPixelBlock(ctx, x + 16, y + j * PIXEL + 20, stone);
        drawPixelBlock(ctx, x + 52, y + j * PIXEL + 20, stone);
        drawPixelBlock(ctx, x + 56, y + j * PIXEL + 20, stone);
    }
    // 屋根
    for (let i = 0; i < 6; i++) {
        drawPixelBlock(ctx, x + 24 + i * PIXEL, y + 28, gold);
    }
    // 旗
    drawPixelBlock(ctx, x + 36, y + 12, dark);
    drawPixelBlock(ctx, x + 36, y + 16, dark);
    drawPixelBlock(ctx, x + 40, y + 12, '#cc2222');
    drawPixelBlock(ctx, x + 44, y + 12, '#cc2222');
    // 門
    drawPixelBlock(ctx, x + 32, y + 64, dark);
    drawPixelBlock(ctx, x + 36, y + 64, dark);
    drawPixelBlock(ctx, x + 32, y + 68, dark);
    drawPixelBlock(ctx, x + 36, y + 68, dark);
    // レベル表示
    ctx.fillStyle = gold;
    ctx.font = '10px monospace';
    ctx.fillText(`Lv.${level}`, x + 26, y + 90);
}

// 農場の描画
function drawFarm(ctx: CanvasRenderingContext2D, x: number, y: number, level: number) {
    const green = level > 3 ? '#44cc44' : level > 1 ? '#338833' : '#226622';
    const brown = '#5a3a1a';
    const wheat = level > 2 ? '#ddcc44' : '#aa9933';

    // 畑
    for (let i = 0; i < 12; i++) {
        for (let j = 0; j < 4; j++) {
            drawPixelBlock(ctx, x + i * PIXEL + 8, y + j * PIXEL + 48, (i + j) % 2 === 0 ? brown : green);
        }
    }
    // 小屋
    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 4; j++) {
            drawPixelBlock(ctx, x + i * PIXEL + 24, y + j * PIXEL + 24, brown);
        }
    }
    // 屋根
    for (let i = 0; i < 7; i++) {
        drawPixelBlock(ctx, x + 20 + i * PIXEL, y + 20, '#883322');
    }
    // 麦
    for (let i = 0; i < 6; i++) {
        drawPixelBlock(ctx, x + 12 + i * 8, y + 44, wheat);
        drawPixelBlock(ctx, x + 12 + i * 8, y + 40, wheat);
    }
    ctx.fillStyle = green;
    ctx.font = '10px monospace';
    ctx.fillText(`Lv.${level}`, x + 26, y + 90);
}

// 兵舎の描画
function drawBarracks(ctx: CanvasRenderingContext2D, x: number, y: number, level: number) {
    const red = level > 3 ? '#cc3333' : level > 1 ? '#993333' : '#662222';
    const wood = '#5a3a2a';

    // 建物
    for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 6; j++) {
            drawPixelBlock(ctx, x + i * PIXEL + 16, y + j * PIXEL + 36, wood);
        }
    }
    // 屋根
    for (let i = 0; i < 12; i++) {
        drawPixelBlock(ctx, x + 12 + i * PIXEL, y + 32, red);
    }
    // 剣アイコン
    drawPixelBlock(ctx, x + 32, y + 20, '#cccccc');
    drawPixelBlock(ctx, x + 36, y + 24, '#cccccc');
    drawPixelBlock(ctx, x + 40, y + 28, '#cccccc');
    drawPixelBlock(ctx, x + 36, y + 28, '#888888');
    // 門
    drawPixelBlock(ctx, x + 32, y + 56, '#1a1a1a');
    drawPixelBlock(ctx, x + 36, y + 56, '#1a1a1a');

    ctx.fillStyle = red;
    ctx.font = '10px monospace';
    ctx.fillText(`Lv.${level}`, x + 26, y + 90);
}

// 倉庫の描画
function drawWarehouse(ctx: CanvasRenderingContext2D, x: number, y: number, level: number) {
    const blue = level > 3 ? '#4466cc' : level > 1 ? '#335599' : '#224477';
    const wood = '#4a3a2a';

    // 建物
    for (let i = 0; i < 12; i++) {
        for (let j = 0; j < 5; j++) {
            drawPixelBlock(ctx, x + i * PIXEL + 12, y + j * PIXEL + 40, wood);
        }
    }
    // 屋根
    for (let i = 0; i < 14; i++) {
        drawPixelBlock(ctx, x + 8 + i * PIXEL, y + 36, blue);
    }
    // 箱
    drawPixelBlock(ctx, x + 20, y + 52, '#ddaa33');
    drawPixelBlock(ctx, x + 24, y + 52, '#ddaa33');
    drawPixelBlock(ctx, x + 36, y + 52, '#ddaa33');
    drawPixelBlock(ctx, x + 40, y + 52, '#ddaa33');

    ctx.fillStyle = blue;
    ctx.font = '10px monospace';
    ctx.fillText(`Lv.${level}`, x + 26, y + 90);
}

export function drawBuilding(ctx: CanvasRenderingContext2D, type: BuildingType, x: number, y: number, level: number) {
    switch (type) {
        case 'castle': drawCastle(ctx, x, y, level); break;
        case 'farm': drawFarm(ctx, x, y, level); break;
        case 'barracks': drawBarracks(ctx, x, y, level); break;
        case 'warehouse': drawWarehouse(ctx, x, y, level); break;
    }
}

export function drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#0a0a2a');
    gradient.addColorStop(0.3, '#1a1a3a');
    gradient.addColorStop(0.7, '#1a2a1a');
    gradient.addColorStop(1, '#0a1a0a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // 星
    ctx.fillStyle = 'rgba(255,255,200,0.5)';
    for (let i = 0; i < 30; i++) {
        const sx = (i * 137 + 42) % width;
        const sy = (i * 97 + 13) % (height * 0.3);
        ctx.fillRect(sx, sy, 2, 2);
    }

    // 地面
    const groundGradient = ctx.createLinearGradient(0, height - 60, 0, height);
    groundGradient.addColorStop(0, '#1a2a1a');
    groundGradient.addColorStop(1, '#0a1a0a');
    ctx.fillStyle = groundGradient;
    ctx.fillRect(0, height - 60, width, 60);
}
