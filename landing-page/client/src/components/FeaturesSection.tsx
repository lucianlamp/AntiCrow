import { motion } from "framer-motion";
import {
  Smartphone,
  Clock,
  Users,
  Zap,
  Brain,
  FolderOpen,
  MessageSquare,
  Bot,
  CheckCircle2,
  ChevronRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";

const featureIcons = [Smartphone, Clock, Users, Zap, Brain, FolderOpen];
const featureColors = [
  "from-indigo to-indigo/60",
  "from-coral to-coral/60",
  "from-amber to-amber/60",
  "from-indigo to-coral",
  "from-coral to-indigo",
  "from-amber to-indigo",
];

const stepIcons = [MessageSquare, Bot, CheckCircle2];
const stepColors = ["indigo", "coral", "amber"];

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5 },
  },
};

export default function FeaturesSection() {
  const { t } = useTranslation();
  const featureItems = t("features.items", { returnObjects: true }) as Array<{ title: string; description: string; badge?: string }>;
  const stepItems = t("features.howItWorks.steps", { returnObjects: true }) as Array<{ title: string; description: string }>;

  return (
    <section id="features" className="relative py-24 md:py-32 overflow-hidden">
      {/* Subtle background texture */}
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-gradient-to-b from-background via-[oklch(0.16_0.035_260)] to-background" />
      </div>

      <div className="container relative z-10">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="max-w-2xl mb-14 md:mb-18"
        >
          <span className="text-sm font-semibold text-indigo tracking-widest uppercase mb-4 block font-mono">
            {t("features.label")}
          </span>
          <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight mb-5">
            {t("features.title1")}
            <br />
            <span className="text-gradient-primary">{t("features.title2")}</span>
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed">
            {t("features.subtitle")}
          </p>
        </motion.div>

        {/* Features Grid */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-50px" }}
          className="grid md:grid-cols-2 lg:grid-cols-3 gap-4"
        >
          {featureItems.map((feature, index) => {
            const Icon = featureIcons[index];
            const color = featureColors[index];
            return (
              <motion.div
                key={feature.title}
                variants={itemVariants}
                className="group relative glass-card rounded-2xl p-6 hover:bg-[oklch(0.2_0.04_260_/_50%)] transition-all duration-500 hover:border-[oklch(0.45_0.06_260_/_30%)]"
              >
                {/* Gradient line at top */}
                <div className={`absolute top-0 left-6 right-6 h-px bg-gradient-to-r ${color} opacity-0 group-hover:opacity-60 transition-opacity duration-500`} />

                {/* Icon */}
                <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${color} flex items-center justify-center mb-4 transition-transform duration-300 group-hover:scale-110`}>
                  <Icon className="w-5 h-5 text-white/90" />
                </div>

                {/* Title + Badge */}
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="font-heading font-semibold text-lg text-foreground">
                    {feature.title}
                  </h3>
                  {feature.badge && (
                    <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-gradient-to-r from-amber/20 to-amber/10 text-amber border border-amber/20">
                      {feature.badge}
                    </span>
                  )}
                </div>

                {/* Description */}
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {feature.description}
                </p>
              </motion.div>
            );
          })}
        </motion.div>

        {/* ─── How It Works (統合セクション) ─── */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="mt-16 md:mt-20"
        >
          {/* Sub-header */}
          <div className="max-w-2xl mx-auto text-center mb-10 md:mb-12">
            <span className="text-sm font-semibold text-coral tracking-widest uppercase mb-4 block font-mono">
              {t("features.howItWorks.label")}
            </span>
            <h3 className="font-heading text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight mb-4">
              {t("features.howItWorks.title1")}
              <span className="text-gradient-primary">{t("features.howItWorks.title2")}</span>
            </h3>
            <p className="text-muted-foreground leading-relaxed">
              {t("features.howItWorks.subtitle")}
            </p>
          </div>

          {/* Steps */}
          <div className="relative">
            {/* Connection Line */}
            <div className="hidden lg:block absolute top-1/2 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-indigo/30 to-transparent -translate-y-1/2" />

            <div className="grid lg:grid-cols-3 gap-6">
              {stepItems.map((step, index) => {
                const StepIcon = stepIcons[index];
                const color = stepColors[index];
                const stepNum = String(index + 1).padStart(2, "0");
                return (
                  <motion.div
                    key={stepNum}
                    initial={{ opacity: 0, y: 40 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-50px" }}
                    transition={{ duration: 0.6, delay: index * 0.15 }}
                    className="relative group"
                  >
                    <div className={`glass-card rounded-2xl p-7 h-full transition-all duration-500 hover:bg-[oklch(0.2_0.04_260_/_50%)] ${color === "indigo"
                      ? "hover:border-indigo/40"
                      : color === "coral"
                        ? "hover:border-coral/40"
                        : "hover:border-amber/40"
                      }`}>
                      {/* Step Number */}
                      <div className={`font-mono text-5xl font-bold mb-5 select-none ${color === "indigo"
                        ? "text-indigo/30"
                        : color === "coral"
                          ? "text-coral/30"
                          : "text-amber/30"
                        }`}>
                        {stepNum}
                      </div>

                      {/* Icon */}
                      <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-5 ${color === "indigo"
                        ? "bg-indigo/15 text-indigo"
                        : color === "coral"
                          ? "bg-coral/15 text-coral"
                          : "bg-amber/15 text-amber"
                        }`}>
                        <StepIcon className="w-6 h-6" />
                      </div>

                      {/* Content */}
                      <h4 className="font-heading font-semibold text-xl text-foreground mb-2">
                        {step.title}
                      </h4>
                      <p className="text-muted-foreground leading-relaxed">
                        {step.description}
                      </p>
                    </div>

                    {/* Arrow between steps */}
                    {index < stepItems.length - 1 && (
                      <div className="hidden lg:flex absolute top-1/2 -right-3 -translate-y-1/2 z-10">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo/20 to-coral/20 border border-indigo/30 flex items-center justify-center shadow-lg shadow-indigo/10">
                          <ChevronRight className="w-4 h-4 text-indigo" />
                        </div>
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
