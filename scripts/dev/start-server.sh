#!/bin/bash
# Start the Express.js backend server in development mode
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."
echo "Starting Enterprise Web Scraper Backend Server..."
cd server
npm run dev
