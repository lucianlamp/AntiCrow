import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export function Header() {
    const { t, i18n } = useTranslation();
    const [scrolled, setScrolled] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);

    useEffect(() => {
        const handleScroll = () => setScrolled(window.scrollY > 20);
        window.addEventListener('scroll', handleScroll, { passive: true });
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const toggleLang = useCallback(() => {
        const next = i18n.language?.startsWith('ja') ? 'en' : 'ja';
        i18n.changeLanguage(next);
    }, [i18n]);

    const isJa = i18n.language?.startsWith('ja');

    return (
        <header
            className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${scrolled
                ? 'bg-dark-900/80 backdrop-blur-xl'
                : 'bg-transparent'
                }`}
        >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex items-center justify-between h-16">
                    {/* Logo */}
                    <a href="#" className="flex items-center gap-2 text-xl font-bold text-white">
                        <span className="text-2xl">🐦‍⬛</span>
                        <span className="gradient-text">AntiCrow</span>
                    </a>

                    {/* Desktop Nav */}
                    <nav className="hidden md:flex items-center gap-8">
                        <a href="#features" className="text-gray-400 hover:text-white transition-colors text-sm font-medium">
                            {t('header.features')}
                        </a>
                        <a href="#how-it-works" className="text-gray-400 hover:text-white transition-colors text-sm font-medium">
                            {t('header.howItWorks')}
                        </a>

                        <a href="#faq" className="text-gray-400 hover:text-white transition-colors text-sm font-medium">
                            {t('header.faq')}
                        </a>
                    </nav>

                    {/* Lang toggle + mobile menu */}
                    <div className="flex items-center gap-3">
                        <button
                            onClick={toggleLang}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-white/5 hover:bg-white/10 border border-white/10 hover:border-purple-500/30 transition-all cursor-pointer"
                            aria-label="Toggle language"
                        >
                            <span>{isJa ? '🇯🇵' : '🇬🇧'}</span>
                            <span className="text-gray-300">{isJa ? 'JP' : 'EN'}</span>
                        </button>

                        {/* Mobile hamburger */}
                        <button
                            onClick={() => setMenuOpen(!menuOpen)}
                            className="md:hidden text-gray-400 hover:text-white p-2 cursor-pointer"
                            aria-label="Toggle menu"
                        >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                {menuOpen ? (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                ) : (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                                )}
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Mobile Nav */}
                {menuOpen && (
                    <nav className="md:hidden pb-4 flex flex-col gap-3">
                        <a href="#features" onClick={() => setMenuOpen(false)} className="text-gray-400 hover:text-white text-sm font-medium py-2">
                            {t('header.features')}
                        </a>
                        <a href="#how-it-works" onClick={() => setMenuOpen(false)} className="text-gray-400 hover:text-white text-sm font-medium py-2">
                            {t('header.howItWorks')}
                        </a>

                        <a href="#faq" onClick={() => setMenuOpen(false)} className="text-gray-400 hover:text-white text-sm font-medium py-2">
                            {t('header.faq')}
                        </a>
                    </nav>
                )}
            </div>
        </header>
    );
}
