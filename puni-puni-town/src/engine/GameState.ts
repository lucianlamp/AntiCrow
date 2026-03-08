/**
 * ゲーム状態管理モジュール
 * コイン、レベル、所持キャラ、建物、アップグレードの状態を管理し、
 * LocalStorageへの保存/読み込みを行う
 */

import { ALL_CHARACTERS, getCharacterById, type CharacterDef } from './Characters';

/** 所持キャラクターの情報 */
export interface OwnedCharacter {
    /** キャラクターID */
    characterId: string;
    /** 入手日時（Unix ms） */
    obtainedAt: number;
    /** 街に配置されているかどうか */
    placedInTown: boolean;
}

/** 建物の情報 */
export interface Building {
    /** 建物の種類 */
    type: 'house' | 'shop' | 'park' | 'tower' | 'castle';
    /** X座標（グリッド） */
    gridX: number;
    /** Y座標（グリッド） */
    gridY: number;
    /** 配置されているキャラクターID（null=空き） */
    characterId: string | null;
    /** 建物レベル */
    level: number;
}

/** アップグレード情報 */
export interface Upgrades {
    /** タップ1回あたりの収益倍率 */
    tapMultiplier: number;
    /** 自動収益倍率 */
    incomeMultiplier: number;
    /** ガチャ割引率（0～1、0=割引なし、0.5=半額） */
    gachaDiscount: number;
    /** 各アップグレードの購入回数 */
    tapLevel: number;
    incomeLevel: number;
    gachaLevel: number;
}

/** セーブデータの全体構造 */
export interface SaveData {
    /** ぷにコイン（現在の所持数） */
    coins: number;
    /** 累計獲得コイン数（ランキング用） */
    totalCoins: number;
    /** プレイヤーレベル */
    level: number;
    /** 経験値（レベルアップ用） */
    exp: number;
    /** 所持キャラクター一覧 */
    ownedCharacters: OwnedCharacter[];
    /** 街の建物一覧 */
    buildings: Building[];
    /** アップグレード情報 */
    upgrades: Upgrades;
    /** ガチャを回した回数 */
    gachaCount: number;
    /** 最後にセーブした時刻（Unix ms） */
    lastSaveTime: number;
    /** 最後にオフライン収益を計算した時刻（Unix ms） */
    lastIncomeTime: number;
    /** セーブデータのバージョン */
    version: number;
}

const SAVE_KEY = 'puni_puni_town_save';
const SAVE_VERSION = 1;

/** レベルアップに必要な経験値を返す */
export function getExpForLevel(level: number): number {
    return Math.floor(100 * Math.pow(1.5, level - 1));
}

/** ガチャ1回の基本コスト */
export const BASE_GACHA_COST = 100;

/** アップグレードコスト計算 */
export function getUpgradeCost(type: 'tap' | 'income' | 'gacha', currentLevel: number): number {
    const baseCosts = { tap: 50, income: 200, gacha: 500 };
    return Math.floor(baseCosts[type] * Math.pow(2, currentLevel));
}

/** 街の建物の初期配置を生成する */
function createDefaultBuildings(): Building[] {
    const types: Building['type'][] = ['house', 'shop', 'park', 'tower', 'castle'];
    const buildings: Building[] = [];
    // 3x3 グリッドに5つの建物を配置
    const positions = [
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 },
    ];
    for (let i = 0; i < positions.length; i++) {
        buildings.push({
            type: types[i],
            gridX: positions[i].x,
            gridY: positions[i].y,
            characterId: null,
            level: 1,
        });
    }
    return buildings;
}

/** デフォルトのセーブデータを生成 */
function createDefaultSaveData(): SaveData {
    return {
        coins: 0,
        totalCoins: 0,
        level: 1,
        exp: 0,
        ownedCharacters: [],
        buildings: createDefaultBuildings(),
        upgrades: {
            tapMultiplier: 1,
            incomeMultiplier: 1,
            gachaDiscount: 0,
            tapLevel: 0,
            incomeLevel: 0,
            gachaLevel: 0,
        },
        gachaCount: 0,
        lastSaveTime: Date.now(),
        lastIncomeTime: Date.now(),
        version: SAVE_VERSION,
    };
}

