#!/bin/bash

echo "================================================="
echo "🚀 Starting Super Nova Business Analytics Platform"
echo "================================================="

# Start Backend
echo "--> Setting up Backend Environment..."
cd supernova-backend
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi
source venv/bin/activate
pip install -r requirements.txt > /dev/null 2>&1
echo "--> Starting Backend API Server (Flask on Port 5001)..."
python3 api_server.py &
BACKEND_PID=$!
cd ..

# Start Frontend
echo "--> Starting Frontend UI (Angular on Port 4201)..."
cd supernova-ui
npm run start -- --port 4201 &
FRONTEND_PID=$!
cd ..

echo ""
echo "✅ Super Nova is launching!"
echo "📡 Backend PID: $BACKEND_PID"
echo "🖥️  Frontend PID: $FRONTEND_PID"
echo "👉 UI will be available at: http://localhost:4201"
echo ""
echo "Press [Ctrl+C] to gracefully stop both servers."

# Trap Ctrl+C (SIGINT) to kill background processes
trap "echo -e '\n🛑 Stopping Super Nova servers...'; kill $BACKEND_PID 2>/dev/null; kill $FRONTEND_PID 2>/dev/null; exit 0" INT

# Wait indefinitely until interrupted
wait
