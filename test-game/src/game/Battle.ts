// Battle.ts — バトルロジック
export interface BattleResult {
    won: boolean;
    enemyName: string;
    enemySoldiers: number;
    goldReward: number;
    soldiersLost: number;
}

const ENEMY_NAMES = [
    'ゴブリンの巣', 'オークの砦', 'ドラゴンの洞窟', 'スケルトン城',
    '暗黒騎士団', 'エルフの森', 'ドワーフの鉱山', '魔女の塔',
    '盗賊団アジト', '氷の王国',
];

export function executeBattle(soldiers: number): BattleResult {
    const enemyName = ENEMY_NAMES[Math.floor(Math.random() * ENEMY_NAMES.length)];
    const enemySoldiers = Math.floor(soldiers * (0.5 + Math.random()));

    const ratio = soldiers / (soldiers + enemySoldiers);
    const won = Math.random() < ratio;

    if (won) {
        const soldiersLost = Math.floor(enemySoldiers * 0.3 * Math.random());
        const goldReward = Math.floor(50 + enemySoldiers * 5 * Math.random());
        return { won: true, enemyName, enemySoldiers, goldReward, soldiersLost };
    } else {
        const soldiersLost = Math.floor(soldiers * 0.2 + Math.random() * soldiers * 0.3);
        return { won: false, enemyName, enemySoldiers, goldReward: 0, soldiersLost };
    }
}
