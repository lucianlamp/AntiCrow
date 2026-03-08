import Navbar from "@/components/Navbar";
import ParticleField from "@/components/ParticleField";
import HeroSection from "@/components/HeroSection";
import FeaturesSection from "@/components/FeaturesSection";
import SecuritySection from "@/components/SecuritySection";
import FAQSection from "@/components/FAQSection";
import DisclaimerSection from "@/components/DisclaimerSection";
import CTASection from "@/components/CTASection";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground relative">
      <ParticleField />
      <Navbar />
      <main className="relative z-10">
        <HeroSection />
        <FeaturesSection />
        <SecuritySection />
        <FAQSection />
        <DisclaimerSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}
