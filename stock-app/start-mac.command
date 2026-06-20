#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "  ========================================"
echo "   Stock Analyst - BAM Methodology"
echo "   محلل الأسهم الاحترافي"
echo "  ========================================"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
    echo "  [!] Node.js not found."
    echo "  [!] Opening download page..."
    open "https://nodejs.org"
    echo "  [!] Install Node.js (LTS), then run this file again."
    read -p "  Press Enter to exit..."
    exit 1
fi

echo "  [OK] Node.js: $(node --version)"

# Install dependencies if needed
if [ ! -d "node_modules/express" ]; then
    echo ""
    echo "  [..] Installing dependencies (first time only)..."
    npm install
    if [ $? -ne 0 ]; then
        echo "  [!!] npm install failed."
        read -p "  Press Enter to exit..."
        exit 1
    fi
fi

echo ""
echo "  [OK] Starting server..."
echo "  [OK] Opening http://localhost:3000"
echo ""
echo "  Password: bam2024"
echo ""
echo "  Keep this window open while using the app."
echo "  ----------------------------------------"

# Open browser after short delay
(sleep 2 && open "http://localhost:3000") &

# Start server
node server.js
