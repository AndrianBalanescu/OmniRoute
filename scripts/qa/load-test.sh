#!/usr/bin/env bash
# OmniRoute load testing script
# Usage: ./load-test.sh [--requests N] [--concurrency N] [--endpoint URL]

set -euo pipefail

# Defaults
REQUESTS=100
CONCURRENCY=10
ENDPOINT="http://localhost:20128/api/health/ping"
METHOD="GET"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --requests|-n)
      REQUESTS="$2"
      shift 2
      ;;
    --concurrency|-c)
      CONCURRENCY="$2"
      shift 2
      ;;
    --endpoint|-e)
      ENDPOINT="$2"
      shift 2
      ;;
    --method|-m)
      METHOD="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo "Options:"
      echo "  --requests, -n N       Number of requests (default: 100)"
      echo "  --concurrency, -c N    Concurrent requests (default: 10)"
      echo "  --endpoint, -e URL     Target endpoint (default: http://localhost:20128/health)"
      echo "  --method, -m METHOD    HTTP method (default: GET)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "=== OmniRoute Load Test ==="
echo "Endpoint: ${ENDPOINT}"
echo "Requests: ${REQUESTS}"
echo "Concurrency: ${CONCURRENCY}"
echo "Method: ${METHOD}"
echo ""

# Check if hey is installed
if ! command -v hey &> /dev/null; then
  echo "Installing hey (HTTP load generator)..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    brew install hey 2>/dev/null || {
      echo "Failed to install hey. Install manually: brew install hey"
      exit 1
    }
  else
    echo "Please install hey: https://github.com/rakyll/hey"
    exit 1
  fi
fi

# Run load test
echo "Running load test..."
echo ""

hey -n "$REQUESTS" -c "$CONCURRENCY" -m "$METHOD" "$ENDPOINT"

echo ""
echo "✓ Load test complete"
