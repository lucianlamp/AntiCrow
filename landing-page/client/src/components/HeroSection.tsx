import { motion } from "framer-motion";
import { Sparkles, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function HeroSection() {
  const { t } = useTranslation();

  return (
    <section className="relative min-h-screen flex items-center overflow-hidden pt-20">
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
      <div className="absolute top-1/4 left-[10%] w-64 h-64 rounded-full bg-indigo/10 blur-[80px] animate-float-orb-1" />
      <div className="absolute bottom-1/4 right-[10%] w-80 h-80 rounded-full bg-coral/10 blur-[100px] animate-float-orb-2" />

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

            {/* Docs Link */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.7, delay: 0.3 }}
              className="flex items-center gap-3 text-sm text-muted-foreground"
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
            <div className="absolute w-[400px] h-[400px] rounded-full bg-gradient-to-br from-indigo/20 to-coral/20 blur-[60px]" />
            <img
              src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/AntiCrowFullBody_7b5bfad5.PNG"
              alt="AntiCrow Mascot"
              width={420}
              height={420}
              loading="lazy"
              decoding="async"
              className="relative w-[340px] h-[340px] xl:w-[420px] xl:h-[420px] object-contain drop-shadow-2xl animate-float-mascot"
            />
            <div className="absolute top-8 right-0 glass-card rounded-xl px-4 py-3 animate-float-card-1">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs font-medium text-foreground">{t("hero.floatingAiRunning")}</span>
              </div>
            </div>
            <div className="absolute bottom-12 left-0 glass-card rounded-xl px-4 py-3 animate-float-card-2">
              <div className="flex items-center gap-2">
                <span className="text-xs">💬</span>
                <span className="text-xs font-medium text-foreground">{t("hero.floatingRelay")}</span>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
