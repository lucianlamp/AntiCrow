// ぷにぷにタウン — Web Audio API サウンドマネージャー
// ポップなSE（タップ音、ガチャ音、獲得ファンファーレ）とBGM生成

export class SoundManager {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private bgmGain: GainNode | null = null;
    private seGain: GainNode | null = null;
    private bgmPlaying = false;
    private bgmOscillators: OscillatorNode[] = [];
    private muted = false;

    constructor() {
        // AudioContextはユーザー操作後に初期化
    }

    private ensureContext(): AudioContext {
        if (!this.ctx) {
            this.ctx = new AudioContext();
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0.3;
            this.masterGain.connect(this.ctx.destination);

            this.bgmGain = this.ctx.createGain();
            this.bgmGain.gain.value = 0.15;
            this.bgmGain.connect(this.masterGain);

            this.seGain = this.ctx.createGain();
            this.seGain.gain.value = 0.5;
            this.seGain.connect(this.masterGain);
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
        return this.ctx;
    }

    toggleMute(): boolean {
        this.muted = !this.muted;
        if (this.masterGain) {
            this.masterGain.gain.value = this.muted ? 0 : 0.3;
        }
        return this.muted;
    }

    // タップ音: ぽよん
    playTap(): void {
        if (this.muted) return;
        const ctx = this.ensureContext();
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(400, now + 0.15);
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        osc.connect(gain);
        gain.connect(this.seGain!);
        osc.start(now);
        osc.stop(now + 0.2);

        // サブトーン
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(1200, now);
        osc2.frequency.exponentialRampToValueAtTime(600, now + 0.1);
        gain2.gain.setValueAtTime(0.2, now);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc2.connect(gain2);
        gain2.connect(this.seGain!);
        osc2.start(now);
        osc2.stop(now + 0.12);
    }

    // コイン獲得音
    playCoin(): void {
        if (this.muted) return;
        const ctx = this.ensureContext();
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1047, now); // C6
        osc.frequency.setValueAtTime(1319, now + 0.06); // E6
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc.connect(gain);
        gain.connect(this.seGain!);
        osc.start(now);
        osc.stop(now + 0.15);
    }

