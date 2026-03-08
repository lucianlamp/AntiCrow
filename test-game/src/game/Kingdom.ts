// Kingdom.ts — 王国の状態管理
import { Building } from './Building';

const SAVE_KEY = 'pixel_kingdoms_save';

export class Kingdom {
    gold: number = 100;
    food: number = 50;
    soldiers: number = 10;
    maxStorage: number = 500;
    buildings: Building[];
    private lastUpdate: number = Date.now();

    constructor() {
        this.buildings = [
            new Building('castle', 60, 120),
            new Building('farm', 260, 120),
            new Building('barracks', 460, 120),
            new Building('warehouse', 160, 320),
        ];
    }

    update(now: number): void {
        const deltaSeconds = (now - this.lastUpdate) / 1000;
        this.lastUpdate = now;

        for (const b of this.buildings) {
            switch (b.config.resource) {
                case 'gold':
                    this.gold += b.production * deltaSeconds;
                    break;
                case 'food':
                    this.food += b.production * deltaSeconds;
                    break;
                case 'soldiers':
                    if (this.food >= b.production * deltaSeconds) {
                        this.soldiers += b.production * deltaSeconds;
                        this.food -= b.production * deltaSeconds * 0.5;
                    }
                    break;
                case 'storage':
                    this.maxStorage = 500 + b.level * 200;
                    break;
            }
        }

        // ストレージ上限クランプ
        this.gold = Math.min(this.gold, this.maxStorage);
        this.food = Math.min(this.food, this.maxStorage);
        this.soldiers = Math.min(this.soldiers, this.maxStorage);

        // 負の値防止
        this.gold = Math.max(0, this.gold);
        this.food = Math.max(0, this.food);
        this.soldiers = Math.max(0, this.soldiers);
    }

    get score(): number {
        return Math.floor(this.gold + this.soldiers * 10);
    }

    upgradeBuilding(building: Building): boolean {
        if (this.gold >= building.upgradeCost) {
            this.gold -= building.upgradeCost;
            building.upgrade();
            return true;
        }
        return false;
    }

    save(): void {
        const data = {
            gold: this.gold,
            food: this.food,
            soldiers: this.soldiers,
            buildings: this.buildings.map(b => b.toJSON()),
            timestamp: Date.now(),
        };
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    }

    load(): boolean {
        const raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return false;
        try {
            const data = JSON.parse(raw);
            this.gold = data.gold ?? 100;
            this.food = data.food ?? 50;
            this.soldiers = data.soldiers ?? 10;
            if (data.buildings) {
                this.buildings = data.buildings.map(Building.fromJSON);
            }
            // 離脱中の資源蓄積（放置ボーナス）
            if (data.timestamp) {
                const offlineSeconds = (Date.now() - data.timestamp) / 1000;
                const cappedSeconds = Math.min(offlineSeconds, 3600); // 最大1時間
                for (const b of this.buildings) {
                    if (b.config.resource === 'gold') this.gold += b.production * cappedSeconds;
                    if (b.config.resource === 'food') this.food += b.production * cappedSeconds;
                    if (b.config.resource === 'soldiers') this.soldiers += b.production * cappedSeconds * 0.5;
                }
            }
            this.lastUpdate = Date.now();
            return true;
        } catch {
            return false;
        }
    }
}
