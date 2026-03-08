import { motion } from "framer-motion";
import { Shield, Lock, UserCheck, BarChart3 } from "lucide-react";

const securityItems = [
  {
    icon: Shield,
    title: "ローカル処理",
    description: "すべての処理は PC 上で完結。外部サーバーにデータ送信なし。",
  },
  {
    icon: Lock,
    title: "暗号化保存",
    description: "Bot Token は SecretStorage で暗号化保存。",
  },
  {
    icon: UserCheck,
    title: "アクセス制御",
    description: "ユーザー ID ベースのアクセス制御。",
  },
  {
    icon: BarChart3,
    title: "テレメトリなし",
    description: "テレメトリ・使用統計の収集なし。",
  },
];

export default function SecuritySection() {
  return (
    <section id="security" className="relative py-24 md:py-32 overflow-hidden">
      <div className="container relative z-10">
        <div className="grid lg:grid-cols-5 gap-12 items-center">
          {/* Left: Illustration — 2 cols */}
          <motion.div
            initial={{ opacity: 0, x: -40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.7 }}
            className="lg:col-span-2 relative flex items-center justify-center"
          >
            <div className="absolute w-[260px] h-[260px] rounded-full bg-indigo/10 blur-[60px]" />
            <img
              src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/security-illustration-6rbBhKscJBXWnSucEzbT3B.webp"
              alt="Security"
              className="relative w-full max-w-sm rounded-2xl"
            />
          </motion.div>

          {/* Right: Content — 3 cols */}
          <div className="lg:col-span-3">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.6 }}
            >
              <span className="text-sm font-semibold text-amber tracking-widest uppercase mb-4 block font-mono">
                Security
              </span>
              <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight mb-5">
                セキュリティ &
                <br />
                <span className="text-gradient-amber">プライバシー</span>
              </h2>
              <p className="text-lg text-muted-foreground leading-relaxed mb-8">
                あなたのデータは、あなたの PC から出ません。
                完全ローカル処理で、安心して使えます。
              </p>
            </motion.div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {securityItems.map((item, index) => (
                <motion.div
                  key={item.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-50px" }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                  className="group glass-card rounded-xl p-5 hover:bg-[oklch(0.2_0.04_260_/_50%)] transition-all duration-500"
                >
                  <div className="w-10 h-10 rounded-lg bg-amber/10 flex items-center justify-center mb-3 group-hover:bg-amber/20 transition-colors">
                    <item.icon className="w-5 h-5 text-amber" />
                  </div>
                  <h3 className="font-heading font-semibold text-foreground mb-1.5">
                    {item.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {item.description}
                  </p>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
