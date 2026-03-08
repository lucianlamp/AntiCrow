// ぷにぷにタウン — メインエントリポイント
// engine/ と ui/ を統合、ゲームループ、イベントハンドリング、自動保存

import './style.css';
import { GameState } from './engine/GameState';
import { ALL_CHARACTERS, type CharacterDef } from './engine/Characters';
import { GachaSystem, type GachaResult } from './engine/GachaSystem';
import { TownManager } from './engine/TownManager';
import { RankingSystem } from './engine/RankingSystem';
import { Renderer, type CharacterDef as RendererCharDef } from './ui/Renderer';
import { UIManager, type TabName, type UICharInfo, type RankingEntry as UIRankEntry, type UpgradeInfo as UIUpgradeInfo } from './ui/UIManager';
import { SoundManager } from './ui/SoundManager';

// --- 初期化 ---
const gameState = new GameState();
const gachaSystem = new GachaSystem();
const townManager = new TownManager();
const rankingSystem = new RankingSystem();
const soundManager = new SoundManager();

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const uiManager = new UIManager();

// 初期のメインキャラ設定（ぷにまる）
const defaultChar = ALL_CHARACTERS[0];
renderer.setMainCharacter(toRendererChar(defaultChar));
renderer.generateBuildings(townManager.getBuildingDisplays(gameState).length);

// --- CharacterDef → Renderer 用の変換 ---
function toRendererChar(def: CharacterDef): RendererCharDef {
    return {
        id: def.id,
        name: def.name,
        rarity: def.rarity,
        color: def.color,
        shape: def.shape,
        autoIncome: def.incomePerSec,
    };
}

// --- UI コールバック ---
uiManager.setCallbacks({
    onTabChange: (tab: TabName) => {
        updateTabContent(tab);
    },
    onGachaPull: () => {
        const result: GachaResult | null = gachaSystem.pull(gameState);
        if (!result) return;

        soundManager.playGachaSpin();
        // ガチャアニメーション
        renderer.startGachaAnimation(toRendererChar(result.character));

        if (result.isNew) {
            setTimeout(() => {
                uiManager.showNewCharacterModal(result.character.name, result.character.rarity);
                soundManager.playFanfare(result.character.rarity);
            }, 2500);
        } else {
            setTimeout(() => {
                soundManager.playFanfare(result.character.rarity);
            }, 1500);
        }

        // メインキャラを最後にガチャで出たキャラに
        renderer.setMainCharacter(toRendererChar(result.character));

        updateHeader();
        // 少し遅延してガチャタブ更新
        setTimeout(() => updateTabContent('gacha'), 3000);
    },
    onUpgrade: (type: string) => {
        const success = townManager.purchaseUpgrade(gameState, type as 'tap' | 'income' | 'gacha');
        if (success) {
            soundManager.playUpgrade();
            updateHeader();
            updateTabContent('town');
        }
    },
    onTap: (x: number, y: number) => {
        handleTap(x, y);
    },
});

// --- Canvas タップ/クリックイベント ---
canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    handleTap(x, y);
});

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    handleTap(x, y);
}, { passive: false });

function handleTap(x: number, y: number): void {
    // ガチャアニメーション中はタップ無視
    if (renderer.isGachaAnimating()) return;

    const earned = gameState.tap();
    if (earned > 0) {
        soundManager.playTap();
        renderer.triggerTap(x, y);
        updateHeader();
    }
}

// --- ゲームループ ---
let lastTime = performance.now();
let autoIncomeTimer = 0;
let rankingTimer = 0;

function gameLoop(timestamp: number): void {
    const dt = Math.min((timestamp - lastTime) / 1000, 0.1); // 最大 100ms
    lastTime = timestamp;

    // 自動収益（毎秒）
    autoIncomeTimer += dt;
    if (autoIncomeTimer >= 1) {
        const earned = gameState.addAutoIncome(autoIncomeTimer);
        autoIncomeTimer = 0;
        if (earned > 0) {
            updateHeader();
        }
    }

    // ランキング ダミーデータの微成長（60秒ごと）
    rankingTimer += dt;
    if (rankingTimer >= 60) {
        rankingSystem.progressDummies();
        rankingTimer = 0;
    }

    // 街のキャラ更新
    updateTownCharacters();

    // レンダリング
    renderer.render(dt);

    requestAnimationFrame(gameLoop);
}

