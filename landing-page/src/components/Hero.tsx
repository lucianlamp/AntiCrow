import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const TYPING_LINES = [
    { prefix: '💬 Discord', text: ' → "Fix the login bug and add tests"' },
    { prefix: '🐦‍⬛ AntiCrow', text: ' → Bridging to Antigravity...' },
    { prefix: '🤖 Antigravity', text: ' → Analyzing codebase...' },
    { prefix: '✅ Done', text: ' → Bug fixed, 12 tests passing!' },
];

function TypingAnimation() {
    const [lineIndex, setLineIndex] = useState(0);
    const [charIndex, setCharIndex] = useState(0);
    const [displayedLines, setDisplayedLines] = useState<string[]>([]);

    useEffect(() => {
        if (lineIndex >= TYPING_LINES.length) {
            const timer = setTimeout(() => {
                setLineIndex(0);
                setCharIndex(0);
                setDisplayedLines([]);
            }, 3000);
            return () => clearTimeout(timer);
        }

        const currentLine = TYPING_LINES[lineIndex];
        const fullText = currentLine.prefix + currentLine.text;

        if (charIndex < fullText.length) {
            const timer = setTimeout(() => {
                setCharIndex(charIndex + 1);
            }, 30);
            return () => clearTimeout(timer);
        } else {
            const timer = setTimeout(() => {
                setDisplayedLines(prev => [...prev, fullText]);
                setLineIndex(lineIndex + 1);
                setCharIndex(0);
            }, 500);
            return () => clearTimeout(timer);
        }
    }, [lineIndex, charIndex]);

    const currentLine = lineIndex < TYPING_LINES.length
        ? TYPING_LINES[lineIndex].prefix + TYPING_LINES[lineIndex].text
        : '';
    const currentText = currentLine.slice(0, charIndex);

    return (
        <div className="bg-dark-900/80 rounded-2xl border border-white/10 p-6 font-mono text-sm max-w-xl w-full">
            <div className="flex items-center gap-2 mb-4">
                <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
                <span className="text-gray-500 ml-2 text-xs">anticrow terminal</span>
            </div>
            {displayedLines.map((line, i) => (
                <div key={i} className="text-gray-300 mb-1">
                    <span className="text-purple-400">$ </span>{line}
                </div>
            ))}
            {lineIndex < TYPING_LINES.length && (
                <div className="text-gray-300">
                    <span className="text-purple-400">$ </span>
                    {currentText}
                    <span className="cursor-blink text-purple-400">▌</span>
                </div>
            )}
        </div>
    );
}

interface WaitlistResult {
    position: number;
    referralCode: string;
    referralCount: number;
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
                referralCount: data.referralCount ?? 0,
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
                {/* Main copy */}
                <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold leading-tight tracking-tight">
                    <span className="gradient-text">{t('hero.title')}</span>
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
                                    {t('hero.waitlist.success.referrals', { count: result.referralCount })}
                                </span>
                                <span className="text-purple-400 font-medium">
                                    {t('hero.waitlist.success.boost')}
                                </span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Typing animation */}
                <TypingAnimation />
            </div>
        </section>
    );
}
