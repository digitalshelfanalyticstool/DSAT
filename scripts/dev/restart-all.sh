#!/bin/bash
# Kill running server and client processes, then restart both
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

echo "Restarting Enterprise Web Scraper (Backend + Frontend)..."
echo ""

# Kill existing node processes on ports 3000 and 3001
echo "Stopping existing processes..."
lsof -ti:3001 | xargs kill -9 2>/dev/null && echo "  Stopped backend (port 3001)" || echo "  No backend running on port 3001"
lsof -ti:3000 | xargs kill -9 2>/dev/null && echo "  Stopped frontend (port 3000)" || echo "  No frontend running on port 3000"

sleep 1
echo ""

# Start both services
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Opening Backend Server in new terminal..."
    osascript -e 'tell app "Terminal" to do script "cd \"'"$ROOT_DIR"'/server\" && npm run dev"'
    sleep 2
    echo "Opening Frontend Client in new terminal..."
    osascript -e 'tell app "Terminal" to do script "cd \"'"$ROOT_DIR"'/client\" && npm run dev"'
else
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
echo "Both services are restarting in separate terminals."
echo "Backend: http://localhost:3001"
echo "Frontend: http://localhost:3000"
echo "API Docs: http://localhost:3001/api-docs"
echo ""
