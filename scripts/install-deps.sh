#!/usr/bin/env bash
# LIBARTIN — Auto Dependency Installer
# Run: bash scripts/install-deps.sh

set -e

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   LIBARTIN  Dependency Installer             ║"
echo "║   Bi-Directional Fibonacci XAUUSD Scalping  ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is not installed. Please install Node.js first."
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "ERROR: npm is not installed."
  exit 1
fi

NODE_VERSION=$(node --version)
NPM_VERSION=$(npm --version)
echo "Node: $NODE_VERSION"
echo "npm:  $NPM_VERSION"
echo ""

echo "Installing all dependencies..."
npm install \
  --prefer-offline \
  --no-audit \
  --no-fund \
  --loglevel=error

echo ""
echo "Running postinstall patches..."
npx patch-package 2>/dev/null || true

echo ""
echo "Verifying critical packages..."

# ── Frontend — Expo & React Native ───────────────────────────────────────────
FRONTEND_PACKAGES=(
  "expo"
  "expo-router"
  "expo-font"
  "expo-splash-screen"
  "expo-status-bar"
  "expo-constants"
  "expo-linking"
  "expo-web-browser"
  "expo-system-ui"
  "expo-blur"
  "expo-glass-effect"
  "expo-image"
  "expo-symbols"
  "expo-linear-gradient"
  "expo-haptics"
  "expo-device"
  "expo-background-fetch"
  "expo-task-manager"
  "expo-notifications"
  "react"
  "react-dom"
  "react-native"
  "react-native-web"
  "react-native-svg"
  "react-native-safe-area-context"
  "react-native-screens"
  "react-native-reanimated"
  "react-native-gesture-handler"
  "react-native-keyboard-controller"
  "react-native-worklets"
  "@react-native-async-storage/async-storage"
  "@expo/vector-icons"
  "@expo-google-fonts/inter"
  "@expo-google-fonts/orbitron"
  "@tanstack/react-query"
)

# ── Backend — Express Server & WebSocket ─────────────────────────────────────
BACKEND_PACKAGES=(
  "express"
  "http-proxy-middleware"
  "ws"
  "tsx"
  "zod"
)

echo ""
echo "  [ FRONTEND ]"
ALL_OK=true
for pkg in "${FRONTEND_PACKAGES[@]}"; do
  if [ -d "node_modules/$pkg" ]; then
    echo "  ✓ $pkg"
  else
    echo "  ✗ MISSING: $pkg"
    ALL_OK=false
  fi
done

echo ""
echo "  [ BACKEND ]"
for pkg in "${BACKEND_PACKAGES[@]}"; do
  if [ -d "node_modules/$pkg" ]; then
    echo "  ✓ $pkg"
  else
    echo "  ✗ MISSING: $pkg"
    ALL_OK=false
  fi
done

if [ "$ALL_OK" = false ]; then
  echo ""
  echo "Some packages are missing. Running npm install again..."
  npm install --no-audit --no-fund --loglevel=error
fi

echo ""
echo "✓ LIBARTIN dependencies installed successfully!"
echo ""
echo "───────────────────────────────────────────────"
echo " DEVELOPMENT:"
echo "   Backend  → npm run server:dev   (port 5000)"
echo "   Frontend → npm run expo:dev     (port 8081)"
echo ""
echo " ARCHITECTURE:"
echo "   Backend  → Express + DerivService WebSocket 24/7"
echo "   Strategy → Fibonacci Bi-Directional M15/M5 Scalping"
echo "   AI       → Pollinations AI (text.pollinations.ai)"
echo "   Time     → WIB (UTC+7) all timestamps"
echo ""
echo " BUILD APK:"
echo "   eas build --platform android --profile production"
echo "───────────────────────────────────────────────"
echo ""
