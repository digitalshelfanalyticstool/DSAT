#!/bin/bash
# Start both backend server and frontend client in separate terminals
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

echo "Starting Enterprise Web Scraper (Backend + Frontend)..."
echo ""

# Check if we're on macOS or Linux
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    echo "Opening Backend Server in new terminal..."
    osascript -e 'tell app "Terminal" to do script "cd \"'"$ROOT_DIR"'/server\" && npm run dev"'
    sleep 2
    echo "Opening Frontend Client in new terminal..."
    osascript -e 'tell app "Terminal" to do script "cd \"'"$ROOT_DIR"'/client\" && npm run dev"'
else
    # Linux
    echo "Opening Backend Server in new terminal..."
    gnome-terminal -- bash -c "cd '$ROOT_DIR/server' && npm run dev; exec bash" 2>/dev/null || \
    xterm -e "cd '$ROOT_DIR/server' && npm run dev" 2>/dev/null || \
    konsole -e "cd '$ROOT_DIR/server' && npm run dev" 2>/dev/null || \
    (echo "Could not detect terminal. Starting in background..." && cd server && npm run dev &)

    sleep 2
    echo "Opening Frontend Client in new terminal..."
    gnome-terminal -- bash -c "cd '$ROOT_DIR/client' && npm run dev; exec bash" 2>/dev/null || \
    xterm -e "cd '$ROOT_DIR/client' && npm run dev" 2>/dev/null || \
    konsole -e "cd '$ROOT_DIR/client' && npm run dev" 2>/dev/null || \
    (echo "Could not detect terminal. Starting in background..." && cd client && npm run dev &)
fi

echo ""
echo "Both services are starting in separate terminals."
echo "Backend: http://localhost:3001"
echo "Frontend: http://localhost:3000"
echo "API Docs: http://localhost:3001/api-docs"
echo ""
