import './i18n';
import './index.css';
import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { Features } from './components/Features';
import { HowItWorks } from './components/HowItWorks';
import { Pricing } from './components/Pricing';
import { Security } from './components/Security';
import { FAQ } from './components/FAQ';
import { CTA } from './components/CTA';
import { Footer } from './components/Footer';

function App() {
    return (
        <div className="min-h-screen">
            <Header />
            <main>
                <Hero />
                <Features />
                <HowItWorks />
                <Pricing />
                <Security />
                <FAQ />
                <CTA />
            </main>
            <Footer />
        </div>
    );
}

export default App;
