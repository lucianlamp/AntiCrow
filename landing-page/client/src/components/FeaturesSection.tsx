import { motion } from "framer-motion";
import { Smartphone, Clock, Users, Zap, Brain, FolderOpen } from "lucide-react";

const features = [
  {
    icon: Smartphone,
    title: "スマホから遠隔操作",
    description: "外出先でも Discord からタスクを依頼できる",
    color: "from-indigo to-indigo/60",
  },
  {
    icon: Clock,
    title: "定期実行",
    description: "cron 式で毎日・毎週の自動タスクを登録",
    color: "from-coral to-coral/60",
  },
  {
    icon: Users,
    title: "エージェントチームモード",
    description: "複数 AI が並列でタスクを高速実行",
    badge: "Pro",
    color: "from-amber to-amber/60",
  },
  {
    icon: Zap,
    title: "自動承認",
    description: "遠隔実行中の確認ダイアログを自動クリック",
    badge: "Pro",
    color: "from-indigo to-coral",
  },
  {
    icon: Brain,
    title: "メモリー",
    description: "過去の学びを記憶して次のタスクに活かす",
    color: "from-coral to-indigo",
  },
  {
    icon: FolderOpen,
    title: "複数WS対応",
    description: "プロジェクトごとに Discord チャンネルを自動作成",
    color: "from-amber to-indigo",
  },
];

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
            Features
          </span>
          <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight mb-5">
            あなたのワークフローを
            <br />
            <span className="text-gradient-primary">加速させる機能</span>
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed">
            Discord を起点に、AI コーディングの全てをコントロール。
            スマホひとつで、どこからでも。
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
          {features.map((feature) => (
            <motion.div
              key={feature.title}
              variants={itemVariants}
              className="group relative glass-card rounded-2xl p-6 hover:bg-[oklch(0.2_0.04_260_/_50%)] transition-all duration-500 hover:border-[oklch(0.45_0.06_260_/_30%)]"
            >
              {/* Gradient line at top */}
              <div className={`absolute top-0 left-6 right-6 h-px bg-gradient-to-r ${feature.color} opacity-0 group-hover:opacity-60 transition-opacity duration-500`} />

              {/* Icon */}
              <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${feature.color} flex items-center justify-center mb-4 transition-transform duration-300 group-hover:scale-110`}>
                <feature.icon className="w-5 h-5 text-white/90" />
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
          ))}
        </motion.div>
      </div>
    </section>
  );
}
