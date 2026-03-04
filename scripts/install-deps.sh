#!/usr/bin/env bash
# LIBARTIN — Auto Dependency Installer
# Run: bash scripts/install-deps.sh

set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   LIBARTIN  Dependency Installer     ║"
echo "║   Fibonacci XAUUSD Trading Analysis  ║"
echo "╚══════════════════════════════════════╝"
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
PACKAGES=(
  "expo"
  "expo-router"
  "expo-notifications"
  "expo-background-fetch"
  "expo-task-manager"
  "expo-device"
  "expo-haptics"
  "expo-blur"
  "expo-font"
  "expo-linear-gradient"
  "expo-splash-screen"
  "expo-status-bar"
  "expo-constants"
  "expo-linking"
  "expo-web-browser"
  "expo-system-ui"
  "@react-native-async-storage/async-storage"
  "react-native-svg"
  "react-native-safe-area-context"
  "react-native-screens"
  "react-native-reanimated"
  "react-native-gesture-handler"
  "@expo-google-fonts/inter"
  "@expo/vector-icons"
  "react"
  "react-native"
)

ALL_OK=true
for pkg in "${PACKAGES[@]}"; do
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
echo "─────────────────────────────────────────"
echo " Start the app:"
echo "   Backend:  npm run server:dev"
echo "   Frontend: npm run expo:dev"
echo ""
echo " Build APK:"
echo "   eas build --platform android --profile production"
echo "─────────────────────────────────────────"
echo ""
