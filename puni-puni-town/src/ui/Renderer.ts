// ぷにぷにタウン — Canvas2D 描画エンジン
// キャラクター描画、パーティクル、タップアニメーション、街の建物描画

// キャラ定義の型（engine/Characters.ts と合わせる）
export interface CharacterDef {
  id: string;
  name: string;
  rarity: number;
  color: string;
  shape: string;
  autoIncome: number;
}

// パーティクル
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  type: 'coin' | 'sparkle' | 'star';
  rotation: number;
  rotationSpeed: number;
}

// アニメーション中のキャラ情報
interface CharAnim {
  x: number;
  y: number;
  scale: number;
  targetScale: number;
  bouncePhase: number;
  char: CharacterDef;
}

// 街の建物
interface Building {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  wigglePhase: number;
  type: number;
}

// ガチャ演出
interface GachaAnim {
  phase: 'drop' | 'open' | 'reveal' | 'done';
  timer: number;
  capsuleY: number;
  openScale: number;
  char: CharacterDef | null;
  sparkles: Particle[];
}

// カラーパレット
const COLORS = {
  bg: '#FFF0F5',
  ground: '#E8F5E1',
  sky: ['#FFF0F5', '#F0E6FF', '#E6F0FF'],
  cloud: 'rgba(255,255,255,0.7)',
};

