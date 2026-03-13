import { lazy, Suspense, useRef, useState, useEffect, type ReactNode } from "react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import Footer from "@/components/Footer";

// Below-the-fold コンポーネントを lazy loading（初期バンドルサイズ削減）
const ParticleField = lazy(() => import("@/components/ParticleField"));
const FeaturesSection = lazy(() => import("@/components/FeaturesSection"));
const SecuritySection = lazy(() => import("@/components/SecuritySection"));
const FAQSection = lazy(() => import("@/components/FAQSection"));
const DisclaimerSection = lazy(() => import("@/components/DisclaimerSection"));
const CTASection = lazy(() => import("@/components/CTASection"));

// IntersectionObserver で遅延レンダリング
function LazyVisible({ children, minHeight = "40vh" }: { children: ReactNode; minHeight?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (visible) {
    return <Suspense fallback={<div style={{ minHeight }} />}>{children}</Suspense>;
  }
  return <div ref={ref} style={{ minHeight }} />;
}

export default function Home() {
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language;
  const canonicalUrl = "https://anticrow.pages.dev";

  return (
    <div className="min-h-screen bg-background text-foreground relative">
      <Helmet>
        <html lang={currentLang} />
        <title>{t("meta.title")}</title>
        <meta name="description" content={t("meta.description")} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonicalUrl} />
        <meta property="og:title" content={t("meta.ogTitle")} />
        <meta property="og:description" content={t("meta.ogDescription")} />
        <meta property="og:site_name" content="AntiCrow" />
        <meta property="og:locale" content={currentLang === "ja" ? "ja_JP" : "en_US"} />
        <meta property="og:image" content="https://anticrow.pages.dev/ogp.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="AntiCrow - Control Antigravity from Anywhere via Discord" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={t("meta.ogTitle")} />
        <meta name="twitter:description" content={t("meta.ogDescription")} />
        <meta name="twitter:image" content="https://anticrow.pages.dev/ogp.png" />
        <meta name="twitter:site" content="@lucianlampdefi" />
        <meta name="robots" content="index, follow" />
        <link rel="canonical" href={canonicalUrl} />
      </Helmet>
      <Suspense fallback={null}>
        <ParticleField />
      </Suspense>
      <Navbar />
      <main className="relative z-10">
        <HeroSection />
        <LazyVisible minHeight="40vh">
          <FeaturesSection />
        </LazyVisible>
        <LazyVisible minHeight="40vh">
          <SecuritySection />
        </LazyVisible>
        <LazyVisible minHeight="30vh">
          <FAQSection />
        </LazyVisible>
        <LazyVisible minHeight="20vh">
          <DisclaimerSection />
        </LazyVisible>
        <LazyVisible minHeight="20vh">
          <CTASection />
        </LazyVisible>
      </main>
      <Footer />
    </div>
  );
}
