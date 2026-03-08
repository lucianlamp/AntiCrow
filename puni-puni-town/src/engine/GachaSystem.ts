/**
 * ガチャシステムモジュール
 * レアリティ確率テーブルと抽選処理を管理する
 */

import { ALL_CHARACTERS, type CharacterDef, type Rarity } from './Characters';
import { GameState } from './GameState';

/** レアリティごとの排出確率（%） */
export interface GachaProbability {
    rarity: Rarity;
    probability: number; // 0～100
}

/** ガチャ結果 */
export interface GachaResult {
    /** 獲得したキャラクター */
    character: CharacterDef;
    /** 新規キャラクターかどうか */
    isNew: boolean;
    /** 確定演出を出すべきか（★4以上） */
    isRare: boolean;
}

/** 通常ガチャの確率テーブル */
const NORMAL_GACHA_TABLE: GachaProbability[] = [
    { rarity: 1, probability: 40 },
    { rarity: 2, probability: 30 },
    { rarity: 3, probability: 20 },
    { rarity: 4, probability: 8 },
    { rarity: 5, probability: 2 },
];

/** 天井システムの回数（この回数回したら★4以上確定） */
const PITY_COUNT = 30;

/**
 * ガチャシステムクラス
 */
export class GachaSystem {
    /** 天井カウンター（最後に★4以上が出てからの回数） */
    private pitySinceLastRare: number = 0;

    /**
     * ガチャを1回引く
     * @param gameState ゲーム状態
     * @returns ガチャ結果、コイン不足の場合はnull
     */
    pull(gameState: GameState): GachaResult | null {
        const cost = gameState.gachaCost;
        if (!gameState.spendCoins(cost)) {
            return null;
        }

        this.pitySinceLastRare++;

        // 天井チェック
        const isPity = this.pitySinceLastRare >= PITY_COUNT;

        // レアリティを抽選
        const rarity = isPity ? this.rollPityRarity() : this.rollRarity();

        if (rarity >= 4) {
            this.pitySinceLastRare = 0;
        }

        // そのレアリティのキャラからランダムに選択
        const candidates = ALL_CHARACTERS.filter(c => c.rarity === rarity);
        const character = candidates[Math.floor(Math.random() * candidates.length)];

        // 新キャラかどうか判定
        const owned = gameState.ownedCharacters;
        const isNew = !owned.some(o => o.characterId === character.id);

        // キャラクターを追加
        gameState.addCharacter(character.id);

        return {
            character,
            isNew,
            isRare: rarity >= 4,
        };
    }

    /**
     * 10連ガチャを引く
     * @param gameState ゲーム状態
     * @returns 結果配列。コイン不足の場合は引けた分だけ返す
     */
    pullTen(gameState: GameState): GachaResult[] {
        const results: GachaResult[] = [];
        for (let i = 0; i < 10; i++) {
            const result = this.pull(gameState);
            if (!result) break;
            results.push(result);
        }
        return results;
    }

    /** ガチャのコスト(10連)を計算 */
    getTenPullCost(gameState: GameState): number {
        return gameState.gachaCost * 10;
    }

    /** 通常のレアリティ抽選 */
    private rollRarity(): Rarity {
        const roll = Math.random() * 100;
        let cumulative = 0;
        for (const entry of NORMAL_GACHA_TABLE) {
            cumulative += entry.probability;
            if (roll < cumulative) {
                return entry.rarity;
            }
        }
        return 1; // フォールバック
    }

    /** 天井時のレアリティ抽選（★4: 80%, ★5: 20%） */
    private rollPityRarity(): Rarity {
        return Math.random() < 0.8 ? 4 : 5;
    }

    /** 現在の天井までの残り回数 */
    get pitiesUntilGuarantee(): number {
        return Math.max(0, PITY_COUNT - this.pitySinceLastRare);
    }

    /** 確率テーブルを返す（UI表示用） */
    getProbabilityTable(): GachaProbability[] {
        return [...NORMAL_GACHA_TABLE];
    }
}
