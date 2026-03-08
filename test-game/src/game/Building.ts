// Building.ts — 建物クラス
export type BuildingType = 'castle' | 'farm' | 'barracks' | 'warehouse';

export interface BuildingConfig {
    type: BuildingType;
    name: string;
    baseCost: number;
    baseProduction: number;
    resource: 'gold' | 'food' | 'soldiers' | 'storage';
    color: string;
    accentColor: string;
}

export const BUILDING_CONFIGS: Record<BuildingType, BuildingConfig> = {
    castle: {
        type: 'castle', name: '城', baseCost: 100, baseProduction: 5,
        resource: 'gold', color: '#5a4a3a', accentColor: '#ffd700',
    },
    farm: {
        type: 'farm', name: '農場', baseCost: 50, baseProduction: 3,
        resource: 'food', color: '#3a5a2a', accentColor: '#88cc44',
    },
    barracks: {
        type: 'barracks', name: '兵舎', baseCost: 80, baseProduction: 2,
        resource: 'soldiers', color: '#5a2a2a', accentColor: '#cc4444',
    },
    warehouse: {
        type: 'warehouse', name: '倉庫', baseCost: 60, baseProduction: 0,
        resource: 'storage', color: '#3a3a5a', accentColor: '#6688cc',
    },
};

export class Building {
    type: BuildingType;
    level: number;
    x: number;
    y: number;
    width: number = 160;
    height: number = 160;

    constructor(type: BuildingType, x: number, y: number, level: number = 1) {
        this.type = type;
        this.level = level;
        this.x = x;
        this.y = y;
    }

    get config(): BuildingConfig {
        return BUILDING_CONFIGS[this.type];
    }

    get upgradeCost(): number {
        return Math.floor(this.config.baseCost * Math.pow(1.5, this.level));
    }

    get production(): number {
        return this.config.baseProduction * this.level;
    }

    isClicked(mx: number, my: number): boolean {
        return mx >= this.x && mx <= this.x + this.width &&
            my >= this.y && my <= this.y + this.height;
    }

    upgrade(): void {
        this.level++;
    }

    toJSON() {
        return { type: this.type, level: this.level, x: this.x, y: this.y };
    }

    static fromJSON(data: { type: BuildingType; level: number; x: number; y: number }): Building {
        return new Building(data.type, data.x, data.y, data.level);
    }
}
