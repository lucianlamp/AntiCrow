import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { motion } from "framer-motion";
import { Download, Package, Terminal, CheckCircle, AlertCircle, Loader2, ArrowLeft, Shield, AlertTriangle, Wrench, Lock, KeyRound } from "lucide-react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";

const R2_PUBLIC_URL = "https://pub-43d0b2eef4734fc8b00c014791e17d8a.r2.dev";
// バージョン情報取得はPages Function経由（R2のpub-*.r2.devはCORSヘッダーを返さないため）
const LATEST_API_URL = "/api/latest";

const ACCESS_CODE = "ANTICROW2026EXT";
const AUTH_STORAGE_KEY = "anticrow_dl_auth";

interface LatestInfo {
  version: string;
  uploadedAt: string;
  fileName: string;
}

function formatDate(iso: string, lang: string): string {
  try {
    const locale = lang === "ja" ? "ja-JP" : "en-US";
    const d = new Date(iso);
    return d.toLocaleDateString(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// アクセスコードゲートコンポーネント
function AccessCodeGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim().toUpperCase() === ACCESS_CODE) {
      sessionStorage.setItem(AUTH_STORAGE_KEY, "true");
      onAuthenticated();
    } else {
      setError(true);
      setShake(true);
      setTimeout(() => setShake(false), 500);
    }
  };

  return (
    <main className="relative z-10 container mx-auto px-4 py-16 max-w-md flex flex-col items-center justify-center min-h-[70vh]">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="w-full"
      >
        {/* lock icon */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/10 border border-primary/20">
            <Lock className="w-10 h-10 text-primary" />
          </div>
        </div>

        {/* heading */}
        <h1 className="text-3xl md:text-4xl font-bold font-heading text-center mb-3">
          <span className="text-gradient-primary">{t("download.accessCode.title")}</span>
        </h1>
        <p className="text-muted-foreground text-center mb-8">
          {t("download.accessCode.subtitle")}
        </p>

        {/* form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className={`glass-card rounded-xl p-6 transition-transform ${shake ? "animate-[shake_0.5s_ease-in-out]" : ""}`}>
            <div className="flex items-center gap-3 mb-4">
              <KeyRound className="w-5 h-5 text-primary flex-shrink-0" />
              <input
                type="text"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setError(false);
                }}
                placeholder={t("download.accessCode.placeholder")}
                autoFocus
                className="flex-1 bg-transparent border-none outline-none text-foreground placeholder-muted-foreground text-lg font-mono tracking-wider"
              />
            </div>
            {error && (
              <motion.p
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-destructive text-sm flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {t("download.accessCode.error")}
              </motion.p>
            )}
          </div>

          <button
            type="submit"
            className="group flex items-center justify-center gap-3 w-full py-4 px-6 rounded-xl font-semibold text-lg transition-all duration-300 bg-primary text-primary-foreground hover:brightness-110 glow-indigo active:scale-[0.98]"
          >
            <Lock className="w-5 h-5 transition-transform group-hover:scale-110" />
            {t("download.accessCode.submit")}
          </button>
        </form>

        <p className="text-muted-foreground text-xs text-center mt-6">
          {t("download.accessCode.hint")}
        </p>
      </motion.div>
    </main>
  );
}

export default function DownloadPage() {
  const { t, i18n } = useTranslation();
  const [latest, setLatest] = useState<LatestInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return sessionStorage.getItem(AUTH_STORAGE_KEY) === "true";
  });

  useEffect(() => {
    // 認証済みでない場合はバージョン情報を取得しない
    if (!isAuthenticated) return;

    const fetchLatest = async () => {
      try {
        const res = await fetch(LATEST_API_URL, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: LatestInfo = await res.json();
        if (!data.version || !data.fileName) {
          throw new Error("Invalid response format");
        }
        setLatest(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to fetch version info"
        );
      } finally {
        setLoading(false);
      }
    };
    fetchLatest();
  }, [isAuthenticated]);

  const downloadUrl = latest
    ? `${R2_PUBLIC_URL}/${latest.fileName}`
    : null;

  const steps = [
    {
      icon: Download,
      title: t("download.step1Title"),
      desc: t("download.step1Desc"),
    },
    {
      icon: Terminal,
      title: t("download.step2Title"),
      desc: t("download.step2Desc"),
      code: t("download.step2Code"),
    },
    {
      icon: CheckCircle,
      title: t("download.step3Title"),
      desc: t("download.step3Desc"),
    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground relative overflow-hidden">
      <Helmet>
        <title>{t("download.pageTitle")}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      {/* Background decoration */}
      <div className="fixed inset-0 pointer-events-none">
        <div
          className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] rounded-full opacity-[0.06]"
          style={{
            background:
              "radial-gradient(circle, oklch(0.585 0.233 277), transparent 70%)",
          }}
        />
        <div
          className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full opacity-[0.04]"
          style={{
            background:
              "radial-gradient(circle, oklch(0.718 0.202 349), transparent 70%)",
          }}
        />
      </div>

      {/* 未認証: アクセスコードゲート表示 */}
      {!isAuthenticated ? (
        <>
          <div className="relative z-10 container mx-auto pt-8 px-4">
            <Link href="/">
              <span className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer">
                <ArrowLeft className="w-4 h-4" />
                {t("download.backToHome")}
              </span>
            </Link>
          </div>
          <AccessCodeGate onAuthenticated={() => setIsAuthenticated(true)} />
        </>
      ) : (
        <>
          {/* Back link */}
          <div className="relative z-10 container mx-auto pt-8 px-4">
            <Link href="/">
              <span className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer">
                <ArrowLeft className="w-4 h-4" />
                {t("download.backToHome")}
              </span>
            </Link>
          </div>

          {/* Main content */}
          <main className="relative z-10 container mx-auto px-4 py-16 max-w-3xl">
            {/* Header */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="text-center mb-16"
            >
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/10 border border-primary/20 mb-6">
                <Package className="w-10 h-10 text-primary" />
              </div>
              <h1 className="text-4xl md:text-5xl font-bold font-heading mb-4">
                <span className="text-gradient-primary">{t("download.title")}</span>{" "}
                <span className="text-foreground">{t("download.titleSuffix")}</span>
              </h1>
              <p className="text-muted-foreground text-lg max-w-md mx-auto">
                {t("download.subtitle")}
              </p>
            </motion.div>

            {/* Version card */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.15 }}
              className="glass-card rounded-2xl p-8 mb-12"
            >
              {loading ? (
                <div className="flex flex-col items-center gap-4 py-8">
                  <Loader2 className="w-8 h-8 text-primary animate-spin" />
                  <p className="text-muted-foreground">
                    {t("download.loading")}
                  </p>
                </div>
              ) : error ? (
                <div className="flex flex-col items-center gap-4 py-8">
                  <AlertCircle className="w-8 h-8 text-destructive" />
                  <p className="text-destructive">
                    {t("download.error")}
                  </p>
                  <p className="text-muted-foreground text-sm">{error}</p>
                </div>
              ) : latest ? (
                <div className="space-y-6">
                  {/* Version info */}
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-3 mb-1">
                        <span className="text-2xl font-bold font-heading text-foreground">
                          v{latest.version}
                        </span>
                        <span className="px-2.5 py-0.5 rounded-full bg-primary/15 text-primary text-xs font-medium border border-primary/20">
                          Latest
                        </span>
                      </div>
                      <p className="text-muted-foreground text-sm">
                        {t("download.updatedAt")} {formatDate(latest.uploadedAt, i18n.language)}
                      </p>
                    </div>
                    <div className="text-sm text-muted-foreground font-mono bg-secondary/50 px-3 py-1.5 rounded-lg">
                      {latest.fileName}
                    </div>
                  </div>

                  {/* Disclaimer section */}
                  <div className="border-t border-border pt-6 space-y-4">
                    <h3 className="text-lg font-bold font-heading text-foreground">
                      {t("download.disclaimerTitle")}
                    </h3>

                    {/* Safety */}
                    <div className="glass-card rounded-xl p-4 space-y-2">
                      <div className="flex items-start gap-3">
                        <Shield className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                        <div>
                          <h4 className="font-semibold text-foreground text-sm">{t("disclaimer.safetyTitle")}</h4>
                          <p className="text-muted-foreground text-xs mt-1">{t("disclaimer.safetyDescription")}</p>
                        </div>
                      </div>
                    </div>

                    {/* Warning */}
                    <div className="glass-card rounded-xl p-4 space-y-2">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                        <div>
                          <h4 className="font-semibold text-foreground text-sm">{t("disclaimer.warningTitle")}</h4>
                          <p className="text-muted-foreground text-xs mt-1">{t("disclaimer.warningDescription")}</p>
                        </div>
                      </div>
                    </div>

                    {/* Technical */}
                    <div className="glass-card rounded-xl p-4 space-y-2">
                      <div className="flex items-start gap-3">
                        <Wrench className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                        <div>
                          <h4 className="font-semibold text-foreground text-sm">{t("disclaimer.cdpTitle")}</h4>
                          <p className="text-muted-foreground text-xs mt-1">{t("disclaimer.cdpDescription")}</p>
                        </div>
                      </div>
                    </div>

                    {/* Risks */}
                    <div className="glass-card rounded-xl p-4 space-y-3">
                      {(t("disclaimer.risks", { returnObjects: true }) as Array<{ title: string; description: string }>).map((risk, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <span className="text-destructive text-xs mt-0.5">⚠</span>
                          <div>
                            <span className="font-semibold text-foreground text-xs">{risk.title}: </span>
                            <span className="text-muted-foreground text-xs">{risk.description}</span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Legal */}
                    <div className="text-muted-foreground text-[11px] leading-relaxed space-y-2 px-1">
                      <p>{t("disclaimer.legalParagraph1")}</p>
                      <p>{t("disclaimer.legalParagraph2")}</p>
                    </div>

                    {/* Checkbox */}
                    <label className="flex items-center gap-3 cursor-pointer select-none py-2">
                      <input
                        type="checkbox"
                        checked={agreed}
                        onChange={(e) => setAgreed(e.target.checked)}
                        className="w-5 h-5 rounded border-2 border-primary/40 text-primary bg-transparent focus:ring-primary/30 focus:ring-2 accent-primary cursor-pointer"
                      />
                      <span className="text-sm text-foreground font-medium">
                        {t("download.agreeLabel")}
                      </span>
                    </label>
                  </div>

                  {/* Download button */}
                  {agreed ? (
                    <a
                      href={downloadUrl ?? "#"}
                      download
                      className="group flex items-center justify-center gap-3 w-full py-4 px-6 rounded-xl font-semibold text-lg transition-all duration-300 bg-primary text-primary-foreground hover:brightness-110 glow-indigo active:scale-[0.98]"
                    >
                      <Download className="w-5 h-5 transition-transform group-hover:-translate-y-0.5" />
                      {t("download.downloadButton")}
                    </a>
                  ) : (
                    <div
                      className="flex items-center justify-center gap-3 w-full py-4 px-6 rounded-xl font-semibold text-lg bg-primary/30 text-primary-foreground/50 cursor-not-allowed select-none"
                    >
                      <Download className="w-5 h-5" />
                      {t("download.downloadButton")}
                    </div>
                  )}
                </div>
              ) : null}
            </motion.div>

            {/* Installation steps */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="space-y-4"
            >
              <h2 className="text-xl font-bold font-heading text-foreground mb-6">
                {t("download.installTitle")}
              </h2>

              {steps.map((step, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -15 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: 0.4 + i * 0.1 }}
                  className="glass-card rounded-xl p-5 flex gap-4"
                >
                  <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <step.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-foreground mb-1">
                      {step.title}
                    </h3>
                    <p className="text-muted-foreground text-sm">{step.desc}</p>
                    {step.code && (
                      <div className="mt-3 rounded-lg bg-secondary/60 border border-border px-4 py-3 font-mono text-sm overflow-x-auto">
                        <code className="text-primary/90 whitespace-pre">
                          {step.code}
                        </code>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
            </motion.div>

            {/* Note */}
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.7 }}
              className="text-center text-muted-foreground text-xs mt-16"
            >
              {t("download.footer")}
            </motion.p>
          </main>
        </>
      )}
    </div>
  );
}
