import { motion } from "framer-motion";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useTranslation } from "react-i18next";

export default function FAQSection() {
  const { t } = useTranslation();
  const faqItems = t("faq.items", { returnObjects: true }) as Array<{ question: string; answer: string }>;

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
              {t("faq.label")}
            </span>
            <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
              {t("faq.title1")}
              <span className="text-gradient-primary">{t("faq.title2")}</span>
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
              {faqItems.map((faq, index) => (
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
