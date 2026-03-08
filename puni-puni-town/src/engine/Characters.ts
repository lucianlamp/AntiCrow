/**
 * キャラクター定義モジュール
 * 8種類のぷにぷにキャラクターの名前、レアリティ、色、形状、自動収益値を管理する
 */

/** キャラクターのレアリティ（★1～★5） */
export type Rarity = 1 | 2 | 3 | 4 | 5;

/** キャラクターの形状タイプ */
export type ShapeType = 'dog' | 'cat' | 'rabbit' | 'turtle' | 'bear' | 'bird' | 'dragon' | 'unicorn';

/** キャラクター定義 */
export interface CharacterDef {
  /** 一意のID */
  id: string;
  /** 表示名 */
  name: string;
  /** レアリティ ★1～★5 */
  rarity: Rarity;
  /** 形状タイプ */
  shape: ShapeType;
  /** メインカラー（CSS色） */
  color: string;
  /** サブカラー（ハイライト用） */
  subColor: string;
  /** 1秒あたりの自動収益（ぷにコイン/秒） */
  incomePerSec: number;
  /** キャラの説明文 */
  description: string;
  /** 目の色 */
  eyeColor: string;
  /** ほっぺの色 */
  cheekColor: string;
}

/** 全キャラクター定義マスターデータ */
export const ALL_CHARACTERS: CharacterDef[] = [
  {
    id: 'punimaru',
    name: 'ぷにまる',
    rarity: 1,
    shape: 'dog',
    color: '#FF6B6B',
    subColor: '#FF9E9E',
    incomePerSec: 1,
    description: 'まんまるでもふもふの犬型ぷにぷに。いつもニコニコ！',
    eyeColor: '#3D2C2C',
    cheekColor: '#FF8A8A',
  },
  {
    id: 'punitama',
    name: 'ぷにたま',
    rarity: 1,
    shape: 'cat',
    color: '#6BA3FF',
    subColor: '#9EC5FF',
    incomePerSec: 1,
    description: 'ツンデレ気味な猫型ぷにぷに。でも本当は甘えたがり。',
    eyeColor: '#2C3D2C',
    cheekColor: '#8AB4FF',
  },
  {
    id: 'punipyon',
    name: 'ぷにぴょん',
    rarity: 2,
    shape: 'rabbit',
    color: '#FF8ED4',
    subColor: '#FFB5E3',
    incomePerSec: 3,
    description: 'ぴょんぴょん跳ねるうさぎ型ぷにぷに。元気いっぱい！',
    eyeColor: '#4A2040',
    cheekColor: '#FFA5DD',
  },
  {
    id: 'punikame',
    name: 'ぷにかめ',
    rarity: 2,
    shape: 'turtle',
    color: '#6BDB8E',
    subColor: '#9EEAB2',
    incomePerSec: 3,
    description: 'のんびり屋のかめ型ぷにぷに。マイペースが魅力。',
    eyeColor: '#2C3D2C',
    cheekColor: '#8AE8A5',
  },
  {
    id: 'punikuma',
    name: 'ぷにくま',
    rarity: 3,
    shape: 'bear',
    color: '#C49A6C',
    subColor: '#D9B896',
    incomePerSec: 8,
    description: 'もこもこのくま型ぷにぷに。ハチミツが大好き！',
    eyeColor: '#3D2C1A',
    cheekColor: '#DABA8E',
  },
  {
    id: 'punitori',
    name: 'ぷにとり',
    rarity: 3,
    shape: 'bird',
    color: '#FFD93D',
    subColor: '#FFE680',
    incomePerSec: 8,
    description: 'ちゅんちゅん歌う鳥型ぷにぷに。きれいな声の持ち主。',
    eyeColor: '#3D3D2C',
    cheekColor: '#FFE066',
  },
  {
    id: 'punidra',
    name: 'ぷにドラ',
    rarity: 4,
    shape: 'dragon',
    color: '#A36BFF',
    subColor: '#C49EFF',
    incomePerSec: 20,
    description: 'かっこいいドラゴン型ぷにぷに。小さい炎を吐ける！',
    eyeColor: '#FFD700',
    cheekColor: '#C48AFF',
  },
  {
    id: 'puniuni',
    name: 'ぷにユニ',
    rarity: 5,
    shape: 'unicorn',
    color: '#FF6BFF',
    subColor: '#FFB5FF',
    incomePerSec: 50,
    description: '伝説のユニコーン型ぷにぷに。虹色に輝く角が特徴！',
    eyeColor: '#6B3DFF',
    cheekColor: '#FFAAFF',
  },
];

/** レアリティに応じた★表記を返す */
export function getRarityStars(rarity: Rarity): string {
  return '★'.repeat(rarity);
}

/** レアリティに応じた背景グラデーション色を返す */
export function getRarityGradient(rarity: Rarity): [string, string] {
  switch (rarity) {
    case 1: return ['#E8E8E8', '#D0D0D0'];
    case 2: return ['#A8E6CF', '#7DD3B0'];
    case 3: return ['#87CEEB', '#5CADD6'];
    case 4: return ['#DDA0DD', '#C78DC7'];
    case 5: return ['#FFD700', '#FFA500'];
  }
}

/** IDからキャラクター定義を取得する */
export function getCharacterById(id: string): CharacterDef | undefined {
  return ALL_CHARACTERS.find(c => c.id === id);
}

/** レアリティでフィルタしたキャラクターリストを返す */
export function getCharactersByRarity(rarity: Rarity): CharacterDef[] {
  return ALL_CHARACTERS.filter(c => c.rarity === rarity);
}
