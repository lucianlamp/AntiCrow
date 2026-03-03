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

/**
 * 文字列を指定された最大長に切り詰め、超過時は末尾に「...」を付加する。
 * maxLen が 3 以下の場合は「...」を付けずにそのまま切り詰める。
 */
export function truncateWithEllipsis(text: string, maxLen: number): string {
    if (text.length <= maxLen) { return text; }
    if (maxLen <= 3) { return text.substring(0, maxLen); }
    return text.substring(0, maxLen - 3) + '...';
}
