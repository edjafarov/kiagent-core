#!/bin/zsh
SP=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/86c71c46-4e75-4768-9ac3-3941a6b5ae49/scratchpad
B=/Users/edjafarov/work/alpha-cent/release/build/mac-arm64/KIAgent.app/Contents/Resources/assets/llama/darwin-arm64/llama-server
E4B="$HOME/Library/Application Support/KIAgent-dev/data/models/gemma-4-E4B-it-Q4_K_M/gemma-4-E4B-it-Q4_K_M.gguf"
M12=~/work/eval-models/gemma-4-12b-it-Q4_K_M.gguf
run() { # label model ctx extra...
  local label=$1 model=$2 ctx=$3; shift 3
  $B -m "$model" --host 127.0.0.1 --port 18099 -c $ctx -ngl 999 --cache-ram 0 --jinja "$@" > $SP/kv-$label.log 2>&1 &
  local pid=$!
  for i in $(seq 1 180); do curl -sf http://127.0.0.1:18099/health >/dev/null && break; sleep 1; done
  local idle=$(( $(ps -o rss= -p $pid) / 1024 ))
  local res=$(node $SP/kv-probe.mjs concurrent | tr '\n' ';')
  local after=$(( $(ps -o rss= -p $pid) / 1024 ))
  echo "$label ctx=$ctx $* | RSS idle ${idle}MB after ${after}MB | $res"
  kill $pid; wait $pid 2>/dev/null; sleep 2
}
run 12b-16k $M12 16384
run 12b-24k $M12 24576
run 12b-24k-cp4 $M12 24576 --ctx-checkpoints 4
run e4b-16k "$E4B" 16384
run e4b-24k "$E4B" 24576
