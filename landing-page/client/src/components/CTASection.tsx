import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";

export default function CTASection() {
  return (
    <section className="relative py-24 md:py-32 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 z-0">
        <img
          src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/cta-bg-NPUEKsdbVBiekvD9nk3V6H.webp"
          alt=""
          className="w-full h-full object-cover opacity-25"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background via-background/50 to-background" />
      </div>

      <div className="container relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.7 }}
          className="max-w-3xl mx-auto text-center"
        >
          <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl xl:text-6xl font-bold tracking-tight mb-5">
            どこからでも
            <br />
            <span className="text-gradient-primary">コーディング</span>する
            <br />
            準備はできた？
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed mb-8 max-w-lg mx-auto">
            AntiCrow で、あなたの AI コーディング体験を次のレベルへ。
            クローズドベータのウェイトリストに登録して、いち早くアクセスを手に入れよう。
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="#waitlist"
              className="group relative inline-flex items-center gap-3 px-8 py-4 rounded-xl font-semibold text-base overflow-hidden transition-all hover:scale-[1.03] active:scale-[0.98]"
            >
              <span className="absolute inset-0 bg-gradient-to-r from-indigo to-coral" />
              <span className="relative text-white">AntiCrow を入手</span>
              <ArrowRight className="relative w-5 h-5 text-white transition-transform group-hover:translate-x-1" />
            </a>
            <a
              href="https://anticrow.gitbook.io/anticrow-docs/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-4 rounded-xl font-semibold text-sm text-muted-foreground hover:text-foreground glass-card hover:bg-[oklch(0.22_0.04_260_/_60%)] transition-all"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
              </svg>
              ドキュメント
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
