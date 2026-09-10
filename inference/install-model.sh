#!/usr/bin/env bash
# Implements the reviewed renderer/parser fix from pmarreck/gemma4-heretical.
set -euo pipefail
quant="${1:-Q4_K_M}"
case "$quant" in Q4_K_M|Q6_K|Q8_0|IQ4_NL) ;; *) echo "Choose Q4_K_M, Q6_K, Q8_0, or IQ4_NL." >&2; exit 1;; esac
command -v ollama >/dev/null || { echo "Install Ollama 0.20.2 or newer first." >&2; exit 1; }
version="$(ollama --version 2>&1 | sed -nE 's/.*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1)"
if ! awk -v v="$version" 'BEGIN { split(v,a,"."); exit !((a[1]>0)||(a[1]==0 && (a[2]>20 || (a[2]==20 && a[3]>=2)))) }'; then
  echo "Ollama 0.20.2 or newer is required (found: $version)." >&2; exit 1
fi
source_model="hf.co/jfiekdjdk/gemma-4-31b-it-heretic-ara-gguf:${quant}"
ollama pull "$source_model"
blob="$(ollama show "$source_model" --modelfile | sed -n 's/^FROM //p' | head -n 1)"
test -n "$blob" || { echo "Cannot determine model source." >&2; exit 1; }
modelfile="$(mktemp)"
trap 'rm -f "$modelfile"' EXIT
cat > "$modelfile" <<EOF
FROM ${blob}
TEMPLATE {{ .Prompt }}
RENDERER gemma4
PARSER gemma4
PARAMETER temperature 0.8
PARAMETER top_k 64
PARAMETER top_p 0.95
PARAMETER num_ctx 8192
EOF
ollama create gemma4-heretical -f "$modelfile"
ollama show gemma4-heretical --modelfile
echo "Gemma 4 Heretical is registered. Run a short conversation to verify quality and speed."