// キャラの色マッピング
const CHAR_COLORS: Record<string, { body: string; cheek: string; accent: string }> = {
  '赤':   { body: '#FF6B6B', cheek: '#FF9999', accent: '#CC4444' },
  '青':   { body: '#6BB5E0', cheek: '#99D4F0', accent: '#4488BB' },
  'ピンク': { body: '#FF89A2', cheek: '#FFB6C8', accent: '#CC6680' },
  '緑':   { body: '#6CDCBA', cheek: '#99F0D8', accent: '#44AA88' },
  '茶':   { body: '#C4956A', cheek: '#DAB894', accent: '#8B6B44' },
  '黄':   { body: '#FFE66D', cheek: '#FFF3B0', accent: '#CCAA44' },
  '紫':   { body: '#B88AE5', cheek: '#D8B5FF', accent: '#8855BB' },
  '虹色':  { body: '#FF89A2', cheek: '#FFE66D', accent: '#B88AE5' },
};

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private charAnims: CharAnim[] = [];
  private buildings: Building[] = [];
  private gachaAnim: GachaAnim | null = null;
  private tapEffect: { x: number; y: number; timer: number } | null = null;
  private time = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;

  // 中央のメインキャラ（タップ対象）
  private mainChar: CharacterDef | null = null;
  private mainCharBounce = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D not supported');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setMainCharacter(char: CharacterDef): void {
    this.mainChar = char;
  }

  // 街のキャラ配置を更新
  updateTownCharacters(chars: CharacterDef[]): void {
    this.charAnims = chars.map((c, i) => ({
      x: 40 + (i % 5) * 80,
      y: this.h * 0.55 + Math.floor(i / 5) * 70,
      scale: 1,
      targetScale: 1,
      bouncePhase: Math.random() * Math.PI * 2,
      char: c,
    }));
  }

  // 街の建物を生成
  generateBuildings(count: number): void {
    this.buildings = [];
    const colors = ['#FFB6C1', '#B0E0E6', '#D8B5FF', '#98F5E1', '#FFE66D', '#FFD4A3'];
    for (let i = 0; i < count; i++) {
      this.buildings.push({
        x: 20 + (i % 4) * (this.w / 4 - 10),
        y: this.h * 0.35 + Math.floor(i / 4) * 50,
        width: 50 + Math.random() * 30,
        height: 40 + Math.random() * 40,
        color: colors[i % colors.length],
        wigglePhase: Math.random() * Math.PI * 2,
        type: i % 3,
      });
    }
  }

  // タップエフェクト発生
  triggerTap(x: number, y: number): void {
    this.tapEffect = { x, y, timer: 1 };
    this.mainCharBounce = 1;
    // コインパーティクル
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8 + (Math.random() - 0.5) * 0.5;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * (2 + Math.random() * 3),
        vy: Math.sin(angle) * (2 + Math.random() * 3) - 3,
        life: 1, maxLife: 1,
        size: 8 + Math.random() * 6,
        color: '#FFE66D',
        type: 'coin',
        rotation: 0,
        rotationSpeed: (Math.random() - 0.5) * 0.3,
      });
    }
  }

  // ガチャ演出開始
  startGachaAnimation(char: CharacterDef): void {
    this.gachaAnim = {
      phase: 'drop',
      timer: 0,
      capsuleY: -60,
      openScale: 0,
      char,
      sparkles: [],
    };
  }

  // キラキラエフェクト
  spawnSparkles(x: number, y: number, count: number = 12): void {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count;
      const speed = 1 + Math.random() * 2;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1, maxLife: 1,
        size: 4 + Math.random() * 4,
        color: ['#FFD700', '#FF6B8A', '#B88AE5', '#6CDCBA'][Math.floor(Math.random() * 4)],
        type: 'sparkle',
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.2,
      });
    }
  }

  // メインの描画ループ
  render(dt: number): void {
    this.time += dt;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    // 背景
    this.drawBackground(ctx);
    // 建物
    this.drawBuildings(ctx);
    // 街のキャラ
    this.drawTownCharacters(ctx);
    // メインキャラ（タップゾーン）
    this.drawMainCharacter(ctx);
    // パーティクル
    this.updateAndDrawParticles(ctx, dt);
    // タップエフェクト
    this.drawTapEffect(ctx, dt);
    // ガチャ演出
    this.drawGachaAnimation(ctx, dt);
  }

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    // グラデーション空
    const grad = ctx.createLinearGradient(0, 0, 0, this.h);
    grad.addColorStop(0, '#E6F0FF');
    grad.addColorStop(0.5, '#FFF0F5');
    grad.addColorStop(1, '#E8F5E1');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.w, this.h);

    // 雲
    ctx.fillStyle = COLORS.cloud;
    const cloudY = 30 + Math.sin(this.time * 0.5) * 5;
    this.drawCloud(ctx, 60 + Math.sin(this.time * 0.2) * 20, cloudY, 40);
    this.drawCloud(ctx, this.w - 80 + Math.cos(this.time * 0.15) * 15, cloudY + 15, 35);
    this.drawCloud(ctx, this.w / 2 + Math.sin(this.time * 0.25) * 25, cloudY - 10, 30);
  }

  private drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.arc(x + r * 0.8, y - r * 0.2, r * 0.7, 0, Math.PI * 2);
    ctx.arc(x - r * 0.6, y + r * 0.1, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawBuildings(ctx: CanvasRenderingContext2D): void {
    for (const b of this.buildings) {
      const wiggle = Math.sin(this.time * 1.5 + b.wigglePhase) * 1.5;
      ctx.save();
      ctx.translate(b.x + b.width / 2, b.y + b.height);
      ctx.rotate((wiggle * Math.PI) / 180);

      // 建物本体
      ctx.fillStyle = b.color;
      const bx = -b.width / 2;
      const by = -b.height;
      this.roundRect(ctx, bx, by, b.width, b.height, 8);
      ctx.fill();

      // 屋根
      ctx.fillStyle = this.darkenColor(b.color, 0.15);
      ctx.beginPath();
      ctx.moveTo(bx - 4, by);
      ctx.lineTo(bx + b.width / 2, by - 15);
      ctx.lineTo(bx + b.width + 4, by);
      ctx.closePath();
      ctx.fill();

      // 窓
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      const winSize = 8;
      const wx = bx + 8;
      const wy = by + 15;
      ctx.fillRect(wx, wy, winSize, winSize);
      ctx.fillRect(wx + winSize + 6, wy, winSize, winSize);

      // ドア
      ctx.fillStyle = this.darkenColor(b.color, 0.25);
      ctx.fillRect(bx + b.width / 2 - 6, -16, 12, 16);

      ctx.restore();
    }
  }

  private drawTownCharacters(ctx: CanvasRenderingContext2D): void {
    for (const ca of this.charAnims) {
      ca.bouncePhase += 0.03;
      const bounce = Math.sin(ca.bouncePhase) * 3;
      this.drawPuniCharacter(ctx, ca.x, ca.y + bounce, 20, ca.char);
    }
  }

  private drawMainCharacter(ctx: CanvasRenderingContext2D): void {
    if (!this.mainChar) return;
    const cx = this.w / 2;
    const cy = this.h * 0.45;
    const baseSize = 50;

    // バウンスアニメーション
    if (this.mainCharBounce > 0) {
      this.mainCharBounce -= 0.04;
      if (this.mainCharBounce < 0) this.mainCharBounce = 0;
    }
    const squash = this.mainCharBounce > 0
      ? 1 + Math.sin(this.mainCharBounce * Math.PI * 3) * 0.15 * this.mainCharBounce
      : 1;
    const stretch = this.mainCharBounce > 0
      ? 1 - Math.sin(this.mainCharBounce * Math.PI * 3) * 0.1 * this.mainCharBounce
      : 1;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(squash, stretch);
    // アイドルぷよぷよ
    const idle = Math.sin(this.time * 2) * 0.03;
    ctx.scale(1 + idle, 1 - idle);

    this.drawPuniCharacter(ctx, 0, 0, baseSize, this.mainChar);
    ctx.restore();

    // テキスト「タップしてね！」
    ctx.save();
    ctx.globalAlpha = 0.5 + Math.sin(this.time * 3) * 0.2;
    ctx.font = '600 13px Nunito, sans-serif';
    ctx.fillStyle = '#FF6B8A';
    ctx.textAlign = 'center';
    ctx.fillText('👆 タップしてね！', cx, cy + baseSize + 30);
    ctx.restore();
  }

  // ぷにぷにキャラクターをプロシージャル描画
  drawPuniCharacter(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, char: CharacterDef): void {
    const colors = CHAR_COLORS[char.color] || CHAR_COLORS['赤'];

    ctx.save();
    ctx.translate(x, y);

    // 影
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.beginPath();
    ctx.ellipse(0, size * 0.8, size * 0.7, size * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();

    // 体（丸い）
    const bodyGrad = ctx.createRadialGradient(-size * 0.2, -size * 0.2, 0, 0, 0, size);
    bodyGrad.addColorStop(0, this.lightenColor(colors.body, 0.2));
    bodyGrad.addColorStop(1, colors.body);
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fill();

    // 顔パーツ
    this.drawFace(ctx, size, char, colors);

    // 形状ごとの装飾
    this.drawShapeFeature(ctx, size, char, colors);

    // レアリティ光彩（★4以上）
    if (char.rarity >= 4) {
      ctx.strokeStyle = char.rarity === 5
        ? `hsla(${(this.time * 60) % 360}, 80%, 70%, 0.5)`
        : 'rgba(180, 120, 255, 0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, size + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawFace(ctx: CanvasRenderingContext2D, size: number, _char: CharacterDef, colors: { cheek: string }): void {
    const eyeY = -size * 0.15;
    const eyeX = size * 0.3;
    const eyeSize = size * 0.12;

    // 目
    ctx.fillStyle = '#333';
    ctx.beginPath();
    ctx.arc(-eyeX, eyeY, eyeSize, 0, Math.PI * 2);
    ctx.arc(eyeX, eyeY, eyeSize, 0, Math.PI * 2);
    ctx.fill();

    // ハイライト
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(-eyeX + eyeSize * 0.3, eyeY - eyeSize * 0.3, eyeSize * 0.4, 0, Math.PI * 2);
    ctx.arc(eyeX + eyeSize * 0.3, eyeY - eyeSize * 0.3, eyeSize * 0.4, 0, Math.PI * 2);
    ctx.fill();

    // 口（にっこり）
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, size * 0.1, size * 0.2, 0.1, Math.PI - 0.1);
    ctx.stroke();

    // ほっぺ
    ctx.fillStyle = colors.cheek;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(-eyeX - size * 0.05, eyeY + size * 0.2, size * 0.12, size * 0.08, 0, 0, Math.PI * 2);
    ctx.ellipse(eyeX + size * 0.05, eyeY + size * 0.2, size * 0.12, size * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawShapeFeature(ctx: CanvasRenderingContext2D, size: number, char: CharacterDef, colors: { accent: string; body: string }): void {
    switch (char.shape) {
      case '犬型':
        // 垂れ耳
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.ellipse(-size * 0.7, -size * 0.5, size * 0.25, size * 0.4, -0.3, 0, Math.PI * 2);
        ctx.ellipse(size * 0.7, -size * 0.5, size * 0.25, size * 0.4, 0.3, 0, Math.PI * 2);
        ctx.fill();
        break;
      case '猫型':
        // 三角耳
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.moveTo(-size * 0.5, -size * 0.85);
        ctx.lineTo(-size * 0.85, -size * 0.3);
        ctx.lineTo(-size * 0.2, -size * 0.6);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(size * 0.5, -size * 0.85);
        ctx.lineTo(size * 0.85, -size * 0.3);
        ctx.lineTo(size * 0.2, -size * 0.6);
        ctx.closePath();
        ctx.fill();
        break;
      case 'うさぎ型':
        // 長い耳
        ctx.fillStyle = colors.body;
        ctx.beginPath();
        ctx.ellipse(-size * 0.3, -size * 1.2, size * 0.15, size * 0.45, -0.1, 0, Math.PI * 2);
        ctx.ellipse(size * 0.3, -size * 1.2, size * 0.15, size * 0.45, 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.ellipse(-size * 0.3, -size * 1.2, size * 0.08, size * 0.3, -0.1, 0, Math.PI * 2);
        ctx.ellipse(size * 0.3, -size * 1.2, size * 0.08, size * 0.3, 0.1, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'かめ型':
        // 甲羅
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.ellipse(0, size * 0.15, size * 0.7, size * 0.5, 0, 0, Math.PI);
        ctx.fill();
        // 甲羅模様
        ctx.strokeStyle = this.lightenColor(colors.accent, 0.2);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-size * 0.2, size * 0.15);
        ctx.lineTo(0, size * 0.55);
        ctx.lineTo(size * 0.2, size * 0.15);
        ctx.stroke();
        break;
      case 'くま型':
        // 丸い耳
        ctx.fillStyle = colors.body;
        ctx.beginPath();
        ctx.arc(-size * 0.65, -size * 0.65, size * 0.3, 0, Math.PI * 2);
        ctx.arc(size * 0.65, -size * 0.65, size * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.arc(-size * 0.65, -size * 0.65, size * 0.15, 0, Math.PI * 2);
        ctx.arc(size * 0.65, -size * 0.65, size * 0.15, 0, Math.PI * 2);
        ctx.fill();
        break;
      case '鳥型':
        // くちばし
        ctx.fillStyle = '#FFA500';
        ctx.beginPath();
        ctx.moveTo(size * 0.05, size * 0.05);
        ctx.lineTo(size * 0.4, size * 0.15);
        ctx.lineTo(size * 0.05, size * 0.25);
        ctx.closePath();
        ctx.fill();
        // 翼
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.ellipse(-size * 0.9, 0, size * 0.35, size * 0.2, -0.3, 0, Math.PI * 2);
        ctx.ellipse(size * 0.9, 0, size * 0.35, size * 0.2, 0.3, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'ドラゴン型':
        // 角
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.moveTo(-size * 0.3, -size * 0.9);
        ctx.lineTo(-size * 0.15, -size * 1.4);
        ctx.lineTo(0, -size * 0.8);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(size * 0.3, -size * 0.9);
        ctx.lineTo(size * 0.15, -size * 1.4);
        ctx.lineTo(0, -size * 0.8);
        ctx.closePath();
        ctx.fill();
        // 小さな翼
        ctx.fillStyle = colors.accent;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(-size * 0.8, -size * 0.2);
        ctx.lineTo(-size * 1.3, -size * 0.5);
        ctx.lineTo(-size * 0.8, size * 0.1);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(size * 0.8, -size * 0.2);
        ctx.lineTo(size * 1.3, -size * 0.5);
        ctx.lineTo(size * 0.8, size * 0.1);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        break;
      case 'ユニコーン型':
        // 角（虹色）
        const hornGrad = ctx.createLinearGradient(0, -size * 1.5, 0, -size * 0.7);
        hornGrad.addColorStop(0, '#FFD700');
        hornGrad.addColorStop(0.5, '#FF89A2');
        hornGrad.addColorStop(1, '#B88AE5');
        ctx.fillStyle = hornGrad;
        ctx.beginPath();
        ctx.moveTo(-size * 0.08, -size * 0.85);
        ctx.lineTo(0, -size * 1.5);
        ctx.lineTo(size * 0.08, -size * 0.85);
        ctx.closePath();
        ctx.fill();
        // たてがみ
        ctx.strokeStyle = `hsla(${(this.time * 40) % 360}, 70%, 70%, 0.6)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-size * 0.4, -size * 0.7);
        ctx.quadraticCurveTo(-size * 0.8, -size * 0.3, -size * 0.5, size * 0.2);
        ctx.stroke();
        break;
    }
  }

  private updateAndDrawParticles(ctx: CanvasRenderingContext2D, dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15; // 重力
      p.life -= dt * 1.5;
      p.rotation += p.rotationSpeed;

      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      const alpha = Math.max(0, p.life / p.maxLife);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);

      if (p.type === 'coin') {
        // コイン
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#DAA520';
        ctx.font = `${p.size * 0.6}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('¢', 0, 0);
      } else if (p.type === 'sparkle') {
        // キラキラ
        ctx.fillStyle = p.color;
        this.drawStar(ctx, 0, 0, p.size, 4);
      } else if (p.type === 'star') {
        ctx.fillStyle = '#FFD700';
        this.drawStar(ctx, 0, 0, p.size, 5);
      }

      ctx.restore();
    }
  }

  private drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, points: number): void {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? size : size * 0.4;
      const angle = (Math.PI * i) / points - Math.PI / 2;
      if (i === 0) ctx.moveTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
      else ctx.lineTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
    }
    ctx.closePath();
    ctx.fill();
  }

  private drawTapEffect(ctx: CanvasRenderingContext2D, dt: number): void {
    if (!this.tapEffect) return;
    this.tapEffect.timer -= dt * 3;
    if (this.tapEffect.timer <= 0) {
      this.tapEffect = null;
      return;
    }
    const t = this.tapEffect;
    const progress = 1 - t.timer;
    const radius = 30 + progress * 40;

    ctx.save();
    ctx.globalAlpha = t.timer * 0.4;
    ctx.strokeStyle = '#FF6B8A';
    ctx.lineWidth = 3 * t.timer;
    ctx.beginPath();
    ctx.arc(t.x, t.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawGachaAnimation(ctx: CanvasRenderingContext2D, dt: number): void {
    if (!this.gachaAnim) return;
    const g = this.gachaAnim;
    g.timer += dt;
    const cx = this.w / 2;
    const cy = this.h / 2;

    switch (g.phase) {
      case 'drop':
        g.capsuleY += 8;
        if (g.capsuleY >= cy - 30) {
          g.phase = 'open';
          g.timer = 0;
        }
        // カプセル
        this.drawCapsule(ctx, cx, g.capsuleY, 30);
        break;
      case 'open':
        g.openScale = Math.min(1, g.timer * 2);
        if (g.timer > 0.8) {
          g.phase = 'reveal';
          g.timer = 0;
          this.spawnSparkles(cx, cy, 20);
        }
        // 開くアニメーション
        ctx.save();
        ctx.translate(cx, cy - 30);
        ctx.scale(1 + g.openScale * 0.3, 1 + g.openScale * 0.3);
        this.drawCapsule(ctx, 0, 0, 30);
        ctx.restore();
        break;
      case 'reveal':
        if (g.char) {
          const revealScale = Math.min(1, g.timer * 1.5);
          ctx.save();
          ctx.translate(cx, cy);
          ctx.scale(revealScale, revealScale);
          this.drawPuniCharacter(ctx, 0, 0, 45, g.char);
          ctx.restore();

          // ★表示
          if (g.char.rarity > 0) {
            ctx.save();
            ctx.font = '700 20px Nunito, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#FFD700';
            ctx.fillText('★'.repeat(g.char.rarity), cx, cy + 65);
            ctx.restore();
          }

          // 名前
          ctx.save();
          ctx.font = '800 16px Nunito, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = '#4A3050';
          ctx.fillText(g.char.name, cx, cy + 85);
          ctx.restore();
        }
        if (g.timer > 2.5) {
          g.phase = 'done';
        }
        break;
      case 'done':
        this.gachaAnim = null;
        break;
    }
  }

  private drawCapsule(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    // 上半分
    ctx.fillStyle = '#FF89A2';
    ctx.beginPath();
    ctx.arc(x, y, r, Math.PI, 0);
    ctx.fill();
    // 下半分
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI);
    ctx.fill();
    // 線
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - r, y);
    ctx.lineTo(x + r, y);
    ctx.stroke();
  }

  isGachaAnimating(): boolean {
    return this.gachaAnim !== null;
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  private lightenColor(hex: string, amount: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const nr = Math.min(255, Math.round(r + (255 - r) * amount));
    const ng = Math.min(255, Math.round(g + (255 - g) * amount));
    const nb = Math.min(255, Math.round(b + (255 - b) * amount));
    return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
  }

  private darkenColor(hex: string, amount: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const nr = Math.max(0, Math.round(r * (1 - amount)));
    const ng = Math.max(0, Math.round(g * (1 - amount)));
    const nb = Math.max(0, Math.round(b * (1 - amount)));
    return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
  }
}
