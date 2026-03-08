// ぷにぷにタウン — HTML/CSS UI管理
// タブ切り替え、ヘッダー更新、ボタン、モーダル

export type TabName = 'town' | 'gacha' | 'collection' | 'ranking';

export interface UICallbacks {
  onTabChange?: (tab: TabName) => void;
  onGachaPull?: () => void;
  onUpgrade?: (type: string) => void;
  onTap?: (x: number, y: number) => void;
}

// キャラ情報（表示用）
export interface UICharInfo {
  id: string;
  name: string;
  rarity: number;
  color: string;
  shape: string;
  owned: boolean;
  count: number;
}

// ランキング情報
export interface RankingEntry {
  rank: number;
  name: string;
  score: number;
  isPlayer: boolean;
}

// アップグレード情報
export interface UpgradeInfo {
  type: string;
  name: string;
  description: string;
  cost: number;
  level: number;
}

export class UIManager {
  private callbacks: UICallbacks = {};
  private currentTab: TabName = 'town';
  private coinEl: HTMLElement;
  private levelEl: HTMLElement;
  private overlay: HTMLElement;
  private innerContent: HTMLElement;
  private modalOverlay: HTMLElement;
  private modalBody: HTMLElement;

  constructor() {
    this.coinEl = document.getElementById('coin-count')!;
    this.levelEl = document.getElementById('level-count')!;
    this.overlay = document.getElementById('tab-content-overlay')!;
    this.innerContent = document.getElementById('tab-content-inner')!;
    this.modalOverlay = document.getElementById('modal-overlay')!;
    this.modalBody = document.getElementById('modal-body')!;

    this.setupTabs();
    this.setupModal();
  }

  setCallbacks(cb: UICallbacks): void {
    this.callbacks = cb;
  }

  // ヘッダー更新
  updateCoinDisplay(coins: number): void {
    this.coinEl.textContent = this.formatNumber(coins);
  }

  updateLevelDisplay(level: number): void {
    this.levelEl.textContent = String(level);
  }

  getCurrentTab(): TabName {
    return this.currentTab;
  }

