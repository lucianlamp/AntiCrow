import { motion } from "framer-motion";
import { Check, Sparkles } from "lucide-react";

const plans = [
  {
    name: "Free",
    price: "¥0",
    period: "/月",
    description: "個人利用に最適",
    features: [
      "Discord 遠隔操作",
      "リアルタイム通知",
      "1 ワークスペース",
      "基本メモリー機能",
    ],
    cta: "無料で始める",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "¥980",
    period: "/月",
    description: "パワーユーザー向け",
    features: [
      "Free の全機能",
      "エージェントチームモード",
      "自動承認",
      "無制限ワークスペース",
      "定期実行 (cron)",
      "優先サポート",
    ],
    cta: "Pro を始める",
    highlighted: true,
  },
  {
    name: "Team",
    price: "¥2,980",
    period: "/月",
    description: "チーム開発に",
    features: [
      "Pro の全機能",
      "チームメンバー管理",
      "共有ワークスペース",
      "監査ログ",
      "カスタムインテグレーション",
      "専用サポート",
    ],
    cta: "お問い合わせ",
    highlighted: false,
  },
];

export default function PricingSection() {
  return (
    <section id="pricing" className="relative py-24 md:py-32 overflow-hidden">
      <div className="container relative z-10">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-14 md:mb-20"
        >
          <span className="text-sm font-semibold text-coral tracking-widest uppercase mb-4 block font-mono">
            Pricing
          </span>
          <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight mb-5">
            シンプルな
            <span className="text-gradient-primary">料金プラン</span>
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-lg mx-auto">
            あなたのニーズに合ったプランを選んで、
            今すぐ始めましょう。
          </p>
        </motion.div>

        {/* Plans Grid */}
        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {plans.map((plan, index) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.6, delay: index * 0.12 }}
              className={`relative group rounded-2xl p-7 transition-all duration-500 ${
                plan.highlighted
                  ? "glass-card border-indigo/40 glow-indigo scale-[1.02]"
                  : "glass-card hover:bg-[oklch(0.2_0.04_260_/_50%)]"
              }`}
            >
              {/* Popular Badge */}
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1 rounded-full bg-gradient-to-r from-indigo to-coral text-white text-xs font-semibold">
                  <Sparkles className="w-3 h-3" />
                  人気
                </div>
              )}

              {/* Plan Header */}
              <div className="mb-6">
                <h3 className="font-heading font-bold text-lg text-foreground mb-1">
                  {plan.name}
                </h3>
                <p className="text-sm text-muted-foreground mb-4">{plan.description}</p>
                <div className="flex items-baseline gap-1">
                  <span className="font-heading text-4xl font-extrabold text-foreground">
                    {plan.price}
                  </span>
                  <span className="text-sm text-muted-foreground">{plan.period}</span>
                </div>
              </div>

              {/* Features */}
              <ul className="space-y-3 mb-8">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5 text-sm">
                    <Check className={`w-4 h-4 mt-0.5 shrink-0 ${
                      plan.highlighted ? "text-indigo" : "text-muted-foreground"
                    }`} />
                    <span className="text-foreground/80">{feature}</span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <button
                className={`w-full py-3 rounded-xl font-semibold text-sm transition-all hover:scale-[1.02] active:scale-[0.98] ${
                  plan.highlighted
                    ? "bg-gradient-to-r from-indigo to-coral text-white"
                    : "glass-card text-foreground hover:bg-[oklch(0.25_0.04_260_/_60%)]"
                }`}
              >
                {plan.cta}
              </button>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