    // ガチャ回転音
    playGachaSpin(): void {
        if (this.muted) return;
        const ctx = this.ensureContext();
        const now = ctx.currentTime;

        for (let i = 0; i < 6; i++) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            const t = now + i * 0.08;
            osc.frequency.setValueAtTime(300 + i * 100, t);
            gain.gain.setValueAtTime(0.15, t);
            gain.gain.exponentialRampToValueAtTime(0.01, t + 0.06);
            osc.connect(gain);
            gain.connect(this.seGain!);
            osc.start(t);
            osc.stop(t + 0.06);
        }
    }

    // ガチャ開封音
    playGachaOpen(): void {
        if (this.muted) return;
        const ctx = this.ensureContext();
        const now = ctx.currentTime;

        // パカッ
        const noise = ctx.createOscillator();
        const nGain = ctx.createGain();
        noise.type = 'sawtooth';
        noise.frequency.setValueAtTime(200, now);
        noise.frequency.exponentialRampToValueAtTime(2000, now + 0.05);
        nGain.gain.setValueAtTime(0.3, now);
        nGain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        noise.connect(nGain);
        nGain.connect(this.seGain!);
        noise.start(now);
        noise.stop(now + 0.1);
    }

    // ファンファーレ（新キャラ獲得）
    playFanfare(rarity: number): void {
        if (this.muted) return;
        const ctx = this.ensureContext();
        const now = ctx.currentTime;

        // レアリティに応じてメロディを変える
        const notes = rarity >= 4
            ? [523, 659, 784, 1047, 1319, 1568] // C5-E5-G5-C6-E6-G6
            : rarity >= 3
                ? [523, 659, 784, 1047]             // C5-E5-G5-C6
                : [523, 659, 784];                  // C5-E5-G5

        const duration = rarity >= 4 ? 0.12 : 0.15;

        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            const t = now + i * duration;
            osc.frequency.setValueAtTime(freq, t);
            gain.gain.setValueAtTime(0.3, t);
            gain.gain.linearRampToValueAtTime(0.3, t + duration * 0.7);
            gain.gain.exponentialRampToValueAtTime(0.01, t + duration + 0.1);
            osc.connect(gain);
            gain.connect(this.seGain!);
            osc.start(t);
            osc.stop(t + duration + 0.1);
        });

        // ハーモニー（★4以上）
        if (rarity >= 4) {
            const harmony = ctx.createOscillator();
            const hGain = ctx.createGain();
            harmony.type = 'triangle';
            harmony.frequency.setValueAtTime(784, now); // G5
            hGain.gain.setValueAtTime(0.15, now);
            hGain.gain.linearRampToValueAtTime(0.15, now + notes.length * duration);
            hGain.gain.exponentialRampToValueAtTime(0.01, now + notes.length * duration + 0.3);
            harmony.connect(hGain);
            hGain.connect(this.seGain!);
            harmony.start(now);
            harmony.stop(now + notes.length * duration + 0.3);
        }
    }

    // アップグレード音
    playUpgrade(): void {
        if (this.muted) return;
        const ctx = this.ensureContext();
        const now = ctx.currentTime;

        const notes = [392, 494, 587]; // G4-B4-D5
        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            const t = now + i * 0.08;
            osc.frequency.setValueAtTime(freq, t);
            gain.gain.setValueAtTime(0.25, t);
            gain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
            osc.connect(gain);
            gain.connect(this.seGain!);
            osc.start(t);
            osc.stop(t + 0.15);
        });
    }

    // エラー音
    playError(): void {
        if (this.muted) return;
        const ctx = this.ensureContext();
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.setValueAtTime(150, now + 0.1);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
        osc.connect(gain);
        gain.connect(this.seGain!);
        osc.start(now);
        osc.stop(now + 0.25);
    }

    // BGM開始（ポップなループメロディ）
    startBGM(): void {
        if (this.bgmPlaying || this.muted) return;
        const ctx = this.ensureContext();
        this.bgmPlaying = true;
        this.playBGMLoop(ctx);
    }

    private playBGMLoop(ctx: AudioContext): void {
        if (!this.bgmPlaying) return;

        const now = ctx.currentTime;
        // シンプルなポップメロディ（Cメジャースケール）
        const melody = [
            { note: 523, dur: 0.3 },  // C5
            { note: 587, dur: 0.3 },  // D5
            { note: 659, dur: 0.3 },  // E5
            { note: 523, dur: 0.3 },  // C5
            { note: 659, dur: 0.3 },  // E5
            { note: 784, dur: 0.6 },  // G5
            { note: 784, dur: 0.6 },  // G5
            { note: 698, dur: 0.3 },  // F5
            { note: 659, dur: 0.3 },  // E5
            { note: 587, dur: 0.3 },  // D5
            { note: 523, dur: 0.3 },  // C5
            { note: 587, dur: 0.3 },  // D5
            { note: 523, dur: 0.6 },  // C5
        ];

        let t = now;
        this.bgmOscillators = [];

        for (const m of melody) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(m.note, t);
            gain.gain.setValueAtTime(0.08, t);
            gain.gain.setValueAtTime(0.08, t + m.dur * 0.8);
            gain.gain.linearRampToValueAtTime(0, t + m.dur);
            osc.connect(gain);
            gain.connect(this.bgmGain!);
            osc.start(t);
            osc.stop(t + m.dur);
            this.bgmOscillators.push(osc);
            t += m.dur;
        }

        // ベース
        const bassNotes = [
            { note: 131, dur: 1.2 }, // C3
            { note: 131, dur: 1.2 }, // C3
            { note: 175, dur: 1.2 }, // F3
            { note: 131, dur: 1.2 }, // C3
            { note: 131, dur: 0.6 }, // C3
        ];

        let bt = now;
        for (const b of bassNotes) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(b.note, bt);
            gain.gain.setValueAtTime(0.06, bt);
            gain.gain.setValueAtTime(0.06, bt + b.dur * 0.8);
            gain.gain.linearRampToValueAtTime(0, bt + b.dur);
            osc.connect(gain);
            gain.connect(this.bgmGain!);
            osc.start(bt);
            osc.stop(bt + b.dur);
            this.bgmOscillators.push(osc);
            bt += b.dur;
        }

        // ループ
        const totalDuration = melody.reduce((s, m) => s + m.dur, 0);
        setTimeout(() => {
            if (this.bgmPlaying) {
                this.playBGMLoop(ctx);
            }
        }, totalDuration * 1000);
    }

    stopBGM(): void {
        this.bgmPlaying = false;
        for (const osc of this.bgmOscillators) {
            try { osc.stop(); } catch (_) { /* already stopped */ }
        }
        this.bgmOscillators = [];
    }

    dispose(): void {
        this.stopBGM();
        if (this.ctx) {
            this.ctx.close();
            this.ctx = null;
        }
    }
}
