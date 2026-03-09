import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Sparkles, Copy, Check, Loader2, ExternalLink } from "lucide-react";
import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";

interface WaitlistResponse {
  success: boolean;
  alreadyRegistered: boolean;
  email: string;
  referralCode: string;
  position: number;
  totalCount: number;
  points: number;
  pointsLabel: string;
  referralLink: string;
}

// コンフェッティパーティクル生成
function ConfettiEffect() {
  const particles = useMemo(
    () =>
      Array.from({ length: 40 }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        delay: Math.random() * 0.5,
        duration: 1.5 + Math.random() * 1.5,
        size: 4 + Math.random() * 8,
        color: [
          "oklch(0.65 0.2 260)",  // indigo
          "oklch(0.7 0.18 25)",   // coral
          "oklch(0.8 0.15 85)",   // amber
          "oklch(0.7 0.2 150)",   // green
          "oklch(0.65 0.2 300)",  // purple
        ][Math.floor(Math.random() * 5)],
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 720,
      })),
    []
  );

  return (
    <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          initial={{ y: -20, x: `${p.x}vw`, opacity: 1, rotate: p.rotation, scale: 1 }}
          animate={{
            y: "110vh",
            rotate: p.rotation + p.rotSpeed,
            opacity: [1, 1, 0],
            scale: [1, 1, 0.5],
          }}
          transition={{
            duration: p.duration,
            delay: p.delay,
            ease: "easeIn",
          }}
          style={{
            position: "absolute",
            width: p.size,
            height: p.size * 0.6,
            backgroundColor: p.color,
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

// X (Twitter) ロゴ SVG
function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export default function HeroSection() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<WaitlistResponse | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [copied, setCopied] = useState(false);

  // URLから?ref=パラメータを取得
  const referralCode = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("ref") || undefined;
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || isLoading) return;

    setIsLoading(true);
    setError("");

    try {
      const res = await fetch("/api/waitlist/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, referralCode }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error === "Valid email is required"
          ? t("hero.invalidEmail")
          : t("hero.genericError"));
        return;
      }

      setResult(data as WaitlistResponse);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 3000);
    } catch {
      setError(t("hero.genericError"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // フォールバック: テキスト選択
      const ta = document.createElement("textarea");
      ta.value = result.referralLink;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <section className="relative min-h-screen flex items-center overflow-hidden pt-20">
      {/* Confetti */}
      <AnimatePresence>{showConfetti && <ConfettiEffect />}</AnimatePresence>

      {/* Background Image */}
      <div className="absolute inset-0 z-0">
        <img
          src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/hero-bg-jLcZDYytnS2mJRk2Y2RK4P.webp"
          alt=""
          aria-hidden="true"
          width={1920}
          height={1080}
          decoding="async"
          fetchPriority="high"
          className="w-full h-full object-cover opacity-40"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/40 to-background" />
      </div>

      {/* Floating Orbs */}
      <motion.div
        animate={{ x: [0, 30, 0], y: [0, -20, 0] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        className="absolute top-1/4 left-[10%] w-64 h-64 rounded-full bg-indigo/10 blur-[80px]"
      />
      <motion.div
        animate={{ x: [0, -20, 0], y: [0, 30, 0] }}
        transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
        className="absolute bottom-1/4 right-[10%] w-80 h-80 rounded-full bg-coral/10 blur-[100px]"
      />

      <div className="container relative z-10">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left: Text Content */}
          <div className="max-w-2xl">
            {/* Badge */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-card mb-8"
            >
              <Sparkles className="w-4 h-4 text-amber" />
              <span className="text-sm font-medium text-amber">
                {t("hero.badge")}
              </span>
            </motion.div>

            {/* Headline */}
            <motion.h1
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.1 }}
              className="font-heading text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-extrabold leading-[1.1] tracking-tight mb-6"
            >
              <span className="text-foreground">{t("hero.headline1")}</span>
              <br />
              <span className="text-foreground">{t("hero.headline2")}</span>
              <br />
              <span className="text-gradient-primary">{t("hero.headline3")}</span>
            </motion.h1>

            {/* Subtitle */}
            <motion.p
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.2 }}
              className="text-lg sm:text-xl text-muted-foreground leading-relaxed mb-10 max-w-lg"
            >
              {t("hero.subtitle")}
            </motion.p>

            {/* Waitlist Form or Result */}
            <AnimatePresence mode="wait">
              {result ? (
                // 成功カード
                <motion.div
                  key="result"
                  initial={{ opacity: 0, scale: 0.9, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.5, type: "spring", bounce: 0.3 }}
                  id="waitlist"
                  className="max-w-md p-6 rounded-2xl glass-card border border-indigo/20 relative overflow-hidden"
                >
                  {/* グロウエフェクト */}
                  <div className="absolute -inset-1 bg-gradient-to-r from-indigo/20 via-coral/20 to-indigo/20 rounded-2xl blur-xl opacity-60 animate-pulse" />

                  <div className="relative space-y-4">
                    {/* ヘッダー */}
                    <div className="text-center">
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ delay: 0.2, type: "spring", bounce: 0.5 }}
                        className="text-4xl mb-2"
                      >
                        🎉
                      </motion.div>
                      <h3 className="text-lg font-bold text-foreground">
                        {result.alreadyRegistered
                          ? t("hero.alreadyRegistered")
                          : t("hero.successTitle")}
                      </h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        {t("hero.referralHint")}
                      </p>
                    </div>

                    {/* リファラルリンク */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 px-3 py-2 rounded-lg bg-background/50 border border-border text-xs text-foreground font-mono truncate">
                          {result.referralLink}
                        </div>
                        <button
                          onClick={handleCopy}
                          className="flex-shrink-0 p-2 rounded-lg bg-indigo/20 hover:bg-indigo/30 text-indigo transition-colors"
                          title="Copy"
                        >
                          {copied ? (
                            <Check className="w-4 h-4" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                      {copied && (
                        <motion.p
                          initial={{ opacity: 0, y: -5 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="text-xs text-green-400 text-center"
                        >
                          {t("hero.referralCopied")}
                        </motion.p>
                      )}

                      {/* Xシェアボタン */}
                      <a
                        href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                          t("hero.shareXText")
                        )}&url=${encodeURIComponent(result.referralLink)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-black hover:bg-neutral-800 text-white text-sm font-semibold transition-colors"
                      >
                        <XLogo className="w-4 h-4" />
                        {t("hero.share")}
                        <ExternalLink className="w-3 h-3 opacity-60" />
                      </a>
                    </div>
                  </div>
                </motion.div>
              ) : (
                // 登録フォーム
                <motion.form
                  key="form"
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.7, delay: 0.3 }}
                  onSubmit={handleSubmit}
                  id="waitlist"
                  className="flex flex-col gap-3 max-w-md"
                >
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="relative flex-1">
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          if (error) setError("");
                        }}
                        placeholder={t("hero.placeholder")}
                        className="w-full px-5 py-3.5 rounded-xl bg-[oklch(0.18_0.035_260_/_60%)] backdrop-blur-sm border border-[oklch(0.35_0.04_260_/_30%)] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-indigo/50 focus:ring-2 focus:ring-indigo/20 transition-all text-sm"
                        required
                        disabled={isLoading}
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isLoading}
                      className="group relative px-6 py-3.5 rounded-xl font-semibold text-sm overflow-hidden transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-70 disabled:cursor-not-allowed disabled:hover:scale-100"
                    >
                      <span className="absolute inset-0 bg-gradient-to-r from-indigo to-coral" />
                      <span className="absolute inset-0 bg-gradient-to-r from-indigo via-coral to-indigo bg-[length:200%_100%] opacity-0 group-hover:opacity-100 group-hover:animate-[shimmer_2s_ease-in-out_infinite] transition-opacity" />
                      <span className="relative flex items-center justify-center gap-2 text-white">
                        {isLoading ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {t("hero.loading")}
                          </>
                        ) : (
                          <>
                            {t("hero.submit")}
                            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                          </>
                        )}
                      </span>
                    </button>
                  </div>

                  {/* エラーメッセージ */}
                  <AnimatePresence>
                    {error && (
                      <motion.p
                        initial={{ opacity: 0, y: -5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -5 }}
                        className="text-sm text-red-400 pl-1"
                      >
                        {error}
                      </motion.p>
                    )}
                  </AnimatePresence>

                  {/* リファラル通知 */}
                  {referralCode && (
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-xs text-indigo pl-1"
                    >
                      {t("hero.referralApplied")} {referralCode}
                    </motion.p>
                  )}
                </motion.form>
              )}
            </AnimatePresence>

            {/* Docs Link */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.7, delay: 0.5 }}
              className="mt-8 flex items-center gap-3 text-sm text-muted-foreground"
            >
              <a
                href={t("hero.docsUrl")}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
              >
                {t("hero.docsLink")}
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </motion.div>
          </div>

          {/* Right: Mascot + Visual */}
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="relative hidden lg:flex items-center justify-center"
          >
            {/* Glow behind mascot */}
            <div className="absolute w-[400px] h-[400px] rounded-full bg-gradient-to-br from-indigo/20 to-coral/20 blur-[60px]" />

            {/* Mascot */}
            <motion.img
              src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/AntiCrowFullBody_7b5bfad5.PNG"
              alt="AntiCrow Mascot - Discord と Antigravity を繋ぐカラスのマスコット"
              width={420}
              height={420}
              loading="lazy"
              decoding="async"
              className="relative w-[340px] h-[340px] xl:w-[420px] xl:h-[420px] object-contain drop-shadow-2xl"
              animate={{ y: [0, -15, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            />

            {/* Floating Cards around mascot */}
            <motion.div
              animate={{ y: [0, -8, 0], rotate: [0, 2, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className="absolute top-8 right-0 glass-card rounded-xl px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs font-medium text-foreground">{t('hero.floatingAiRunning')}</span>
              </div>
            </motion.div>

            <motion.div
              animate={{ y: [0, 10, 0], rotate: [0, -2, 0] }}
              transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut", delay: 1 }}
              className="absolute bottom-12 left-0 glass-card rounded-xl px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs">💬</span>
                <span className="text-xs font-medium text-foreground">{t('hero.floatingRelay')}</span>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
