import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";

// Tampilkan notifikasi bahkan saat app di foreground (seperti WhatsApp)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// ─── Android Channels Setup ───────────────────────────────────────────────────
async function setupAndroidChannels() {
  if (Platform.OS !== "android") return;

  // Channel untuk sinyal BUY/SELL — prioritas maksimal seperti WhatsApp
  await Notifications.setNotificationChannelAsync("trading-signals", {
    name: "⚡ Sinyal Trading XAUUSD",
    description: "Notifikasi sinyal BUY dan SELL XAUUSD dari LIBARTIN",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 300, 200, 300, 200, 600],
    lightColor: "#F0B429",
    sound: "default",
    enableVibrate: true,
    showBadge: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
  });

  // Channel untuk TP/SL alerts
  await Notifications.setNotificationChannelAsync("tp-sl-alerts", {
    name: "🎯 TP / SL Alert XAUUSD",
    description: "Notifikasi Take Profit dan Stop Loss tercapai",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 150, 100, 150, 100, 800],
    lightColor: "#22C55E",
    sound: "default",
    enableVibrate: true,
    showBadge: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: false,
  });
}

// ─── Request Permission ───────────────────────────────────────────────────────
export async function requestNotificationPermission(): Promise<boolean> {
  if (!Device.isDevice && Platform.OS !== "android") {
    return false;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    return false;
  }

  await setupAndroidChannels();
  return true;
}

// ─── Get Expo Push Token ──────────────────────────────────────────────────────
// Token ini dikirim ke backend supaya server bisa kirim notifikasi
// bahkan saat app ditutup (seperti WhatsApp)
export async function getExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  if (Platform.OS === "web") return null;

  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") return null;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    const tokenData = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();

    return tokenData.data;
  } catch (e) {
    console.warn("[NotificationService] Failed to get push token:", e);
    return null;
  }
}

// ─── Local Notification: Sinyal BUY/SELL ─────────────────────────────────────
// Dipakai saat app sedang buka (foreground)
export async function sendSignalNotification(params: {
  trend: "Bullish" | "Bearish";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  lotSize: number;
  confirmationType: "rejection" | "engulfing";
}): Promise<void> {
  const isBull = params.trend === "Bullish";
  const dirEmoji = isBull ? "🟢" : "🔴";
  const dirLabel = isBull ? "BUY ▲" : "SELL ▼";
  const confirmLabel =
    params.confirmationType === "engulfing" ? "Engulfing M5" : "Pin Bar M5";
  const rrLabel = `R:R 1:${params.riskReward}`;

  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${dirEmoji} LIBARTIN — SINYAL ${dirLabel} XAUUSD`,
      body:
        `📍 Entry: ${params.entryPrice.toFixed(2)}\n` +
        `🛑 SL: ${params.stopLoss.toFixed(2)}\n` +
        `🎯 TP: ${params.takeProfit.toFixed(2)}\n` +
        `📊 ${rrLabel} | Lot: ${params.lotSize.toFixed(2)} | ${confirmLabel}`,
      sound: "default",
      priority: Notifications.AndroidNotificationPriority.MAX,
      data: { type: "signal", trend: params.trend },
      sticky: false,
      ...(Platform.OS === "android" && { channelId: "trading-signals" }),
    },
    trigger: null,
  });
}

// ─── Local Notification: TP Tercapai ─────────────────────────────────────────
export async function sendTPAlert(params: {
  trend: "Bullish" | "Bearish";
  entryPrice: number;
  takeProfit: number;
  currentPrice: number;
}): Promise<void> {
  const isBull = params.trend === "Bullish";
  const pnlPips = isBull
    ? params.currentPrice - params.entryPrice
    : params.entryPrice - params.currentPrice;

  await Notifications.scheduleNotificationAsync({
    content: {
      title: `✅ TAKE PROFIT TERCAPAI! — LIBARTIN`,
      body:
        `💰 ${isBull ? "BUY" : "SELL"} XAUUSD Profit!\n` +
        `📍 Entry: ${params.entryPrice.toFixed(2)}\n` +
        `🎯 TP: ${params.takeProfit.toFixed(2)} | Harga: ${params.currentPrice.toFixed(2)}\n` +
        `✨ P&L: +${pnlPips.toFixed(2)} pips`,
      sound: "default",
      priority: Notifications.AndroidNotificationPriority.MAX,
      data: { type: "tp", trend: params.trend },
      ...(Platform.OS === "android" && { channelId: "tp-sl-alerts" }),
    },
    trigger: null,
  });
}

// ─── Local Notification: SL Kena ─────────────────────────────────────────────
export async function sendSLAlert(params: {
  trend: "Bullish" | "Bearish";
  entryPrice: number;
  stopLoss: number;
  currentPrice: number;
}): Promise<void> {
  const isBull = params.trend === "Bullish";
  const lossPrice = isBull
    ? params.entryPrice - params.currentPrice
    : params.currentPrice - params.entryPrice;

  await Notifications.scheduleNotificationAsync({
    content: {
      title: `🛑 STOP LOSS KENA — LIBARTIN`,
      body:
        `❌ ${isBull ? "BUY" : "SELL"} XAUUSD SL Tercapai\n` +
        `📍 Entry: ${params.entryPrice.toFixed(2)}\n` +
        `🛑 SL: ${params.stopLoss.toFixed(2)} | Harga: ${params.currentPrice.toFixed(2)}\n` +
        `📉 Loss: -${lossPrice.toFixed(2)} pips`,
      sound: "default",
      priority: Notifications.AndroidNotificationPriority.MAX,
      data: { type: "sl", trend: params.trend },
      ...(Platform.OS === "android" && { channelId: "tp-sl-alerts" }),
    },
    trigger: null,
  });
}

export async function getNotificationPermissionStatus(): Promise<"granted" | "denied" | "undetermined"> {
  const { status } = await Notifications.getPermissionsAsync();
  return status;
}
