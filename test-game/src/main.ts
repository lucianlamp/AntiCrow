// main.ts — Pixel Kingdoms エントリーポイント
import { Kingdom } from './game/Kingdom';
import { Renderer } from './render/Renderer';
import { UpgradePanel } from './ui/Panel';
import { BattleUI } from './ui/BattleUI';
import { executeBattle } from './game/Battle';
import { getRankings } from './game/Ranking';

// Canvas初期化
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// ゲーム初期化
const kingdom = new Kingdom();
kingdom.load(); // localStorage からリストア

const renderer = new Renderer(ctx, canvas.width, canvas.height);
const upgradePanel = new UpgradePanel();
const battleUI = new BattleUI();

let lastTime = performance.now();
let saveTimer = 0;

// ゲームループ
function gameLoop(now: number): void {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    // 状態更新
    kingdom.update(Date.now());
    battleUI.update(dt);

    // 自動保存（10秒ごと）
    saveTimer += dt;
    if (saveTimer >= 10) {
        kingdom.save();
        saveTimer = 0;
    }

    // 描画
    renderer.render(kingdom);
    upgradePanel.draw(ctx, kingdom.gold);
    battleUI.draw(ctx);

    requestAnimationFrame(gameLoop);
}

// クリックイベント
canvas.addEventListener('click', (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // ランキング表示中 → 閉じるのみ
    if (battleUI.isRankingVisible) {
        if (battleUI.isRankingCloseClicked(mx, my)) {
            battleUI.hideRanking();
        }
        return;
    }

    // アップグレードパネル表示中
    if (upgradePanel.visible) {
        if (upgradePanel.isUpgradeClicked(mx, my)) {
            if (upgradePanel.building && kingdom.upgradeBuilding(upgradePanel.building)) {
                kingdom.save();
            }
        } else if (upgradePanel.isCloseClicked(mx, my)) {
            upgradePanel.hide();
        }
        return;
    }

    // バトルボタン
    if (renderer.isBattleButtonClicked(mx, my)) {
        if (kingdom.soldiers >= 5) {
            const result = executeBattle(Math.floor(kingdom.soldiers));
            kingdom.soldiers -= result.soldiersLost;
            if (result.won) {
                kingdom.gold += result.goldReward;
            }
            kingdom.save();
            battleUI.showResult(result);
        }
        return;
    }

    // ランキングボタン
    if (renderer.isRankingButtonClicked(mx, my)) {
        const rankings = getRankings(kingdom.score);
        battleUI.showRanking(rankings);
        return;
    }

    // 建物クリック
    for (const building of kingdom.buildings) {
        if (building.isClicked(mx, my)) {
            upgradePanel.show(building);
            return;
        }
    }
});

// ゲーム開始
requestAnimationFrame(gameLoop);

// ページ離脱時に保存
window.addEventListener('beforeunload', () => {
    kingdom.save();
});
