import { Platform } from "react-native";

declare global {
  interface Window {
    AudioContext: typeof AudioContext;
    webkitAudioContext: typeof AudioContext;
    __libartinAudioCtx?: AudioContext;
    __libartinAudioUnlocked?: boolean;
  }
}

let audioCtx: AudioContext | null = null;
let audioUnlocked = false;

function setupWebAudio(): void {
  if (typeof window === "undefined" || Platform.OS !== "web") return;
  if (audioCtx) return;

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audioCtx = new AudioCtx();

    const unlock = () => {
      if (audioUnlocked) return;
      if (!audioCtx) return;
      if (audioCtx.state === "suspended") {
        audioCtx.resume().then(() => {
          audioUnlocked = true;
        }).catch(() => {});
      } else {
        audioUnlocked = true;
      }
    };

    window.addEventListener("click", unlock, { once: true, passive: true });
    window.addEventListener("touchstart", unlock, { once: true, passive: true });
    window.addEventListener("keydown", unlock, { once: true, passive: true });
  } catch {
  }
}

export function unlockAudioContext(): void {
  if (Platform.OS !== "web") return;
  setupWebAudio();
}

function playWebBeep(type: "signal" | "tp" | "sl"): void {
  if (!audioCtx) return;
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
    return;
  }

  const configs: Record<typeof type, { freqs: number[]; duration: number; gain: number }> = {
    signal: { freqs: [880, 1100, 1320], duration: 0.13, gain: 0.38 },
    tp:     { freqs: [660, 880, 1100, 1320], duration: 0.11, gain: 0.42 },
    sl:     { freqs: [440, 330], duration: 0.2, gain: 0.32 },
  };

  try {
    const cfg = configs[type];
    let startTime = audioCtx.currentTime + 0.01;

    cfg.freqs.forEach((freq) => {
      if (!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(cfg.gain, startTime + 0.015);
      gain.gain.linearRampToValueAtTime(0, startTime + cfg.duration);

      osc.start(startTime);
      osc.stop(startTime + cfg.duration + 0.02);
      startTime += cfg.duration * 0.85;
    });
  } catch {
  }
}

async function playNativeHaptic(type: "signal" | "tp" | "sl"): Promise<void> {
  try {
    const Haptics = await import("expo-haptics");
    if (type === "signal") {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      }, 250);
    } else if (type === "tp") {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  } catch {
  }
}

export async function playSignalSound(type: "signal" | "tp" | "sl" = "signal"): Promise<void> {
  if (Platform.OS === "web") {
    playWebBeep(type);
  } else {
    await playNativeHaptic(type);
  }
}
