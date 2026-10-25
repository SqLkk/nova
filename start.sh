#!/bin/bash

# ==============================================================================
# 🚀 SuperNova Platform Unified Starter Script
# Launches:
#   1. Local AI Copilot Service (MLX Qwen3.5-9B + LoRA v2.4 Adapter 240 on Port 8085)
#   2. Backend API Server (Flask on Port 5001)
#   3. Frontend UI (Angular on Port 4200)
#
# Usage:
#   ./start.sh              -> Starts AI + Backend + Frontend
#   ./start.sh --no-ai      -> Starts only Backend + Frontend
#   ./start.sh --port=4201  -> Runs frontend on custom port
# ==============================================================================

START_AI=true
UI_PORT=4200
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for arg in "$@"; do
    case $arg in
        --no-ai)
            START_AI=false
            ;;
        --port=*)
            UI_PORT="${arg#*=}"
            ;;
        --help|-h)
            echo "Kullanım: ./start.sh [--no-ai] [--port=4200]"
            exit 0
            ;;
    esac
done

echo "================================================="
echo "🚀 SuperNova Platform Başlatılıyor..."
echo "================================================="

AI_PID=""
BACKEND_PID=""
FRONTEND_PID=""

# Graceful cleanup on Ctrl+C or kill signals
cleanup() {
    echo ""
    echo "🛑 SuperNova servisleri durduruluyor..."
    if [ -n "$FRONTEND_PID" ]; then
        echo "  • Frontend durduruluyor (PID: $FRONTEND_PID)..."
        kill "$FRONTEND_PID" 2>/dev/null
    fi
    if [ -n "$BACKEND_PID" ]; then
        echo "  • Backend durduruluyor (PID: $BACKEND_PID)..."
        kill "$BACKEND_PID" 2>/dev/null
    fi
    if [ -n "$AI_PID" ]; then
        echo "  • AI Copilot sunucusu durduruluyor (PID: $AI_PID)..."
        kill "$AI_PID" 2>/dev/null
    fi
    pkill -P $$ 2>/dev/null
    echo "✅ Tüm servisler temiz bir şekilde kapatıldı."
    exit 0
}
trap cleanup INT TERM

# Port çakışmalarını önceden temizleme fonksiyonu
free_port_if_busy() {
    local port=$1
    local name=$2
    local pids=$(lsof -ti :$port 2>/dev/null)
    if [ -n "$pids" ]; then
        echo "⚠️  Port $port ($name) kullanımda. Önceki süreçler sonlandırılıyor (PID: $pids)..."
        for p in $pids; do
            kill "$p" 2>/dev/null
        done
        sleep 1
    fi
}

# ------------------------------------------------------------------------------
# 1. Yerel AI Copilot Sunucusu (MLX Qwen 3.5 9B + v2.4 Adapter 240)
# ------------------------------------------------------------------------------
if [ "$START_AI" = "true" ]; then
    free_port_if_busy 8085 "AI Copilot"
    AI_ADAPTER="training/supernova-v24/adapter240/0000240_adapters.safetensors"
    AI_PYTHON=".venv-ai/bin/python"

    if [ -f "$AI_ADAPTER" ] && [ -x "$AI_PYTHON" ]; then
        echo "--> [1/3] Yerel AI Copilot Sunucusu Başlatılıyor (Port 8085)..."
        "$AI_PYTHON" scripts/local_ai.py serve --adapter-path "$AI_ADAPTER" &
        AI_PID=$!
        echo "    🤖 AI Copilot PID: $AI_PID (Qwen3.5-9B + v2.4 Adım 240 Adaptörü)"
        echo "    ⏳ Model ağırlıkları yükleniyor (lütfen bekleyin)..."
        for i in {1..35}; do
            if curl -s http://127.0.0.1:8085/health 2>/dev/null | grep -q '"status": *"ok"'; then
                echo "    ✅ Model hazır ve belleğe yüklendi!"
                break
            fi
            sleep 1
        done
    else
        echo "--> [1/3] ⚠️  AI adaptörü veya .venv-ai ortamı bulunamadı, AI sunucusu atlanıyor."
    fi
else
    echo "--> [1/3] ⏸️  AI Copilot (--no-ai parametresi ile) devre dışı bırakıldı."
fi

# ------------------------------------------------------------------------------
# 2. Backend API Sunucusu (Flask)
# ------------------------------------------------------------------------------
free_port_if_busy 5001 "Backend API"
echo "--> [2/3] Backend API Sunucusu Başlatılıyor (Port 5001)..."
cd "$PROJECT_ROOT/supernova-backend" || exit 1

if [ ! -d "venv" ]; then
    echo "    Backend sanal ortamı kuruluyor..."
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt > /dev/null 2>&1
else
    source venv/bin/activate
fi

if [ "$START_AI" = "false" ]; then
    AI_ENABLED=false python3 api_server.py &
else
    python3 api_server.py &
fi
BACKEND_PID=$!
echo "    📡 Backend PID: $BACKEND_PID"
cd "$PROJECT_ROOT" || exit 1

# ------------------------------------------------------------------------------
# 3. Frontend UI (Angular)
# ------------------------------------------------------------------------------
free_port_if_busy "$UI_PORT" "Frontend UI"
echo "--> [3/3] Frontend Arayüzü Başlatılıyor (Port $UI_PORT)..."
cd "$PROJECT_ROOT/supernova-ui" || exit 1

npm run start -- --port "$UI_PORT" &
FRONTEND_PID=$!
echo "    🖥️  Frontend PID: $FRONTEND_PID"
cd "$PROJECT_ROOT" || exit 1

# ------------------------------------------------------------------------------
# Bilgilendirme ve Bekleme
# ------------------------------------------------------------------------------
echo ""
echo "================================================="
echo "✅ SuperNova Servisleri Başlatıldı!"
echo "👉 Web Arayüzü:   http://localhost:$UI_PORT"
echo "📡 Backend API:   http://localhost:5001"
if [ -n "$AI_PID" ]; then
echo "🤖 AI Copilot:    http://127.0.0.1:8085/v1 (Aktif)"
fi
echo "================================================="
echo "Tüm servisleri durdurmak için [Ctrl+C] tuşlarına basın."
echo ""

# Arka plan süreçlerini bekle
wait
