import { motion } from "framer-motion";
import { AlertTriangle, ShieldAlert, ShieldCheck, Code2, KeyRound } from "lucide-react";

const risks = [
  {
    icon: ShieldAlert,
    title: "自動操作のリスク",
    titleEn: "Automated Operation Risks",
    description:
      "Antigravity の AI による自動操作は、意図しないファイルの変更・削除を引き起こす可能性があります。",
    descriptionEn:
      "Antigravity's AI-driven automation may cause unintended file modifications or deletions.",
  },
  {
    icon: Code2,
    title: "コード変更リスク",
    titleEn: "Code Modification Risks",
    description:
      "Antigravity の AI が自動生成・自動編集したコードが、既存のコードベースを破壊する可能性があります。",
    descriptionEn:
      "Code auto-generated or auto-edited by Antigravity's AI may break your existing codebase.",
  },
  {
    icon: KeyRound,
    title: "API キーの取り扱い",
    titleEn: "API Key Handling",
    description:
      "AntiCrow は API キーの露出を防ぐ設計ですが、Antigravity の AI の判断により、キーが意図しない形で使用される可能性があります。",
    descriptionEn:
      "AntiCrow is designed to prevent API key exposure, but Antigravity's AI judgment may use keys in unintended ways.",
  },
];

export default function DisclaimerSection() {
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
              Disclaimer
            </span>
            <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
              ご利用前に
              <span className="text-destructive">ご確認</span>ください
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
                  🛡️ AntiCrow の安全性
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  AntiCrow 拡張機能自体には、<strong className="text-foreground">悪意のある操作や破壊的な操作は一切含まれていません</strong>。
                  API キーやシークレット情報を外部に露出させるような仕組みも排除するよう設計しています。
                  AntiCrow は Discord からの指示を Antigravity に中継する役割を担っています。
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
                  ⚠️ Antigravity 由来のリスクについて
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  AntiCrow が連携する <strong className="text-foreground">Antigravity（AI コーディングエディタ）</strong>の仕様として、
                  AI の判断によりファイル操作や外部サービスへのリクエスト送信など、
                  ユーザーの意図しないアクションが実行される可能性があります。
                  <strong className="text-foreground">これらのリスクは AntiCrow 側の問題ではなく、Antigravity 本体の仕様に起因します。</strong>
                  ご利用は全て<strong className="text-foreground">自己責任</strong>となります。
                </p>
              </div>
            </div>
          </motion.div>

          {/* Risk cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
            {risks.map((risk, index) => (
              <motion.div
                key={risk.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ duration: 0.5, delay: 0.15 + index * 0.1 }}
                className="glass-card rounded-xl p-6 border-destructive/20 hover:border-destructive/40 transition-all duration-500"
              >
                <div className="w-10 h-10 rounded-lg bg-destructive/10 flex items-center justify-center mb-4">
                  <risk.icon className="w-5 h-5 text-destructive" />
                </div>
                <h3 className="font-heading font-semibold text-foreground mb-2">
                  {risk.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {risk.description}
                </p>
              </motion.div>
            ))}
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
              開発者は、本拡張機能および連携先の Antigravity の使用により生じたいかなる損害（データの損失、
              コードの破損、セキュリティ侵害、業務の中断、その他の直接的・間接的損害を含むが
              これらに限定されない）についても、一切の責任を負いません。
              Antigravity の AI による自律的な判断に起因するリスクについても同様です。
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              本拡張機能は「現状のまま（AS IS）」で提供されます。
              明示的・黙示的を問わず、商品性、特定目的への適合性、権利非侵害の保証を含む
              一切の保証をいたしません。
            </p>
            <p className="text-xs text-muted-foreground/70 leading-relaxed">
              The AntiCrow extension itself contains no malicious or destructive code. However, risks
              arising from Antigravity&apos;s AI-driven autonomous actions are inherent to the Antigravity
              platform, not AntiCrow. The developer assumes no liability for any damages arising from
              the use of this extension or the connected Antigravity platform. This extension is
              provided &quot;AS IS&quot; without warranty of any kind.
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
