// 共有ユーティリティ関数

/**
 * 暗号論的に安全なトークンを生成する
 * crypto.getRandomValues() を使用（CF Workers対応）
 */
export function generateToken(length: number = 48): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    let token = '';
    for (let i = 0; i < length; i++) {
        token += chars.charAt(randomValues[i] % chars.length);
    }
    return token;
}

/**
 * メール送信をチャンク化して並列実行する
 * CF Functions の10秒制限を考慮して10件ずつ並列送信
 */
export async function sendEmailsInChunks<T>(
    items: T[],
    sendFn: (item: T) => Promise<{ success: boolean; error?: string }>,
    chunkSize: number = 10,
): Promise<{ success: boolean; error?: string }[]> {
    const results: { success: boolean; error?: string }[] = [];

    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const chunkResults = await Promise.allSettled(chunk.map(sendFn));

        for (const result of chunkResults) {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                results.push({ success: false, error: result.reason?.message || 'Unknown error' });
            }
        }
    }

    return results;
}