  // タブ設定
  private setupTabs(): void {
    const btns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab as TabName;
        if (tab === this.currentTab && tab === 'town') {
          // 街タブをもう一度押したらキャンバスに戻る
          this.overlay.classList.add('hidden');
          return;
        }
        this.switchTab(tab);
      });
    });
  }

  switchTab(tab: TabName): void {
    this.currentTab = tab;
    // ボタンのactive切り替え
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab);
    });

    if (tab === 'town') {
      this.overlay.classList.add('hidden');
    } else {
      this.overlay.classList.remove('hidden');
    }

    this.callbacks.onTabChange?.(tab);
  }

  // ガチャ画面を表示
  renderGachaTab(coins: number, gachaCost: number): void {
    this.innerContent.innerHTML = `
      <div class="gacha-section">
        <div class="section-title">🎰 ガチャ</div>
        <div class="section-subtitle">ぷにコインでキャラを召喚しよう！</div>
        <div style="margin: 20px 0;">
          <button class="puni-btn puni-btn-gacha" id="gacha-pull-btn" ${coins < gachaCost ? 'disabled style="opacity:0.5;cursor:not-allowed"' : ''}>
            🎲 ガチャを回す！
          </button>
        </div>
        <div class="gacha-cost">💰 ${this.formatNumber(gachaCost)} ぷにコイン</div>
        <div style="margin-top:16px;padding:12px;background:var(--card-bg);border-radius:var(--border-radius);box-shadow:var(--card-shadow);width:100%">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px;text-align:center">📊 排出確率</div>
          <div style="display:flex;flex-direction:column;gap:4px;font-size:13px">
            <div style="display:flex;justify-content:space-between"><span>★1</span><span>40%</span></div>
            <div style="display:flex;justify-content:space-between"><span>★2</span><span>30%</span></div>
            <div style="display:flex;justify-content:space-between"><span>★3</span><span>20%</span></div>
            <div style="display:flex;justify-content:space-between"><span>★4</span><span>8%</span></div>
            <div style="display:flex;justify-content:space-between;color:#FFD700;font-weight:800"><span>★5</span><span>2%</span></div>
          </div>
        </div>
      </div>
    `;
    const pullBtn = document.getElementById('gacha-pull-btn');
    pullBtn?.addEventListener('click', () => {
      this.callbacks.onGachaPull?.();
    });
  }

  // コレクション画面
  renderCollectionTab(chars: UICharInfo[]): void {
    const owned = chars.filter(c => c.owned).length;
    const total = chars.length;
    this.innerContent.innerHTML = `
      <div class="section-title">📖 コレクション</div>
      <div class="section-subtitle">${owned} / ${total} 種類コンプリート</div>
      <div class="collection-grid">
        ${chars.map(c => `
          <div class="collection-item ${c.owned ? '' : 'locked'}">
            <canvas class="char-preview" data-char-id="${c.id}" width="60" height="60"></canvas>
            <div class="char-name">${c.owned ? c.name : '???'}</div>
            <div class="rarity-stars">
              ${Array(5).fill(0).map((_, i) => `<span class="star ${i < c.rarity ? 'filled' : 'empty'}">★</span>`).join('')}
            </div>
            ${c.owned ? `<div style="font-size:11px;color:var(--text-secondary)">×${c.count}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // ランキング画面
  renderRankingTab(entries: RankingEntry[]): void {
    this.innerContent.innerHTML = `
      <div class="section-title">🏆 ランキング</div>
      <div class="section-subtitle">総ぷにコイン獲得数</div>
      <div class="ranking-list">
        ${entries.map(e => {
      const rankClass = e.rank === 1 ? 'gold' : e.rank === 2 ? 'silver' : e.rank === 3 ? 'bronze' : '';
      const medal = e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : '';
      return `
            <div class="ranking-item" style="${e.isPlayer ? 'border:2px solid var(--pink-dark);background:rgba(255,182,193,0.15)' : ''}">
              <div class="ranking-rank ${rankClass}">${medal || e.rank}</div>
              <div class="ranking-name">${e.name}${e.isPlayer ? ' 👈' : ''}</div>
              <div class="ranking-score">🪙 ${this.formatNumber(e.score)}</div>
            </div>
          `;
    }).join('')}
      </div>
    `;
  }

  // 街タブ情報（オーバーレイではなくCanvas上に描画するので統計のみ）
  renderTownOverlay(stats: { totalIncome: number; buildingCount: number; charCount: number }, upgrades: UpgradeInfo[]): void {
    this.innerContent.innerHTML = `
      <div class="section-title">🏘️ 街の情報</div>
      <div class="town-info">
        <div class="town-stat">
          <span class="town-stat-label">自動収入 / 秒</span>
          <span class="town-stat-value">🪙 ${this.formatNumber(stats.totalIncome)}</span>
        </div>
        <div class="town-stat">
          <span class="town-stat-label">建物数</span>
          <span class="town-stat-value">🏠 ${stats.buildingCount}</span>
        </div>
        <div class="town-stat">
          <span class="town-stat-label">配置キャラ数</span>
          <span class="town-stat-value">🐾 ${stats.charCount}</span>
        </div>
      </div>
      <div class="section-title" style="margin-top:16px">⬆️ アップグレード</div>
      <div class="upgrade-section">
        ${upgrades.map(u => `
          <div class="upgrade-item">
            <div class="upgrade-info">
              <div class="upgrade-name">${u.name} (Lv.${u.level})</div>
              <div class="upgrade-desc">${u.description}</div>
              <div class="upgrade-cost">💰 ${this.formatNumber(u.cost)}</div>
            </div>
            <button class="puni-btn puni-btn-primary" data-upgrade="${u.type}" style="padding:8px 16px;font-size:13px">強化</button>
          </div>
        `).join('')}
      </div>
    `;

    // アップグレードボタンのイベント
    this.innerContent.querySelectorAll<HTMLButtonElement>('[data-upgrade]').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.upgrade!;
        this.callbacks.onUpgrade?.(type);
      });
    });
  }

  // モーダル
  private setupModal(): void {
    document.getElementById('modal-close')?.addEventListener('click', () => this.hideModal());
    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) this.hideModal();
    });
  }

  showModal(html: string): void {
    this.modalBody.innerHTML = html;
    this.modalOverlay.classList.remove('hidden');
  }

  hideModal(): void {
    this.modalOverlay.classList.add('hidden');
  }

  // 新キャラ獲得モーダル
  showNewCharacterModal(name: string, rarity: number): void {
    this.showModal(`
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:24px;margin-bottom:8px">🎉</div>
        <div style="font-weight:800;font-size:20px;color:var(--text-primary);margin-bottom:4px">NEW!</div>
        <div style="font-weight:700;font-size:18px;margin-bottom:8px">${name}</div>
        <div class="rarity-stars" style="justify-content:center">
          ${Array(5).fill(0).map((_, i) => `<span class="star ${i < rarity ? 'filled' : 'empty'}" style="font-size:24px">★</span>`).join('')}
        </div>
        <div style="margin-top:16px">
          <button class="puni-btn puni-btn-primary" onclick="document.getElementById('modal-overlay').classList.add('hidden')">やったー！</button>
        </div>
      </div>
    `);
  }

  // 数値フォーマット
  private formatNumber(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return Math.floor(n).toLocaleString();
  }
}
