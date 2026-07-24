#!/usr/bin/env bash
# OmniRoute environment validator
# Checks all prerequisites for running OmniRoute
# Usage: ./validate-env.sh [--vps]

set -euo pipefail

IS_VPS=false
if [[ "${1:-}" == "--vps" ]]; then
  IS_VPS=true
fi

echo "=== OmniRoute Environment Validator ==="
echo "Mode: $(if $IS_VPS; then echo 'VPS'; else echo 'Local'; fi)"
echo ""

ERRORS=0

# Node version
echo "--- Node.js ---"
if command -v node &> /dev/null; then
  NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
  echo "✓ Node.js $(node --version)"
  if [[ "$NODE_VERSION" -lt 22 || "$NODE_VERSION" -gt 26 ]]; then
    echo "✗ Node version must be 22-26 (found: $NODE_VERSION)"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "✗ Node.js not found"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# npm
echo "--- npm ---"
if command -v npm &> /dev/null; then
  echo "✓ npm $(npm --version)"
else
  echo "✗ npm not found"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Dependencies
echo "--- Dependencies ---"
if [[ -d "node_modules" ]]; then
  echo "✓ node_modules exists"
else
  echo "✗ node_modules not found (run: npm ci)"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Environment file
echo "--- Environment ---"
if [[ -f ".env" ]]; then
  echo "✓ .env file exists"

  # Check required secrets
  if grep -q "^JWT_SECRET=" .env; then
    echo "✓ JWT_SECRET configured"
  else
    echo "✗ JWT_SECRET missing"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -q "^API_KEY_SECRET=" .env; then
    echo "✓ API_KEY_SECRET configured"
  else
    echo "✗ API_KEY_SECRET missing"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "✗ .env file not found (run: npm ci or copy from .env.example)"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Port availability
echo "--- Port 20128 ---"
if lsof -ti:20128 &> /dev/null; then
  echo "⚠ Port 20128 is in use"
  if ! $IS_VPS; then
    echo "  Kill with: lsof -ti:20128 | xargs kill -9"
  fi
else
  echo "✓ Port 20128 is available"
fi
echo ""

# SQLite
echo "--- SQLite ---"
if command -v sqlite3 &> /dev/null; then
  echo "✓ sqlite3 $(sqlite3 --version | cut -d' ' -f1)"
else
  echo "⚠ sqlite3 CLI not found (optional, for manual DB inspection)"
fi
echo ""

# VPS-specific checks
if $IS_VPS; then
  echo "--- VPS Specific ---"
  if [[ -f "/root/.omniroute/storage.sqlite" ]]; then
    echo "✓ Database exists at /root/.omniroute/storage.sqlite"
  else
    echo "✗ Database not found"
    ERRORS=$((ERRORS + 1))
  fi

  if [[ -f "/root/.omniroute/server.env" ]]; then
    echo "✓ server.env exists"
  else
    echo "✗ server.env not found"
    ERRORS=$((ERRORS + 1))
  fi

  if systemctl is-active --quiet omniroute; then
    echo "✓ omniroute service is running"
  else
    echo "⚠ omniroute service is not running"
  fi
  echo ""
fi

# Summary
echo "=== Summary ==="
if [[ $ERRORS -eq 0 ]]; then
  echo "✓ All checks passed! Ready to run OmniRoute."
  if ! $IS_VPS; then
    echo ""
    echo "Next steps:"
    echo "  npm run dev          # Start dev server"
    echo "  npm run build        # Production build"
  fi
else
  echo "✗ Found ${ERRORS} error(s). Fix them before proceeding."
  exit 1
fi
