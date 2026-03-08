/**
 * ランキングシステムモジュール
 * ローカル保存のモックランキングとダミーデータ生成を管理する
 */

import { GameState } from './GameState';
import { ALL_CHARACTERS } from './Characters';

/** ランキングエントリ */
export interface RankingEntry {
    /** プレイヤー名 */
    name: string;
    /** 累計コイン数 */
    totalCoins: number;
    /** コレクション率（0～1） */
    collectionRate: number;
    /** プレイヤーレベル */
    level: number;
    /** 自分のエントリかどうか */
    isPlayer: boolean;
}

/** ランキングの種類 */
export type RankingType = 'coins' | 'collection';

const RANKING_KEY = 'puni_puni_town_ranking';

/** ダミープレイヤー名のリスト */
const DUMMY_NAMES = [
    'ぷにファン★みかん',
    'ぷにマスターたけし',
    'ぷにコレクターさくら',
    'ぷにラバーゆうき',
    'SuperPuniGamer',
    'ぷにぷに大好きおじさん',
    'ぷにクイーンあおい',
    'まったりぷに太郎',
    'ぷにハンターれん',
    'ぷにぷにの民そら',
    'ぷにキングかずま',
    'ぷにっ子ひなた',
    'ぷにぷに王国の住人',
    'ぷにマニアりく',
    'ぷにぷにガチ勢まお',
    'ぷにっとなでしこ',
    'ぷにぷにパラダイスけい',
    'ぷにチャンピオンゆい',
    'ぷにぷに探検隊はると',
];

/**
 * ランキングシステムクラス
 */
export class RankingSystem {
    private dummyData: RankingEntry[] = [];

    constructor() {
        this.dummyData = this.loadOrGenerateDummies();
    }

    /**
     * ランキングを取得する（上位20位）
     */
    getRanking(gameState: GameState, type: RankingType): RankingEntry[] {
        // プレイヤーのエントリを作成
        const playerEntry: RankingEntry = {
            name: 'あなた',
            totalCoins: gameState.totalCoins,
            collectionRate: gameState.collectionRate,
            level: gameState.level,
            isPlayer: true,
        };

        // ダミーデータとマージ
        const allEntries = [...this.dummyData, playerEntry];

        // ソート
        if (type === 'coins') {
            allEntries.sort((a, b) => b.totalCoins - a.totalCoins);
        } else {
            allEntries.sort((a, b) => b.collectionRate - a.collectionRate);
        }

        // 上位20件を返す
        return allEntries.slice(0, 20);
    }

    /**
     * プレイヤーの順位を取得する
     */
    getPlayerRank(gameState: GameState, type: RankingType): number {
        const ranking = this.getRanking(gameState, type);
        const index = ranking.findIndex(e => e.isPlayer);
        return index >= 0 ? index + 1 : ranking.length + 1;
    }

    /**
     * ダミーデータを時間経過で少し成長させる（リアリティ向上用）
     */
    progressDummies(): void {
        for (const dummy of this.dummyData) {
            // ランダムに少しコインを増やす
            const growth = Math.floor(Math.random() * 50);
            dummy.totalCoins += growth;
            // ごく稀にレベルアップ
            if (Math.random() < 0.01) {
                dummy.level = Math.min(50, dummy.level + 1);
            }
        }
        this.saveDummies();
    }

    /** ダミーデータを読み込む、なければ生成する */
    private loadOrGenerateDummies(): RankingEntry[] {
        try {
            const raw = localStorage.getItem(RANKING_KEY);
            if (raw) {
                return JSON.parse(raw) as RankingEntry[];
            }
        } catch {
            // 無視
        }
        const dummies = this.generateDummies();
        this.saveDummies(dummies);
        return dummies;
    }

    /** ダミーデータを生成する */
    private generateDummies(): RankingEntry[] {
        return DUMMY_NAMES.map(name => {
            const level = Math.floor(Math.random() * 15) + 1;
            const totalCoins = Math.floor(Math.random() * 10000 * level);
            // コレクション率はレベルに比例（低レベルは少なめ）
            const maxCollection = Math.min(1, level / 20 + Math.random() * 0.3);
            const collectionRate = Math.floor(maxCollection * ALL_CHARACTERS.length) / ALL_CHARACTERS.length;

            return {
                name,
                totalCoins,
                collectionRate,
                level,
                isPlayer: false,
            };
        });
    }

    /** ダミーデータをLocalStorageに保存する */
    private saveDummies(data?: RankingEntry[]): void {
        try {
            localStorage.setItem(RANKING_KEY, JSON.stringify(data || this.dummyData));
        } catch {
            // 無視
        }
    }

    /** ランキングデータをリセットする */
    reset(): void {
        localStorage.removeItem(RANKING_KEY);
        this.dummyData = this.generateDummies();
        this.saveDummies();
    }
}
