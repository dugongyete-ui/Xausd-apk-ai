# LIBARTIN — Fibonacci XAUUSD Trading Analysis App

## Overview
LIBARTIN is a professional mobile trading analysis application built with Expo (React Native) designed for real-time Fibonacci retracement analysis on XAUUSD (Gold/USD). It utilizes live data from Deriv WebSocket to provide purely mathematical trading decisions, eliminating subjective visual assumptions. The core strategy, "Deep Pullback Continuation," focuses on identifying trading opportunities based on M15 timeframe structure, EMA, swing detection, and Fibonacci levels, with M5 for entry confirmation. The project aims to provide traders with precise, automated analysis and signal generation.

## User Preferences
I prefer iterative development with clear communication on significant changes. Before implementing major architectural changes or introducing new dependencies, please ask for approval. For smaller, incremental changes, proceed and inform me in the pull request. Ensure that all explanations are concise and directly relevant to the task at hand. I appreciate well-structured code and adherence to best practices.

## System Architecture

### Frontend (Expo / React Native)
- **Framework**: Expo Router for file-based navigation.
- **State Management**: React Context (`TradingContext`) for all trading engine states.
- **Styling**: Dark navy trading terminal theme (`#0A0E17` background, `#F0B429` gold accent), utilizing Inter for UI and Orbitron for branding.
- **Navigation**: A 3-tab layout comprising Dashboard, Signals, and Settings.
- **Components**: `FibChart.tsx` for interactive candlestick charts with Fibonacci levels, EMAs, and signal markers.
- **Features**: Live price display, trend indicators, Fibonacci level visualization, active signal tracking, signal history, and configurable risk parameters.
- **Offline Capabilities**: Simulates missing candles via a seeded random walk and generates signals during extended offline periods, saving outcomes to history.

### Backend (Express)
- **Server**: Runs on Port 5000, serving a landing page and static Expo assets.
- **DerivService**: A persistent WebSocket connection to Deriv (`server/derivService.ts`) that operates 24/7. It handles continuous data streaming, analysis, and signal detection (EMA50/200, swing detection, Fibonacci).
- **APIs**: Provides endpoints for `GET /api/market-state`, `GET /api/signals`, and `GET /api/health`.
- **AI Integration**: Implements a dedicated AI chat service (`server/aiService.ts`) with contextual memory. The AI automatically generates recommendations for BUY/SELL signals and comments on TP/SL outcomes. User chat uses a fire-and-poll architecture: `POST /api/ai/chat` returns instantly (queues AI processing in background), then the frontend polls `GET /api/ai/messages` every 2 seconds until the response appears — bypassing Replit proxy timeout issues.

### Trading Strategy: Deep Pullback Continuation
- **Timeframes**: M15 for structure analysis (EMA, swing detection, Fibonacci), M5 for entry confirmation.
- **Entry**: Golden Zone (61.8%–78.6% retracement) with expanded zone check (50%-88.6%) and specific candle formation criteria on M5.
- **Exit**: Take Profit at -27% extension (ATR-adaptive for scalping), Stop Loss at swing low/high.
- **Trend Detection**: Based on M15 EMA50 and EMA200 crossover and price position relative to EMAs.
- **Swing Detection**: Hybrid fractal + local extreme on M15, ensuring stable Fibonacci anchors.
- **Position Sizing**: Calculated based on 1% risk per trade relative to SL distance.
- **Filters**: Minimum SL distance and a 30-minute cooldown per fractal anchor.

### Data Management and Persistence
- **Caching**: M15 and M5 candles are cached in AsyncStorage for rapid startup and instant display.
- **Persistence**: Signal history and account balance are stored using AsyncStorage.
- **Market Hours**: `forexMarketOpen()` function checks UTC time for XAUUSD market open/close, with auto-reconnect and history rebuild on market open.

### Notification System
- **Real-time**: Local notifications when the app is open.
- **Background/Closed**: Backend server sends Expo Push Notifications for signals, TP, and SL alerts.
- **Background Fetch**: Utilizes `expo-background-fetch` and `expo-task-manager` for periodic background wakeups to monitor signals.

## External Dependencies

- **Deriv WebSocket API**: `wss://ws.derivws.com/websockets/v3?app_id=114791` for live XAUUSD data.
- **Pollinations AI**: `https://text.pollinations.ai/v1/chat/completions` for AI chat functionality.
- **Expo Ecosystem**:
    - `expo`, `expo-router`, `expo-blur`, `expo-haptics`, `expo-glass-effect`
    - `@expo-google-fonts/inter`, `@expo-google-fonts/orbitron`, `@expo/vector-icons`
    - `expo-background-fetch`, `expo-task-manager`, `expo-notifications`
- **React Native Libraries**:
    - `@tanstack/react-query`, `@react-native-async-storage/async-storage`
    - `react-native-reanimated`, `react-native-safe-area-context`
    - `react-native-keyboard-controller`, `react-native-gesture-handler`
    - `react-native-svg` (for charting)