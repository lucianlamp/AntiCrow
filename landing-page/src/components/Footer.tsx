import { useTranslation } from 'react-i18next';

export function Footer() {
    const { t } = useTranslation();

    return (
        <footer className="py-12 px-4 border-t border-white/5">
            <div className="max-w-6xl mx-auto">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
                    {/* Logo */}
                    <div className="flex items-center gap-2 text-lg font-bold text-white">
                        <span className="text-xl">🐦‍⬛</span>
                        <span className="gradient-text">AntiCrow</span>
                    </div>

                    {/* Links */}
                    <div className="flex items-center gap-6 text-sm text-gray-500">
                        <a
                            href="https://github.com/lucianlamp"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-gray-300 transition-colors"
                        >
                            GitHub
                        </a>
                        <a
                            href="https://x.com/lucianlamp"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-gray-300 transition-colors"
                        >
                            X (Twitter)
                        </a>

                    </div>
                </div>

                <div className="mt-8 text-center space-y-2">
                    <p className="text-gray-500 text-sm">{t('footer.madeWith')}</p>
                    <p className="text-gray-600 text-xs">{t('footer.copyright')}</p>
                </div>
            </div>
        </footer>
    );
}
