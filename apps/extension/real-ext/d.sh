#!/usr/bin/env bash
# Posts a snippet to drive.mjs: ./d.sh 'return (await env.popup()).text()' (or pipe it in).
if [ $# -gt 0 ]; then printf '%s' "$1"; else cat; fi |
  curl -s --max-time 120 -X POST --data-binary @- "http://127.0.0.1:${DPORT:-49600}/"
