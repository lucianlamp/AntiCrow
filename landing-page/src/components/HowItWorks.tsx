import { useTranslation } from 'react-i18next';
import { useInView } from '../hooks/useInView';

interface Step {
    icon: string;
    title: string;
    description: string;
}

export function HowItWorks() {
    const { t } = useTranslation();
    const { ref, isVisible } = useInView();
    const steps = t('howItWorks.steps', { returnObjects: true }) as Step[];

    return (
        <section id="how-it-works" className="py-20 sm:py-28 px-4" ref={ref}>
            <div className="max-w-5xl mx-auto">
                <h2 className={`text-3xl sm:text-4xl font-bold text-center mb-14 fade-in ${isVisible ? 'visible' : ''}`}>
                    <span className="gradient-text">{t('howItWorks.title')}</span>
                </h2>
                <div className="flex flex-col md:flex-row items-center md:items-start gap-6 md:gap-4">
                    {steps.map((step, i) => (
                        <div key={i} className="flex flex-col md:flex-row items-center gap-4 md:gap-0 flex-1">
                            <div className={`glass-card p-6 text-center flex-1 w-full fade-in stagger-${i + 1} ${isVisible ? 'visible' : ''}`}>
                                <div className="w-12 h-12 rounded-full bg-purple-700/20 border border-purple-500/30 flex items-center justify-center text-xl mx-auto mb-4">
                                    {step.icon}
                                </div>
                                <div className="text-xs text-purple-400 font-mono mb-2">STEP {i + 1}</div>
                                <h3 className="text-lg font-semibold text-white mb-2">{step.title}</h3>
                                <p className="text-gray-400 text-sm leading-relaxed">{step.description}</p>
                            </div>
                            {i < steps.length - 1 && (
                                <div className="hidden md:flex items-center justify-center w-12 text-purple-500 text-2xl font-bold flex-shrink-0">
                                    →
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
