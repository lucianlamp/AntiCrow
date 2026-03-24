import { Github } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function Footer() {
  const { t } = useTranslation();

  return (
    <footer className="relative border-t border-[oklch(0.25_0.03_260_/_40%)] py-12">
      <div className="container">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <img
              src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/AntiCrowIcon_ec2d4d08.png"
              alt="AntiCrow"
              className="w-7 h-7"
            />
            <span className="font-heading font-bold text-foreground">AntiCrow</span>
          </div>

          {/* Links */}
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">{t("footer.features")}</a>
            <a href="#how-it-works" className="hover:text-foreground transition-colors">{t("footer.howItWorks")}</a>
            <a href="#security" className="hover:text-foreground transition-colors">{t("footer.security")}</a>
            <a href="#faq" className="hover:text-foreground transition-colors">{t("footer.faq")}</a>
            <span className="text-[oklch(0.35_0.02_260)]">|</span>
            <a href={t("footer.privacyUrl")} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">{t("footer.privacy")}</a>
            <a href={t("footer.securityUrl")} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">{t("footer.securityPolicy")}</a>
            <span className="text-[oklch(0.35_0.02_260)]">|</span>
            <a href="https://github.com/lucianlamp/AntiCrow" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors">
              <Github className="w-3.5 h-3.5" />
              {t("footer.github")}
            </a>
          </div>

          {/* Copyright */}
          <p className="text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} AntiCrow. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
