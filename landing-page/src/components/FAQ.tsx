import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInView } from '../hooks/useInView';

interface FAQItem {
    question: string;
    answer: string;
}

export function FAQ() {
    const { t } = useTranslation();
    const { ref, isVisible } = useInView();
    const items = t('faq.items', { returnObjects: true }) as FAQItem[];
    const [openIndex, setOpenIndex] = useState<number | null>(null);

    return (
        <section id="faq" className="py-20 sm:py-28 px-4" ref={ref}>
            <div className="max-w-3xl mx-auto">
                <h2 className={`text-3xl sm:text-4xl font-bold text-center mb-14 fade-in ${isVisible ? 'visible' : ''}`}>
                    <span className="gradient-text">{t('faq.title')}</span>
                </h2>
                <div className="space-y-3">
                    {items.map((item, i) => (
                        <div
                            key={i}
                            className={`glass-card overflow-hidden fade-in stagger-${i + 1} ${isVisible ? 'visible' : ''}`}
                        >
                            <button
                                onClick={() => setOpenIndex(openIndex === i ? null : i)}
                                className="w-full flex items-center justify-between p-5 text-left cursor-pointer"
                            >
                                <span className="text-white font-medium pr-4">{item.question}</span>
                                <span className={`text-purple-400 text-xl transition-transform duration-300 flex-shrink-0 ${openIndex === i ? 'rotate-45' : ''
                                    }`}>
                                    +
                                </span>
                            </button>
                            <div
                                className={`overflow-hidden transition-all duration-300 ${openIndex === i ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'
                                    }`}
                            >
                                <p className="px-5 pb-5 text-gray-400 text-sm leading-relaxed">{item.answer}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
