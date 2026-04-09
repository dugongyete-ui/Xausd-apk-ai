#!/usr/bin/env bash
# LIBARTIN — Post-Merge Setup Script
# Runs automatically after task agent merges to ensure environment is ready.

set -e

echo ""
echo "=== LIBARTIN Post-Merge Setup ==="
echo ""

# Install/update npm dependencies
echo "Installing npm dependencies..."
npm install --legacy-peer-deps

echo ""
echo "=== Post-Merge Setup Complete ==="
