#!/bin/bash
# Start the Next.js frontend client in development mode
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."
echo "Starting Enterprise Web Scraper Frontend Client..."
cd client
npm run dev
