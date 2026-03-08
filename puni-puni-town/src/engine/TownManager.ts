/**
 * 街管理モジュール
 * キャラクター配置、自動収益計算、建物アップグレード処理を管理する
 */

import { getCharacterById, type CharacterDef } from './Characters';
import { GameState, type Building, type OwnedCharacter, getUpgradeCost } from './GameState';

/** 建物の表示情報 */
export interface BuildingDisplay {
    /** 建物データ */
    building: Building;
    /** 配置されているキャラクターの定義（null = 空き） */
    character: CharacterDef | null;
    /** この建物の自動収益/秒 */
    incomePerSec: number;
    /** 建物の表示名 */
    displayName: string;
    /** 建物のカラー */
    color: string;
}

/** 街全体の統計情報 */
export interface TownStats {
    /** 配置済みキャラ数 */
    placedCount: number;
    /** 空きスロット数 */
    emptySlots: number;
    /** 1秒あたりの自動収益合計 */
    totalIncomePerSec: number;
    /** 建物の合計レベル */
    totalBuildingLevel: number;
}

/** アップグレード情報（UI表示用） */
export interface UpgradeInfo {
    type: 'tap' | 'income' | 'gacha';
    displayName: string;
    description: string;
    currentLevel: number;
    cost: number;
    currentValue: string;
    nextValue: string;
    canAfford: boolean;
    icon: string;
}

/** 建物タイプの表示名 */
const BUILDING_NAMES: Record<Building['type'], string> = {
    house: 'おうち',
    shop: 'おみせ',
    park: 'こうえん',
    tower: 'タワー',
    castle: 'おしろ',
};

/** 建物タイプのカラー */
const BUILDING_COLORS: Record<Building['type'], string> = {
    house: '#FFB3B3',
    shop: '#B3D9FF',
    park: '#B3FFB3',
    tower: '#FFE0B3',
    castle: '#E0B3FF',
};

/**
 * 街管理クラス
 */
export class TownManager {
    /**
     * 建物の表示情報リストを取得する
     */
    getBuildingDisplays(gameState: GameState): BuildingDisplay[] {
        const buildings = gameState.buildings;
        const upgrades = gameState.upgrades;

        return buildings.map(building => {
            let character: CharacterDef | null = null;
            let incomePerSec = 0;

            if (building.characterId) {
                character = getCharacterById(building.characterId) ?? null;
                if (character) {
                    incomePerSec = Math.floor(
                        character.incomePerSec * upgrades.incomeMultiplier * building.level
                    );
                }
            }

            return {
                building,
                character,
                incomePerSec,
                displayName: BUILDING_NAMES[building.type] || building.type,
                color: BUILDING_COLORS[building.type] || '#FFFFFF',
            };
        });
    }

    /**
     * 街全体の統計情報を取得する
     */
    getTownStats(gameState: GameState): TownStats {
        const displays = this.getBuildingDisplays(gameState);
        const placedCount = displays.filter(d => d.character !== null).length;
        const emptySlots = displays.filter(d => d.character === null).length;
        const totalIncomePerSec = displays.reduce((sum, d) => sum + d.incomePerSec, 0);
        const totalBuildingLevel = displays.reduce((sum, d) => sum + d.building.level, 0);

        return {
            placedCount,
            emptySlots,
            totalIncomePerSec,
            totalBuildingLevel,
        };
    }

    /**
     * キャラクターを建物に配置する
     */
    placeCharacter(
        gameState: GameState,
        ownedIndex: number,
        buildingIndex: number
    ): boolean {
        return gameState.placeCharacterInTown(ownedIndex, buildingIndex);
    }

    /**
     * 配置可能なキャラクターの一覧を返す（まだ街に配置されていないキャラ）
     */
    getUnplacedCharacters(gameState: GameState): (OwnedCharacter & { def: CharacterDef; index: number })[] {
        const owned = gameState.ownedCharacters;
        return owned
            .map((char, index) => {
                const def = getCharacterById(char.characterId);
                return def && !char.placedInTown ? { ...char, def, index } : null;
            })
            .filter((v): v is OwnedCharacter & { def: CharacterDef; index: number } => v !== null);
    }

    /**
     * アップグレード情報を取得する（UI表示用）
     */
    getUpgradeInfos(gameState: GameState): UpgradeInfo[] {
        const upgrades = gameState.upgrades;
        const coins = gameState.coins;

        return [
            {
                type: 'tap' as const,
                displayName: 'タップパワー',
                description: 'タップ1回あたりの獲得コインをアップ',
                currentLevel: upgrades.tapLevel,
                cost: getUpgradeCost('tap', upgrades.tapLevel),
                currentValue: `×${upgrades.tapMultiplier.toFixed(1)}`,
                nextValue: `×${(1 + (upgrades.tapLevel + 1) * 0.5).toFixed(1)}`,
                canAfford: coins >= getUpgradeCost('tap', upgrades.tapLevel),
                icon: '👆',
            },
            {
                type: 'income' as const,
                displayName: '自動収益ブースト',
                description: 'キャラの自動収益をアップ',
                currentLevel: upgrades.incomeLevel,
                cost: getUpgradeCost('income', upgrades.incomeLevel),
                currentValue: `×${upgrades.incomeMultiplier.toFixed(1)}`,
                nextValue: `×${(1 + (upgrades.incomeLevel + 1) * 0.3).toFixed(1)}`,
                canAfford: coins >= getUpgradeCost('income', upgrades.incomeLevel),
                icon: '💰',
            },
            {
                type: 'gacha' as const,
                displayName: 'ガチャ割引',
                description: 'ガチャの必要コインを削減',
                currentLevel: upgrades.gachaLevel,
                cost: getUpgradeCost('gacha', upgrades.gachaLevel),
                currentValue: `${Math.floor(upgrades.gachaDiscount * 100)}%OFF`,
                nextValue: `${Math.min(50, Math.floor((upgrades.gachaLevel + 1) * 5))}%OFF`,
                canAfford: coins >= getUpgradeCost('gacha', upgrades.gachaLevel),
                icon: '🎰',
            },
        ];
    }

    /**
     * アップグレードを購入する
     */
    purchaseUpgrade(gameState: GameState, type: 'tap' | 'income' | 'gacha'): boolean {
        return gameState.purchaseUpgrade(type);
    }
}