/**
 * ゲーム状態管理クラス
 */
export class GameState {
    private data: SaveData;
    private listeners: Set<() => void> = new Set();

    constructor() {
        this.data = this.load();
        // オフライン収益を計算
        this.calculateOfflineIncome();
    }

    /** 状態変更リスナーを登録 */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** リスナーに通知 */
    private notify(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }

    // ========== ゲッター ==========

    get coins(): number { return this.data.coins; }
    get totalCoins(): number { return this.data.totalCoins; }
    get level(): number { return this.data.level; }
    get exp(): number { return this.data.exp; }
    get ownedCharacters(): OwnedCharacter[] { return [...this.data.ownedCharacters]; }
    get buildings(): Building[] { return [...this.data.buildings]; }
    get upgrades(): Upgrades { return { ...this.data.upgrades }; }
    get gachaCount(): number { return this.data.gachaCount; }

    /** コレクション率を返す（0～1） */
    get collectionRate(): number {
        const uniqueIds = new Set(this.data.ownedCharacters.map(c => c.characterId));
        return uniqueIds.size / ALL_CHARACTERS.length;
    }

    /** ユニークなキャラクター数 */
    get uniqueCharacterCount(): number {
        return new Set(this.data.ownedCharacters.map(c => c.characterId)).size;
    }

    /** 現在のタップ1回の収益 */
    get tapIncome(): number {
        return Math.floor(1 * this.data.upgrades.tapMultiplier);
    }

    /** 現在のガチャコスト */
    get gachaCost(): number {
        const discount = 1 - this.data.upgrades.gachaDiscount;
        return Math.floor(BASE_GACHA_COST * discount);
    }

    /** 1秒あたりの自動収益合計 */
    get totalIncomePerSec(): number {
        let total = 0;
        for (const owned of this.data.ownedCharacters) {
            if (owned.placedInTown) {
                const def = getCharacterById(owned.characterId);
                if (def) {
                    total += def.incomePerSec * this.data.upgrades.incomeMultiplier;
                }
            }
        }
        return Math.floor(total);
    }

    /** レベルアップに必要な経験値 */
    get expToNextLevel(): number {
        return getExpForLevel(this.data.level);
    }

    // ========== アクション ==========

    /** タップでコインを獲得する */
    tap(): number {
        const earned = this.tapIncome;
        this.data.coins += earned;
        this.data.totalCoins += earned;
        this.addExp(1);
        this.notify();
        return earned;
    }

    /** 自動収益を時間経過分だけ加算する（毎フレーム呼び出し） */
    addAutoIncome(deltaSec: number): number {
        const earned = Math.floor(this.totalIncomePerSec * deltaSec);
        if (earned > 0) {
            this.data.coins += earned;
            this.data.totalCoins += earned;
            this.data.lastIncomeTime = Date.now();
            this.notify();
        }
        return earned;
    }

    /** コインを消費する（足りない場合はfalse） */
    spendCoins(amount: number): boolean {
        if (this.data.coins < amount) return false;
        this.data.coins -= amount;
        this.notify();
        return true;
    }

    /** 経験値を加算し、レベルアップを処理 */
    private addExp(amount: number): void {
        this.data.exp += amount;
        while (this.data.exp >= this.expToNextLevel) {
            this.data.exp -= this.expToNextLevel;
            this.data.level++;
        }
    }

    /** キャラクターを追加する */
    addCharacter(characterId: string): void {
        this.data.ownedCharacters.push({
            characterId,
            obtainedAt: Date.now(),
            placedInTown: false,
        });
        this.data.gachaCount++;
        this.addExp(10);
        this.notify();
    }

