import { useState, useEffect, useRef, useCallback } from "react";

type Note = { lane: number; time: number; hit?: "perfect" | "great" | "good" | "miss" };
type Song = { name: string; bpm: number; notes: Note[]; duration: number };

const LANES = 4;
const LANE_KEYS = ["d", "f", "j", "k"];
const LANE_COLORS = ["#FF6B6B", "#FFE66D", "#4ECDC4", "#A29BFE"];
const HIT_Y = 0.85;
const SPEED = 0.4; // screen heights per second
const WINDOWS = { perfect: 0.04, great: 0.08, good: 0.14 };

function generateSong(name: string, bpm: number, durationSec: number): Song {
  const beatInterval = 60 / bpm;
  const notes: Note[] = [];
  const totalBeats = Math.floor(durationSec / beatInterval);
  const rng = (s: number) => {
    let x = Math.sin(s * 9301 + 49297) * 233280;
    return x - Math.floor(x);
  };
  let seed = name.length * 137;
  for (let i = 4; i < totalBeats; i++) {
    seed++;
    const r = rng(seed);
    if (r < 0.45) {
      const lane = Math.floor(rng(seed + 1000) * LANES);
      notes.push({ lane, time: i * beatInterval });
      // occasional double
      if (rng(seed + 2000) < 0.15) {
        let lane2 = (lane + 1 + Math.floor(rng(seed + 3000) * (LANES - 1))) % LANES;
        notes.push({ lane: lane2, time: i * beatInterval });
      }
    }
  }
  return { name, bpm, notes, duration: durationSec };
}

const SONGS: Song[] = [
  generateSong("Neon Pulse", 120, 45),
  generateSong("Digital Storm", 140, 50),
  generateSong("Cyber Groove", 160, 55),
];

function playHitSound(quality: "perfect" | "great" | "good") {
  try {
    const ctx = new AudioContext();
    const freq = quality === "perfect" ? 880 : quality === "great" ? 660 : 440;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = "triangle";
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } catch {}
}

function playBgBeat(bpm: number): { stop: () => void } {
  try {
    const ctx = new AudioContext();
    const interval = 60 / bpm;
    let nextBeat = ctx.currentTime + 0.1;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      while (nextBeat < ctx.currentTime + 0.2) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 80;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.06, nextBeat);
        gain.gain.exponentialRampToValueAtTime(0.001, nextBeat + 0.08);
        osc.start(nextBeat);
        osc.stop(nextBeat + 0.08);
        nextBeat += interval;
      }
      setTimeout(schedule, 100);
    };
    schedule();
    return { stop: () => { stopped = true; ctx.close(); } };
  } catch {
    return { stop: () => {} };
  }
}

