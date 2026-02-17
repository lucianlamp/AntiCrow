// ---------------------------------------------------------------------------
// discordUtils.ts — Discord 共通ユーティリティ
// ---------------------------------------------------------------------------

/**
 * Discord Snowflake ID からタイムスタンプ（ms）を抽出する。
 * Discord epoch (2015-01-01) からのオフセットを加算して Unix タイムスタンプに変換。
 */
export function snowflakeToTimestamp(snowflake: string): number {
    return Number(BigInt(snowflake) >> 22n) + 1420070400000;
}
