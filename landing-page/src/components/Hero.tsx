import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

// 画像スライド: ここに画像パスを追加すれば自動でスライドショーになる
const SLIDE_IMAGES: { src: string; alt: string }[] = [
    // 例: { src: '/slides/screenshot1.png', alt: 'Discord連携の様子' },
    // 例: { src: '/slides/screenshot2.png', alt: 'コーディング自動化' },
];

function ImageSlideshow() {
    const [currentIndex, setCurrentIndex] = useState(0);

    useEffect(() => {
        if (SLIDE_IMAGES.length <= 1) return;
        const timer = setInterval(() => {
            setCurrentIndex((prev) => (prev + 1) % SLIDE_IMAGES.length);
        }, 4000);
        return () => clearInterval(timer);
    }, []);

    if (SLIDE_IMAGES.length === 0) {
        // プレースホルダー: 画像が追加されるまで表示
        return (
            <div className="relative max-w-2xl w-full rounded-2xl border border-white/10 bg-dark-900/60 overflow-hidden">
                <div className="aspect-[16/9] flex items-center justify-center text-gray-500">
                    <div className="text-center space-y-2">
                        <div className="text-4xl">🖼️</div>
                        <p className="text-sm">スクリーンショットが追加される予定</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="relative max-w-2xl w-full rounded-2xl border border-white/10 bg-dark-900/60 overflow-hidden">
            <div className="aspect-[16/9] relative">
                {SLIDE_IMAGES.map((img, i) => (
                    <img
                        key={i}
                        src={img.src}
                        alt={img.alt}
                        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ${i === currentIndex ? 'opacity-100' : 'opacity-0'
                            }`}
                    />
                ))}
            </div>
            {/* ドットインジケーター */}
            {SLIDE_IMAGES.length > 1 && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-2">
                    {SLIDE_IMAGES.map((_, i) => (
                        <button
                            key={i}
                            onClick={() => setCurrentIndex(i)}
                            className={`w-2 h-2 rounded-full transition-all ${i === currentIndex
                                ? 'bg-purple-400 w-4'
                                : 'bg-white/30 hover:bg-white/50'
                                }`}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}


interface WaitlistResult {
    position: number;
    referralCode: string;
    points: number;
    pointsLabel: string;
}

export function Hero() {
    const { t } = useTranslation();
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<WaitlistResult | null>(null);
    const [error, setError] = useState('');
    const [copied, setCopied] = useState(false);

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email || loading) return;

        setLoading(true);
        setError('');

        try {
            const referralCode = new URLSearchParams(window.location.search).get('ref');
            const res = await fetch('/api/waitlist/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, referralCode: referralCode || undefined }),
            });

            if (!res.ok) throw new Error('Failed');

            const data = await res.json();
            setResult({
                position: data.position,
                referralCode: data.referralCode,
                points: data.points ?? 0,
                pointsLabel: data.pointsLabel ?? '0pt',
            });
        } catch {
            setError(t('hero.waitlist.error'));
        } finally {
            setLoading(false);
        }
    }, [email, loading, t]);

    const referralUrl = result
        ? `${window.location.origin}?ref=${result.referralCode}`
        : '';

    const copyReferral = useCallback(async () => {
        if (!referralUrl) return;
        await navigator.clipboard.writeText(referralUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [referralUrl]);

    return (
        <section className="relative min-h-screen flex items-center justify-center pt-20 pb-16 px-4 overflow-hidden">
            {/* Background decorations */}
            <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-700/10 rounded-full blur-3xl"></div>
                <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-purple-500/8 rounded-full blur-3xl"></div>
            </div>

            <div className="relative z-10 max-w-6xl mx-auto text-center flex flex-col items-center gap-8">
                {/* AntiCrow Character */}
                <img
                    src="/AntiCrowFullBody.png"
                    alt="AntiCrow"
                    className="w-32 h-32 sm:w-40 sm:h-40 object-contain drop-shadow-2xl"
                />
                {/* Main copy */}
                <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold leading-tight tracking-tight">
                    <span className="gradient-text whitespace-pre-line">{t('hero.title')}</span>
                </h1>
                <p className="text-lg sm:text-xl text-gray-400 max-w-2xl">
                    {t('hero.subtitle')}
                </p>

                {/* Waitlist Form or Result */}
                {!result ? (
                    <div className="glass-card p-6 sm:p-8 max-w-md w-full glow-purple">
                        <h3 className="text-lg font-semibold text-white mb-4">{t('hero.waitlist.title')}</h3>
                        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder={t('hero.waitlist.placeholder')}
                                required
                                className="waitlist-input"
                            />
                            <button
                                type="submit"
                                disabled={loading || !email}
                                className="btn-primary w-full"
                            >
                                {loading ? t('hero.waitlist.submitting') : t('hero.waitlist.button')}
                            </button>
                        </form>
                        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
                    </div>
                ) : (
                    <div className="glass-card p-6 sm:p-8 max-w-md w-full glow-purple">
                        <h3 className="text-xl font-bold text-white mb-2">{t('hero.waitlist.success.title')}</h3>
                        <p className="text-3xl font-bold gradient-text mb-4">
                            {t('hero.waitlist.success.position', { position: result.position })}
                        </p>

                        <div className="space-y-3">
                            <p className="text-sm text-gray-400">{t('hero.waitlist.success.referralLabel')}</p>
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    readOnly
                                    value={referralUrl}
                                    className="waitlist-input text-sm flex-1"
                                />
                                <button
                                    onClick={copyReferral}
                                    className="btn-secondary whitespace-nowrap text-sm !px-4 !py-3"
                                >
                                    {copied ? t('hero.waitlist.success.copied') : t('hero.waitlist.success.copy')}
                                </button>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                                <span className="text-gray-400">
                                    {t('hero.waitlist.success.points', { points: result.pointsLabel })}
                                </span>
                                <span className="text-purple-400 font-medium">
                                    {t('hero.waitlist.success.boost')}
                                </span>
                            </div>
                            {/* X シェアボタン */}
                            <button
                                onClick={() => {
                                    const text = encodeURIComponent(t('hero.waitlist.success.shareText'));
                                    const url = encodeURIComponent(referralUrl);
                                    window.open(`https://x.com/intent/tweet?text=${text}&url=${url}`, '_blank');
                                }}
                                className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-black hover:bg-gray-900 border border-white/10 hover:border-white/20 text-white font-medium text-sm transition-all"
                            >
                                <span className="text-lg">𝕏</span>
                                {t('hero.waitlist.success.shareX')}
                            </button>
                        </div>
                    </div>
                )}

                {/* Image slideshow */}
                <ImageSlideshow />
            </div>
        </section>
    );
}
