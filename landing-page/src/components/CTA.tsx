import { useTranslation } from 'react-i18next';
import { useInView } from '../hooks/useInView';

export function CTA() {
    const { t } = useTranslation();
    const { ref, isVisible } = useInView();

    return (
        <section className="py-20 sm:py-28 px-4 relative" ref={ref}>
            {/* Gradient mesh background */}
            <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-purple-900/10 to-purple-900/20"></div>
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-purple-700/15 rounded-full blur-3xl"></div>
            </div>
            <div className={`relative z-10 max-w-2xl mx-auto text-center fade-in ${isVisible ? 'visible' : ''}`}>
                <h2 className="text-3xl sm:text-4xl font-bold mb-6 text-white">
                    {t('cta.title')}
                </h2>
                <a
                    href="#"
                    className="btn-primary inline-block text-lg px-10 py-4"
                    onClick={(e) => {
                        e.preventDefault();
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                >
                    {t('cta.button')}
                </a>
            </div>
        </section>
    );
}
