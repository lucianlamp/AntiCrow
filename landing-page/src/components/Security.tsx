import { useTranslation } from 'react-i18next';
import { useInView } from '../hooks/useInView';

interface SecurityItem {
    icon: string;
    title: string;
    description: string;
}

export function Security() {
    const { t } = useTranslation();
    const { ref, isVisible } = useInView();
    const items = t('security.items', { returnObjects: true }) as SecurityItem[];

    return (
        <section className="py-20 sm:py-28 px-4" ref={ref}>
            <div className="max-w-5xl mx-auto">
                <h2 className={`text-3xl sm:text-4xl font-bold text-center mb-14 fade-in ${isVisible ? 'visible' : ''}`}>
                    <span className="gradient-text">{t('security.title')}</span>
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    {items.map((item, i) => (
                        <div
                            key={i}
                            className={`glass-card p-6 text-center fade-in stagger-${i + 1} ${isVisible ? 'visible' : ''}`}
                        >
                            <div className="text-3xl mb-3">{item.icon}</div>
                            <h3 className="text-base font-semibold text-white mb-2">{item.title}</h3>
                            <p className="text-gray-400 text-sm leading-relaxed">{item.description}</p>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
