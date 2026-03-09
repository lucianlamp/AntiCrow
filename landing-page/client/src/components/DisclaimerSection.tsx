import { motion } from "framer-motion";
import { AlertTriangle, ShieldAlert, ShieldCheck, Code2, KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";

const riskIcons = [ShieldAlert, Code2, KeyRound];

export default function DisclaimerSection() {
  const { t } = useTranslation();
  const risks = t("disclaimer.risks", { returnObjects: true }) as Array<{ title: string; description: string }>;

  return (
    <section id="disclaimer" className="relative py-24 md:py-32 overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-destructive/5 blur-[120px]" />
      </div>

      <div className="container relative z-10">
        <div className="max-w-4xl mx-auto">
          {/* Section Header */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
            className="text-center mb-12"
          >
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-destructive tracking-widest uppercase mb-4 font-mono">
              <AlertTriangle className="w-4 h-4" />
              {t("disclaimer.label")}
            </span>
            <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
              {t("disclaimer.title1")}
              <span className="text-destructive">{t("disclaimer.title2")}</span>{t("disclaimer.title3")}
            </h2>
          </motion.div>

          {/* Safety banner — AntiCrow is safe */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.6, delay: 0.05 }}
            className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 backdrop-blur-sm p-6 md:p-8 mb-6"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-6 h-6 text-emerald-500" />
              </div>
              <div>
                <h3 className="font-heading font-bold text-lg text-foreground mb-2">
                  {t("disclaimer.safetyTitle")}
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  {t("disclaimer.safetyDescription")}
                </p>
              </div>
            </div>
          </motion.div>

          {/* Warning banner — risks from Antigravity */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="rounded-2xl border border-destructive/30 bg-destructive/5 backdrop-blur-sm p-6 md:p-8 mb-10"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-destructive/15 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-6 h-6 text-destructive" />
              </div>
              <div>
                <h3 className="font-heading font-bold text-lg text-foreground mb-2">
                  {t("disclaimer.warningTitle")}
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  {t("disclaimer.warningDescription")}
                </p>
              </div>
            </div>
          </motion.div>

          {/* Risk cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
            {risks.map((risk, index) => {
              const Icon = riskIcons[index];
              return (
                <motion.div
                  key={risk.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-50px" }}
                  transition={{ duration: 0.5, delay: 0.15 + index * 0.1 }}
                  className="glass-card rounded-xl p-6 border-destructive/20 hover:border-destructive/40 transition-all duration-500"
                >
                  <div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center mb-4">
                    <Icon className="w-5 h-5 text-destructive" />
                  </div>
                  <h3 className="font-heading font-semibold text-foreground mb-2">
                    {risk.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {risk.description}
                  </p>
                </motion.div>
              );
            })}
          </div>

          {/* Legal disclaimer */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="glass-card rounded-2xl p-6 md:p-8 border-destructive/10"
          >
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              {t("disclaimer.legalParagraph1")}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              {t("disclaimer.legalParagraph2")}
            </p>
            <p className="text-xs text-muted-foreground/70 leading-relaxed">
              {t("disclaimer.legalParagraph3")}
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
