import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X, Globe, Github } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function Navbar() {
  const { t, i18n } = useTranslation();
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const navLinks = [
    { label: t("nav.features"), href: "#features" },
    { label: t("nav.howItWorks"), href: "#features" },
    { label: t("nav.security"), href: "#security" },
    { label: t("nav.faq"), href: "#faq" },
  ];

  const toggleLanguage = () => {
    i18n.changeLanguage(i18n.language === "ja" ? "en" : "ja");
  };

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <motion.nav
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.6 }}
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${scrolled
        ? "bg-[oklch(0.14_0.03_260_/_80%)] backdrop-blur-xl border-b border-[oklch(0.3_0.03_260_/_30%)]"
        : "bg-transparent"
        }`}
    >
      <div className="container flex items-center justify-between h-16 md:h-20">
        {/* Logo */}
        <a href="#" className="flex items-center gap-3 group">
          <img
            src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/AntiCrowIcon_ec2d4d08.png"
            alt="AntiCrow"
            className="w-8 h-8 md:w-10 md:h-10 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-[-5deg]"
          />
          <span className="font-heading font-bold text-lg md:text-xl tracking-tight text-foreground">
            AntiCrow
          </span>
        </a>

        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-7">
          {navLinks.map((link) => (
            <a
              key={link.href + link.label}
              href={link.href}
              className="relative text-sm font-medium text-muted-foreground hover:text-foreground transition-colors duration-300 group"
            >
              {link.label}
              <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-gradient-to-r from-indigo to-coral transition-all duration-300 group-hover:w-full rounded-full" />
            </a>
          ))}
        </div>

        {/* CTA + Lang Toggle */}
        <div className="hidden md:flex items-center gap-3">
          <a
            href="https://github.com/lucianlamp/AntiCrow"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center w-9 h-9 text-muted-foreground hover:text-foreground rounded-full border border-[oklch(0.3_0.03_260_/_40%)] hover:border-[oklch(0.4_0.04_260_/_50%)] transition-all"
            aria-label="GitHub"
          >
            <Github className="w-4 h-4" />
          </a>
          <button
            onClick={toggleLanguage}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground rounded-full border border-[oklch(0.3_0.03_260_/_40%)] hover:border-[oklch(0.4_0.04_260_/_50%)] transition-all"
            aria-label="Toggle language"
          >
            <Globe className="w-3.5 h-3.5" />
            {i18n.language === "ja" ? "EN" : "JA"}
          </button>
          <a
            href="#install"
            className="relative px-5 py-2.5 text-sm font-semibold rounded-full overflow-hidden group"
          >
            <span className="absolute inset-0 bg-gradient-to-r from-indigo to-coral opacity-90 group-hover:opacity-100 transition-opacity" />
            <span className="relative text-white">{t("nav.install")}</span>
          </a>
        </div>

        {/* Mobile Toggle */}
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="md:hidden p-2 text-foreground"
          aria-label="Toggle menu"
        >
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile Menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="md:hidden bg-[oklch(0.14_0.03_260_/_95%)] backdrop-blur-xl border-t border-[oklch(0.3_0.03_260_/_30%)]"
          >
            <div className="container py-6 flex flex-col gap-4">
              {navLinks.map((link) => (
                <a
                  key={link.href + link.label}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className="text-base font-medium text-muted-foreground hover:text-foreground transition-colors py-2"
                >
                  {link.label}
                </a>
              ))}
              <div className="flex items-center gap-3 mt-2">
                <a
                  href="https://github.com/lucianlamp/AntiCrow"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center w-12 h-12 text-muted-foreground hover:text-foreground rounded-full border border-[oklch(0.3_0.03_260_/_40%)]"
                  aria-label="GitHub"
                >
                  <Github className="w-5 h-5" />
                </a>
                <button
                  onClick={toggleLanguage}
                  className="flex items-center gap-1.5 px-4 py-3 text-sm font-semibold text-muted-foreground rounded-full border border-[oklch(0.3_0.03_260_/_40%)]"
                >
                  <Globe className="w-4 h-4" />
                  {i18n.language === "ja" ? "EN" : "JA"}
                </button>
                <a
                  href="#install"
                  onClick={() => setMobileOpen(false)}
                  className="flex-1 inline-flex items-center justify-center px-5 py-3 text-sm font-semibold rounded-full bg-gradient-to-r from-indigo to-coral text-white"
                >
                  {t("nav.install")}
                </a>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
}
