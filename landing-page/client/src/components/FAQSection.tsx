import { motion } from "framer-motion";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const faqs = [
  {
    question: "外出先からも使える？",
    answer:
      "Discord さえ使えればどこからでも。PC がオンラインであれば OK です。スマホ、タブレット、別の PC — どのデバイスからでも Discord 経由でタスクを依頼できます。",
  },
  {
    question: "Bot Token は安全？",
    answer:
      "SecretStorage で暗号化保存されます。設定ファイルに平文記録されることはありません。また、Token はローカル環境でのみ使用され、外部サーバーに送信されることはありません。",
  },
  {
    question: "複数プロジェクトを同時に管理できる？",
    answer:
      "自動で Discord カテゴリーが作られ、プロジェクトごとに独立管理できます。各プロジェクトには専用のチャンネルが割り当てられ、タスクの進捗や結果が整理されます。",
  },
  {
    question: "Pro トライアルはある？",
    answer:
      "14日間無料でお試し可能です。エージェントチームモードや自動承認など、Pro 限定の機能をすべてお試しいただけます。",
  },
  {
    question: "Antigravity 以外の AI ツールにも対応する？",
    answer:
      "現在は Antigravity に特化していますが、今後のアップデートで他の AI コーディングツールへの対応も予定しています。ウェイトリストに登録いただくと、最新情報をお届けします。",
  },
];

export default function FAQSection() {
  return (
    <section id="faq" className="relative py-24 md:py-32 overflow-hidden">
      <div className="container relative z-10">
        <div className="max-w-3xl mx-auto">
          {/* Section Header */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
            className="text-center mb-12"
          >
            <span className="text-sm font-semibold text-indigo tracking-widest uppercase mb-4 block font-mono">
              FAQ
            </span>
            <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
              よくある
              <span className="text-gradient-primary">質問</span>
            </h2>
          </motion.div>

          {/* FAQ Items */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <Accordion type="single" collapsible className="space-y-3">
              {faqs.map((faq, index) => (
                <AccordionItem
                  key={index}
                  value={`item-${index}`}
                  className="glass-card rounded-xl px-6 border-none data-[state=open]:bg-[oklch(0.2_0.04_260_/_50%)] transition-colors duration-300"
                >
                  <AccordionTrigger className="text-left font-heading font-semibold text-foreground hover:text-indigo transition-colors py-5 hover:no-underline">
                    {faq.question}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground leading-relaxed pb-5">
                    {faq.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
