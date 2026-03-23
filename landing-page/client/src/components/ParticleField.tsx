import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  opacity: number;
  color: string;
}

export default function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId: number;
    let lastFrameTime = 0;
    const TARGET_FPS = 30;
    const FRAME_INTERVAL = 1000 / TARGET_FPS;
    const particles: Particle[] = [];
    const CONNECTION_DIST_SQ = 100 * 100; // 距離の2乗で比較（sqrt排除）
    const colors = [
      "rgba(99, 102, 241, ",   // indigo
      "rgba(244, 114, 182, ",  // coral
      "rgba(245, 158, 11, ",   // amber
      "rgba(139, 92, 246, ",   // violet
    ];

    // デバウンス付きリサイズ
    let resizeTimer: ReturnType<typeof setTimeout>;
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
      }, 150);
    };

    // 初回は即座にリサイズ
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const createParticles = () => {
      // 粒子数を削減（最大50）
      const count = Math.min(Math.floor(window.innerWidth / 20), 50);
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          size: Math.random() * 2 + 0.5,
          opacity: Math.random() * 0.5 + 0.1,
          color: colors[Math.floor(Math.random() * colors.length)],
        });
      }
    };

    const animate = (timestamp: number) => {
      animationId = requestAnimationFrame(animate);

      // FPS制限（30fps）
      const elapsed = timestamp - lastFrameTime;
      if (elapsed < FRAME_INTERVAL) return;
      lastFrameTime = timestamp - (elapsed % FRAME_INTERVAL);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // パーティクル移動＆描画
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color + p.opacity + ")";
        ctx.fill();
      }

      // 接続描画（sqrt排除 → 距離の2乗で比較）
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const distSq = dx * dx + dy * dy;
          if (distSq < CONNECTION_DIST_SQ) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(99, 102, 241, ${0.06 * (1 - distSq / CONNECTION_DIST_SQ)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }
    };

    createParticles();
    animationId = requestAnimationFrame(animate);

    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animationId);
      clearTimeout(resizeTimer);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-0"
      style={{ opacity: 0.6, willChange: "transform" }}
    />
  );
}
