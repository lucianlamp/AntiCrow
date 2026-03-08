// Ranking.ts — 擬似ランキング
export interface RankEntry {
    name: string;
    score: number;
    isPlayer: boolean;
}

const NPC_NAMES = [
    'DragonLord', 'ShadowKing', 'IronFist', 'StormRider',
    'GoldMiner', 'BladeMaster', 'FrostQueen', 'FireWizard',
    'DarkKnight', 'SkyHunter', 'ThunderBolt', 'MoonWalker',
];

export function getRankings(playerScore: number): RankEntry[] {
    const entries: RankEntry[] = [];

    // NPC ランキング（プレイヤースコアに応じてスケール）
    const baseScore = Math.max(100, playerScore * 0.5);
    for (let i = 0; i < 9; i++) {
        entries.push({
            name: NPC_NAMES[i % NPC_NAMES.length],
            score: Math.floor(baseScore + Math.random() * playerScore * 1.5),
            isPlayer: false,
        });
    }

    // プレイヤー追加
    entries.push({ name: '👑 あなた', score: playerScore, isPlayer: true });

    // スコア降順ソート
    entries.sort((a, b) => b.score - a.score);

    return entries.slice(0, 10);
}
