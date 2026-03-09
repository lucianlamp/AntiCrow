import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import Navbar from "@/components/Navbar";
import ParticleField from "@/components/ParticleField";
import HeroSection from "@/components/HeroSection";
import FeaturesSection from "@/components/FeaturesSection";
import SecuritySection from "@/components/SecuritySection";
import FAQSection from "@/components/FAQSection";
import DisclaimerSection from "@/components/DisclaimerSection";
import CTASection from "@/components/CTASection";
import Footer from "@/components/Footer";

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
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={t("meta.ogTitle")} />
        <meta name="twitter:description" content={t("meta.ogDescription")} />
        <link rel="canonical" href={canonicalUrl} />
      </Helmet>
      <ParticleField />
      <Navbar />
      <main className="relative z-10">
        <HeroSection />
        <FeaturesSection />
        <SecuritySection />
        <FAQSection />
        <DisclaimerSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}