    /** キャラクターを街に配置する */
    placeCharacterInTown(ownedIndex: number, buildingIndex: number): boolean {
        if (ownedIndex < 0 || ownedIndex >= this.data.ownedCharacters.length) return false;
        if (buildingIndex < 0 || buildingIndex >= this.data.buildings.length) return false;

        const character = this.data.ownedCharacters[ownedIndex];
        const building = this.data.buildings[buildingIndex];

        // 既に別の建物にいる場合はまず解除
        if (character.placedInTown) {
            for (const b of this.data.buildings) {
                if (b.characterId === character.characterId) {
                    b.characterId = null;
                }
            }
        }

        // 建物に既にキャラがいる場合は入れ替え
        if (building.characterId) {
            const prev = this.data.ownedCharacters.find(
                c => c.characterId === building.characterId && c.placedInTown
            );
            if (prev) prev.placedInTown = false;
        }

        building.characterId = character.characterId;
        character.placedInTown = true;
        this.notify();
        return true;
    }

    /** アップグレードを購入する */
    purchaseUpgrade(type: 'tap' | 'income' | 'gacha'): boolean {
        const level = type === 'tap' ? this.data.upgrades.tapLevel
            : type === 'income' ? this.data.upgrades.incomeLevel
                : this.data.upgrades.gachaLevel;

        const cost = getUpgradeCost(type, level);
        if (!this.spendCoins(cost)) return false;

        switch (type) {
            case 'tap':
                this.data.upgrades.tapLevel++;
                this.data.upgrades.tapMultiplier = 1 + this.data.upgrades.tapLevel * 0.5;
                break;
            case 'income':
                this.data.upgrades.incomeLevel++;
                this.data.upgrades.incomeMultiplier = 1 + this.data.upgrades.incomeLevel * 0.3;
                break;
            case 'gacha':
                this.data.upgrades.gachaLevel++;
                this.data.upgrades.gachaDiscount = Math.min(0.5, this.data.upgrades.gachaLevel * 0.05);
                break;
        }

        this.addExp(5);
        this.notify();
        return true;
    }

    /** オフライン収益を計算して加算する */
    private calculateOfflineIncome(): void {
        const now = Date.now();
        const elapsed = (now - this.data.lastIncomeTime) / 1000;
        // 最大12時間分までオフライン収益を付与
        const maxOfflineSec = 12 * 60 * 60;
        const sec = Math.min(elapsed, maxOfflineSec);
        if (sec > 10 && this.totalIncomePerSec > 0) {
            const earned = Math.floor(this.totalIncomePerSec * sec);
            this.data.coins += earned;
            this.data.totalCoins += earned;
        }
        this.data.lastIncomeTime = now;
    }

    /** コインを直接追加する（デバッグ・ボーナス用） */
    addCoins(amount: number): void {
        this.data.coins += amount;
        this.data.totalCoins += amount;
        this.notify();
    }

    // ========== セーブ/ロード ==========

    /** LocalStorageにセーブする */
    save(): void {
        this.data.lastSaveTime = Date.now();
        try {
            localStorage.setItem(SAVE_KEY, JSON.stringify(this.data));
        } catch (e) {
            console.error('セーブに失敗:', e);
        }
    }

    /** LocalStorageからロードする */
    private load(): SaveData {
        try {
            const raw = localStorage.getItem(SAVE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw) as SaveData;
                if (parsed.version === SAVE_VERSION) {
                    return parsed;
                }
            }
        } catch (e) {
            console.error('ロードに失敗:', e);
        }
        return createDefaultSaveData();
    }

    /** セーブデータをリセットする */
    reset(): void {
        localStorage.removeItem(SAVE_KEY);
        this.data = createDefaultSaveData();
        this.notify();
    }

    /** 所持キャラ情報とキャラ定義を結合して返す */
    getOwnedCharacterDefs(): (OwnedCharacter & { def: CharacterDef })[] {
        return this.data.ownedCharacters
            .map(owned => {
                const def = getCharacterById(owned.characterId);
                return def ? { ...owned, def } : null;
            })
            .filter((v): v is OwnedCharacter & { def: CharacterDef } => v !== null);
    }
}