export default function RhythmGame() {
  const [screen, setScreen] = useState<"menu" | "playing" | "results">("menu");
  const [songIdx, setSongIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [hits, setHits] = useState({ perfect: 0, great: 0, good: 0, miss: 0 });
  const [feedback, setFeedback] = useState<{ text: string; color: string; lane: number; time: number } | null>(null);
  const [highScores, setHighScores] = useState<number[]>([0, 0, 0]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameTime = useRef(0);
  const startTime = useRef(0);
  const notesRef = useRef<Note[]>([]);
  const animRef = useRef(0);
  const bgBeat = useRef<{ stop: () => void } | null>(null);
  const laneFlash = useRef<number[]>([0, 0, 0, 0]);
  const comboRef = useRef(0);
  const scoreRef = useRef(0);
  const hitsRef = useRef({ perfect: 0, great: 0, good: 0, miss: 0 });
  const maxComboRef = useRef(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("rhythm_high");
      if (saved) setHighScores(JSON.parse(saved));
    } catch {}
  }, []);

  const startSong = useCallback((idx: number) => {
    setSongIdx(idx);
    setScore(0);
    setCombo(0);
    setMaxCombo(0);
    setHits({ perfect: 0, great: 0, good: 0, miss: 0 });
    setFeedback(null);
    comboRef.current = 0;
    scoreRef.current = 0;
    maxComboRef.current = 0;
    hitsRef.current = { perfect: 0, great: 0, good: 0, miss: 0 };
    notesRef.current = SONGS[idx].notes.map((n) => ({ ...n, hit: undefined }));
    startTime.current = performance.now() / 1000;
    bgBeat.current = playBgBeat(SONGS[idx].bpm);
    setScreen("playing");
  }, []);

  const endSong = useCallback(() => {
    bgBeat.current?.stop();
    cancelAnimationFrame(animRef.current);
    // count remaining unhit as miss
    notesRef.current.forEach((n) => {
      if (!n.hit) {
        n.hit = "miss";
        hitsRef.current.miss++;
      }
    });
    setHits({ ...hitsRef.current });
    setScore(scoreRef.current);
    setCombo(0);
    setMaxCombo(maxComboRef.current);
    setHighScores((prev) => {
      const next = [...prev];
      if (scoreRef.current > next[songIdx]) {
        next[songIdx] = scoreRef.current;
        localStorage.setItem("rhythm_high", JSON.stringify(next));
      }
      return next;
    });
    setScreen("results");
  }, [songIdx]);

  const handleHit = useCallback((lane: number) => {
    if (screen !== "playing") return;
    laneFlash.current[lane] = performance.now();
    const now = gameTime.current;
    let best: { note: Note; diff: number } | null = null;
    for (const n of notesRef.current) {
      if (n.lane !== lane || n.hit) continue;
      const diff = Math.abs(n.time - now);
      if (diff < WINDOWS.good + 0.04) {
        if (!best || diff < best.diff) best = { note: n, diff };
      }
    }
    if (best) {
      const diff = best.diff;
      let quality: "perfect" | "great" | "good";
      let pts: number;
      if (diff <= WINDOWS.perfect) { quality = "perfect"; pts = 300; }
      else if (diff <= WINDOWS.great) { quality = "great"; pts = 200; }
      else { quality = "good"; pts = 100; }
      best.note.hit = quality;
      hitsRef.current[quality]++;
      comboRef.current++;
      if (comboRef.current > maxComboRef.current) maxComboRef.current = comboRef.current;
      scoreRef.current += pts * (1 + Math.floor(comboRef.current / 10) * 0.1);
      setScore(Math.floor(scoreRef.current));
      setCombo(comboRef.current);
      setMaxCombo(maxComboRef.current);
      const colors = { perfect: "#FFE66D", great: "#4ECDC4", good: "#A29BFE" };
      setFeedback({ text: quality.toUpperCase(), color: colors[quality], lane, time: performance.now() });
      playHitSound(quality);
    }
  }, [screen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const idx = LANE_KEYS.indexOf(e.key.toLowerCase());
      if (idx >= 0) {
        e.preventDefault();
        handleHit(idx);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleHit]);

  // Game loop
  useEffect(() => {
    if (screen !== "playing") return;
    const song = SONGS[songIdx];
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    const loop = () => {
      const now = performance.now() / 1000;
      gameTime.current = now - startTime.current;
      const gt = gameTime.current;

      const W = canvas.width;
      const H = canvas.height;
      const laneW = W / LANES;

      // bg
      ctx.fillStyle = "#0a0a1a";
      ctx.fillRect(0, 0, W, H);

      // lane dividers
      for (let i = 1; i < LANES; i++) {
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(i * laneW, 0);
        ctx.lineTo(i * laneW, H);
        ctx.stroke();
      }

      // hit line
      const hitY = H * HIT_Y;
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, hitY);
      ctx.lineTo(W, hitY);
      ctx.stroke();

      // lane flash
      const nowMs = performance.now();
      for (let i = 0; i < LANES; i++) {
        const elapsed = nowMs - laneFlash.current[i];
        if (elapsed < 200) {
          const alpha = 0.3 * (1 - elapsed / 200);
          ctx.fillStyle = `${LANE_COLORS[i]}${Math.floor(alpha * 255).toString(16).padStart(2, "0")}`;
          ctx.fillRect(i * laneW, hitY - 30, laneW, 60);
        }
      }

      // key labels
      ctx.font = "bold 18px monospace";
      ctx.textAlign = "center";
      for (let i = 0; i < LANES; i++) {
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.fillText(LANE_KEYS[i].toUpperCase(), i * laneW + laneW / 2, hitY + 24);
      }

      // notes
      let allPast = true;
      for (const note of notesRef.current) {
        const relTime = note.time - gt;
        const y = hitY - (relTime / SPEED) * H * SPEED;
        if (y < -40) { allPast = false; continue; }
        if (y > H + 40) {
          // missed
          if (!note.hit && relTime < -WINDOWS.good - 0.04) {
            note.hit = "miss";
            hitsRef.current.miss++;
            comboRef.current = 0;
            setCombo(0);
            setFeedback({ text: "MISS", color: "#FF6B6B", lane: note.lane, time: performance.now() });
          }
          continue;
        }
        if (relTime > -1) allPast = false;

        if (!note.hit) {
          const x = note.lane * laneW + laneW / 2;
          const noteH = 16;
          const noteW = laneW * 0.7;
          const grad = ctx.createLinearGradient(x - noteW / 2, y, x + noteW / 2, y);
          grad.addColorStop(0, LANE_COLORS[note.lane]);
          grad.addColorStop(1, LANE_COLORS[note.lane] + "88");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.roundRect(x - noteW / 2, y - noteH / 2, noteW, noteH, 4);
          ctx.fill();
          // glow
          ctx.shadowColor = LANE_COLORS[note.lane];
          ctx.shadowBlur = 12;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      // combo
      if (comboRef.current > 1) {
        ctx.fillStyle = "#FFE66D";
        ctx.font = "bold 28px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`${comboRef.current} COMBO`, W / 2, H * 0.15);
      }

      // score
      ctx.fillStyle = "#fff";
      ctx.font = "bold 20px monospace";
      ctx.textAlign = "right";
      ctx.fillText(String(Math.floor(scoreRef.current)), W - 12, 30);

      // progress bar
      const progress = gt / song.duration;
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.fillRect(0, 0, W, 4);
      ctx.fillStyle = "#4ECDC4";
      ctx.fillRect(0, 0, W * Math.min(progress, 1), 4);

      if (gt < song.duration + 2 && !allPast) {
        animRef.current = requestAnimationFrame(loop);
      } else {
        endSong();
      }
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [screen, songIdx, endSong]);

  const grade = useCallback(() => {
    const total = hits.perfect + hits.great + hits.good + hits.miss;
    if (total === 0) return "?";
    const pct = ((hits.perfect * 3 + hits.great * 2 + hits.good) / (total * 3)) * 100;
    if (pct >= 95) return "S";
    if (pct >= 85) return "A";
    if (pct >= 70) return "B";
    if (pct >= 50) return "C";
    return "D";
  }, [hits]);

  // Canvas sizing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = Math.min(400, window.innerWidth - 20);
    const h = Math.min(700, window.innerHeight - 120);
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }, [screen]);

  // Touch
  const handleTouch = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const x = t.clientX - rect.left;
      const lane = Math.floor((x / rect.width) * LANES);
      if (lane >= 0 && lane < LANES) handleHit(lane);
    }
  }, [handleHit]);

  if (screen === "menu") {
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0a0a1a, #1a1a3e, #0a0a1a)",
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", padding: 20, fontFamily: "'Segoe UI', sans-serif", color: "#fff",
      }}>
        <h1 style={{
          fontSize: "clamp(32px, 6vw, 52px)", fontWeight: 900, marginBottom: 8,
          background: "linear-gradient(90deg, #FF6B6B, #FFE66D, #4ECDC4, #A29BFE)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>🎵 RHYTHM GAME</h1>
        <p style={{ opacity: 0.5, marginBottom: 24 }}>D F J Kキー or レーンをタップ</p>
        {SONGS.map((s, i) => (
          <button key={i} onClick={() => startSong(i)} style={{
            width: 280, padding: "14px 20px", margin: 6, borderRadius: 12, border: "none",
            background: `linear-gradient(135deg, ${LANE_COLORS[i]}44, ${LANE_COLORS[i]}22)`,
            color: "#fff", fontSize: 18, fontWeight: 700, cursor: "pointer",
            boxShadow: `0 0 20px ${LANE_COLORS[i]}33`,
          }}>
            {s.name} <span style={{ opacity: 0.5, fontSize: 14 }}>♩{s.bpm}</span>
            {highScores[i] > 0 && <span style={{ display: "block", fontSize: 12, opacity: 0.6 }}>ベスト: {highScores[i]}</span>}
          </button>
        ))}
      </div>
    );
  }

  if (screen === "results") {
    const g = grade();
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0a0a1a, #1a1a3e)",
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", padding: 20, fontFamily: "'Segoe UI', sans-serif", color: "#fff",
      }}>
        <h2 style={{ fontSize: 28, marginBottom: 4 }}>{SONGS[songIdx].name}</h2>
        <div style={{
          fontSize: 80, fontWeight: 900, marginBottom: 12,
          background: g === "S" ? "linear-gradient(90deg, #FFE66D, #FF6B6B)" : undefined,
          WebkitBackgroundClip: g === "S" ? "text" : undefined,
          WebkitTextFillColor: g === "S" ? "transparent" : undefined,
          color: g === "S" ? undefined : g === "A" ? "#4ECDC4" : g === "B" ? "#A29BFE" : "#FF6B6B",
        }}>{g}</div>
        <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 16 }}>{score}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 24px", fontSize: 16, marginBottom: 16 }}>
          <span style={{ color: "#FFE66D" }}>Perfect: {hits.perfect}</span>
          <span style={{ color: "#4ECDC4" }}>Great: {hits.great}</span>
          <span style={{ color: "#A29BFE" }}>Good: {hits.good}</span>
          <span style={{ color: "#FF6B6B" }}>Miss: {hits.miss}</span>
        </div>
        <div style={{ fontSize: 14, opacity: 0.6, marginBottom: 24 }}>Max Combo: {maxCombo}</div>
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={() => startSong(songIdx)} style={{
            padding: "10px 24px", borderRadius: 10, border: "none",
            background: "linear-gradient(135deg, #4ECDC4, #44a89d)", color: "#fff",
            fontWeight: 700, cursor: "pointer",
          }}>リトライ</button>
          <button onClick={() => setScreen("menu")} style={{
            padding: "10px 24px", borderRadius: 10, border: "none",
            background: "rgba(255,255,255,0.1)", color: "#fff",
            fontWeight: 700, cursor: "pointer",
          }}>メニュー</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0a1a",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Segoe UI', sans-serif", color: "#fff", touchAction: "none",
    }}>
      {feedback && performance.now() - feedback.time < 500 && (
        <div style={{
          position: "fixed", top: "40%", left: "50%", transform: "translate(-50%,-50%)",
          fontSize: 28, fontWeight: 900, color: feedback.color, pointerEvents: "none",
          textShadow: `0 0 20px ${feedback.color}`, zIndex: 10,
        }}>{feedback.text}</div>
      )}
      <canvas
        ref={canvasRef}
        onTouchStart={handleTouch}
        style={{ borderRadius: 8, boxShadow: "0 0 40px rgba(78,205,196,0.2)" }}
      />
    </div>
  );
}
