export default function Footer() {
  return (
    <footer className="relative border-t border-[oklch(0.25_0.03_260_/_40%)] py-12">
      <div className="container">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <img
              src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/AntiCrowIcon_ec2d4d08.png"
              alt="AntiCrow"
              className="w-7 h-7"
            />
            <span className="font-heading font-bold text-foreground">AntiCrow</span>
          </div>

          {/* Links */}
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">機能</a>
            <a href="#how-it-works" className="hover:text-foreground transition-colors">使い方</a>
            <a href="#security" className="hover:text-foreground transition-colors">セキュリティ</a>
            <a href="#faq" className="hover:text-foreground transition-colors">FAQ</a>
            <span className="text-[oklch(0.35_0.02_260)]">|</span>
            <a href="/docs/ja/privacy" className="hover:text-foreground transition-colors">プライバシーポリシー</a>
            <a href="/docs/ja/security" className="hover:text-foreground transition-colors">セキュリティポリシー</a>
          </div>

          {/* Copyright */}
          <p className="text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} AntiCrow. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
