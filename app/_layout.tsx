import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import {
  Orbitron_400Regular,
  Orbitron_500Medium,
  Orbitron_600SemiBold,
  Orbitron_700Bold,
  Orbitron_800ExtraBold,
  Orbitron_900Black,
} from "@expo-google-fonts/orbitron";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { TradingProvider } from "@/contexts/TradingContext";

SplashScreen.preventAutoHideAsync();

// On web, passing an empty map avoids the fontfaceobserver 6s timeout crash.
// Custom fonts still work on native (Expo Go / builds) via @expo-google-fonts.
const FONT_MAP =
  Platform.OS === "web"
    ? {}
    : {
        Inter_400Regular,
        Inter_500Medium,
        Inter_600SemiBold,
        Inter_700Bold,
        Orbitron_400Regular,
        Orbitron_500Medium,
        Orbitron_600SemiBold,
        Orbitron_700Bold,
        Orbitron_800ExtraBold,
        Orbitron_900Black,
      };

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(FONT_MAP);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardProvider>
            <TradingProvider>
              <RootLayoutNav />
            </TradingProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
