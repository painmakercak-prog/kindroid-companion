#!/usr/bin/env bash
set -euo pipefail

MODEL="mannix/llama3.1-8b-abliterated:q5_k_m"

command -v ollama >/dev/null || {
  echo "Install Ollama first: https://ollama.com/download" >&2
  exit 1
}

echo "Pulling ${MODEL}..."
ollama pull "$MODEL"

echo
ollama show "$MODEL"
echo
echo "Installed ${MODEL}."
echo "Test it with: ollama run ${MODEL} \"Say hello in one sentence.\""
