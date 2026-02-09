#!/bin/bash
# Rey Voice Server Setup Script

set -e

echo "🦞 Setting up Rey Voice Server..."

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate venv
source venv/bin/activate

# Install dependencies
echo "Installing dependencies..."
pip install --upgrade pip

# Install onnxruntime first (openwakeword needs it)
pip install onnxruntime>=1.16.0

# Install the rest
pip install -r requirements.txt --no-deps || pip install -r requirements.txt

# Download OpenWakeWord models
echo "Downloading wake word models..."
python -c "import openwakeword; openwakeword.utils.download_models()" || echo "Wake word models may need manual download"

# Download Whisper model
echo "Downloading Whisper model (this may take a minute)..."
python -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8')"

# Copy env template if .env doesn't exist
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo ""
    echo "⚠️  Please edit .env with your OpenClaw Gateway token:"
    echo "    nano .env"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start the server:"
echo "    source venv/bin/activate"
echo "    python server.py"