// --- ヘッダー更新 ---
function updateHeader(): void {
    uiManager.updateCoinDisplay(gameState.coins);
    uiManager.updateLevelDisplay(gameState.level);

    const incomeDisplay = document.getElementById('auto-income-display');
    if (incomeDisplay) {
        const income = gameState.totalIncomePerSec;
        incomeDisplay.textContent = income > 0 ? `+${formatNumber(income)}/秒` : '';
    }
}

// --- 街のキャラ更新 ---
function updateTownCharacters(): void {
    const displays = townManager.getBuildingDisplays(gameState);
    const chars: RendererCharDef[] = [];
    for (const d of displays) {
        if (d.character) {
            chars.push(toRendererChar(d.character));
        }
    }
    renderer.updateTownCharacters(chars);
}

// --- タブコンテンツ更新 ---
function updateTabContent(tab: TabName): void {
    switch (tab) {
        case 'town': {
            const stats = townManager.getTownStats(gameState);
            const upgrades = townManager.getUpgradeInfos(gameState);
            const uiUpgrades: UIUpgradeInfo[] = upgrades.map(u => ({
                type: u.type,
                name: `${u.icon} ${u.displayName}`,
                description: `${u.description}（${u.currentValue} → ${u.nextValue}）`,
                cost: u.cost,
                level: u.currentLevel,
            }));
            uiManager.renderTownOverlay(
                {
                    totalIncome: stats.totalIncomePerSec,
                    buildingCount: stats.placedCount + stats.emptySlots,
                    charCount: stats.placedCount,
                },
                uiUpgrades,
            );
            break;
        }
        case 'gacha': {
            uiManager.renderGachaTab(gameState.coins, gameState.gachaCost);
            break;
        }
        case 'collection': {
            const owned = gameState.ownedCharacters;
            const ownedCounts = new Map<string, number>();
            for (const o of owned) {
                ownedCounts.set(o.characterId, (ownedCounts.get(o.characterId) ?? 0) + 1);
            }
            const charInfos: UICharInfo[] = ALL_CHARACTERS.map(c => ({
                id: c.id,
                name: c.name,
                rarity: c.rarity,
                color: c.color,
                shape: c.shape,
                owned: ownedCounts.has(c.id),
                count: ownedCounts.get(c.id) ?? 0,
            }));
            uiManager.renderCollectionTab(charInfos);

            // コレクション画面のchar-preview canvasに小さなキャラを描画
            const previews = document.querySelectorAll<HTMLCanvasElement>('.char-preview');
            previews.forEach(cvs => {
                const charId = cvs.dataset.charId;
                const charDef = ALL_CHARACTERS.find(c => c.id === charId);
                if (charDef && ownedCounts.has(charDef.id)) {
                    const ctx = cvs.getContext('2d');
                    if (ctx) {
                        renderer.drawPuniCharacter(ctx, 30, 30, 22, toRendererChar(charDef));
                    }
                }
            });
            break;
        }
        case 'ranking': {
            const ranking = rankingSystem.getRanking(gameState, 'coins');
            const entries: UIRankEntry[] = ranking.map((e, i) => ({
                rank: i + 1,
                name: e.name,
                score: e.totalCoins,
                isPlayer: e.isPlayer,
            }));
            uiManager.renderRankingTab(entries);
            break;
        }
    }
}

// --- 自動保存（30秒ごと） ---
setInterval(() => {
    gameState.save();
}, 30_000);

// --- ページ離脱時に保存 ---
window.addEventListener('beforeunload', () => {
    gameState.save();
});

// --- 数値フォーマット ---
function formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
}

// --- 起動 ---
updateHeader();
requestAnimationFrame(gameLoop);

// BGM開始（ユーザー操作後）
document.addEventListener('click', () => {
    soundManager.startBGM();
}, { once: true });
