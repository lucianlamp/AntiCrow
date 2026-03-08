import { motion } from "framer-motion";
import { MessageSquare, Bot, CheckCircle2 } from "lucide-react";

const steps = [
  {
    step: "01",
    icon: MessageSquare,
    title: "メッセージを送る",
    description: "Discord に依頼を入力 — スマホ、タブレット、PC どこからでも",
    color: "indigo",
  },
  {
    step: "02",
    icon: Bot,
    title: "AI が実行",
    description: "AntiCrow が PC 上の Antigravity にタスクを橋渡し",
    color: "coral",
  },
  {
    step: "03",
    icon: CheckCircle2,
    title: "結果を受け取る",
    description: "リアルタイムの進捗通知と共に結果が Discord に届く",
    color: "amber",
  },
];

export default function HowItWorksSection() {
  return (
    <section id="how-it-works" className="relative py-24 md:py-32 overflow-hidden">
      <div className="container relative z-10">
        {/* Section Header — right aligned for asymmetry */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="max-w-2xl ml-auto text-right mb-14 md:mb-20"
        >
          <span className="text-sm font-semibold text-coral tracking-widest uppercase mb-4 block font-mono">
            How it works
          </span>
          <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight mb-5">
            <span className="text-gradient-primary">3ステップ</span>で
            <br />
            始められる
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed">
            複雑な設定は不要。Discord Bot を追加するだけで、
            すぐにAIコーディングを遠隔操作できます。
          </p>
        </motion.div>

        {/* Steps */}
        <div className="relative">
          {/* Connection Line */}
          <div className="hidden lg:block absolute top-1/2 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[oklch(0.35_0.04_260_/_40%)] to-transparent -translate-y-1/2" />

          <div className="grid lg:grid-cols-3 gap-6">
            {steps.map((step, index) => (
              <motion.div
                key={step.step}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ duration: 0.6, delay: index * 0.15 }}
                className="relative group"
              >
                <div className="glass-card rounded-2xl p-7 h-full transition-all duration-500 hover:bg-[oklch(0.2_0.04_260_/_50%)] hover:border-[oklch(0.45_0.06_260_/_30%)]">
                  {/* Step Number */}
                  <div className="font-mono text-5xl font-bold text-[oklch(0.25_0.03_260)] mb-5 select-none">
                    {step.step}
                  </div>

                  {/* Icon */}
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-5 ${
                    step.color === "indigo"
                      ? "bg-indigo/15 text-indigo"
                      : step.color === "coral"
                      ? "bg-coral/15 text-coral"
                      : "bg-amber/15 text-amber"
                  }`}>
                    <step.icon className="w-6 h-6" />
                  </div>

                  {/* Content */}
                  <h3 className="font-heading font-semibold text-xl text-foreground mb-2">
                    {step.title}
                  </h3>
                  <p className="text-muted-foreground leading-relaxed">
                    {step.description}
                  </p>
                </div>

                {/* Arrow between steps */}
                {index < steps.length - 1 && (
                  <div className="hidden lg:flex absolute top-1/2 -right-3 -translate-y-1/2 z-10">
                    <div className="w-6 h-6 rounded-full bg-[oklch(0.22_0.04_260)] border border-[oklch(0.35_0.04_260_/_40%)] flex items-center justify-center">
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M3 1L7 5L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-muted-foreground" />
                      </svg>
                    </div>
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
