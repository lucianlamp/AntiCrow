import { useTranslation } from 'react-i18next';
import { useInView } from '../hooks/useInView';

export function Pricing() {
    const { t } = useTranslation();
    const { ref, isVisible } = useInView();

    const freeFeatures = t('pricing.free.features', { returnObjects: true }) as string[];
    const proFeatures = t('pricing.pro.features', { returnObjects: true }) as string[];

    return (
        <section id="pricing" className="py-20 sm:py-28 px-4" ref={ref}>
            <div className="max-w-4xl mx-auto">
                <h2 className={`text-3xl sm:text-4xl font-bold text-center mb-14 fade-in ${isVisible ? 'visible' : ''}`}>
                    <span className="gradient-text">{t('pricing.title')}</span>
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Free */}
                    <div className={`glass-card p-8 fade-in stagger-1 ${isVisible ? 'visible' : ''}`}>
                        <h3 className="text-xl font-bold text-white mb-1">{t('pricing.free.name')}</h3>
                        <div className="flex items-baseline gap-1 mb-1">
                            <span className="text-4xl font-extrabold text-white">{t('pricing.free.price')}</span>
                        </div>
                        <p className="text-gray-500 text-sm mb-6">{t('pricing.free.period')}</p>
                        <ul className="space-y-3 mb-8">
                            {freeFeatures.map((feat, i) => (
                                <li key={i} className="text-gray-300 text-sm flex items-start gap-2">
                                    <span className="text-purple-400 mt-0.5">•</span>
                                    {feat}
                                </li>
                            ))}
                        </ul>
                        <button className="btn-secondary w-full">{t('pricing.free.button')}</button>
                    </div>

                    {/* Pro */}
                    <div className={`glass-card p-8 border-purple-500/40 relative overflow-hidden fade-in stagger-2 ${isVisible ? 'visible' : ''}`}
                        style={{ borderColor: 'rgba(168, 85, 247, 0.4)' }}>
                        {/* Pro badge */}
                        <div className="absolute top-4 right-4 bg-purple-700/40 text-purple-300 text-xs font-bold px-3 py-1 rounded-full border border-purple-500/30">
                            RECOMMENDED
                        </div>
                        <h3 className="text-xl font-bold text-white mb-1">{t('pricing.pro.name')}</h3>
                        <div className="flex items-baseline gap-1 mb-1">
                            <span className="text-4xl font-extrabold gradient-text">{t('pricing.pro.price')}</span>
                        </div>
                        <p className="text-gray-500 text-sm mb-6">{t('pricing.pro.period')}</p>
                        <ul className="space-y-3 mb-8">
                            {proFeatures.map((feat, i) => (
                                <li key={i} className="text-gray-300 text-sm flex items-start gap-2">
                                    <span className="text-purple-400 mt-0.5">•</span>
                                    {feat}
                                </li>
                            ))}
                        </ul>
                        <button className="btn-primary w-full">{t('pricing.pro.button')}</button>
                    </div>
                </div>
            </div>
        </section>
    );
}
