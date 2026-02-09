#!/bin/bash
# Auto-restart wrapper for Rey Voice Server

cd "$(dirname "$0")"
source venv/bin/activate

while true; do
    echo "[$(date)] Starting Rey Voice Server..."
    python server.py 2>&1 | tee -a server.log
    EXIT_CODE=$?
    echo "[$(date)] Server exited with code $EXIT_CODE, restarting in 5 seconds..."
    sleep 5
done
