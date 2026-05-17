#!/bin/bash
# NHK Deck Generator — cron wrapper
# Runs two claude steps: scrape NHK article, then insert into DB
#
# Usage: crontab -e, then add:
#   3 9 * * * /home/ileylow/yomitan-api/cli/nhk-cron.sh >> /home/ileylow/yomitan-api/data/nhk-cron.log 2>&1

set -e

export PATH="$HOME/.local/bin:$PATH"
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"

echo "=== NHK Deck Generator: $(date) ==="

echo "--- Step 1: Scraping NHK and generating terms ---"
claude -p "$(cat "$SCRIPT_DIR/nhk-step1-prompt.txt")" \
  --allowedTools "Bash,Read,Write,WebFetch" \
  --max-turns 50

echo ""
echo "--- Step 2: Inserting into database ---"
claude -p "$(cat "$SCRIPT_DIR/nhk-step2-prompt.txt")" \
  --allowedTools "Bash,Read" \
  --max-turns 50

echo ""
echo "=== Done: $(date) ==="
