#!/bin/zsh
set -e
cd "${0:A:h}"
runtime_node="$(command -v node || true)"
bundled_base="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if [[ -x "$bundled_base/node/bin/node" ]]; then
  runtime_node="$bundled_base/node/bin/node"
fi
if [[ -z "$runtime_node" ]]; then
  print 'Node.js 24 이상이 필요합니다.'
  read '?Enter 키를 누르면 닫힙니다. '
  exit 1
fi
if [[ ! -d node_modules/yauzl ]]; then
  print '먼저 이 폴더에서 npm ci를 실행해 패키지를 설치해 주세요. NETLIFY-START.md의 로컬 테스트 항목을 참고하세요.'
  read '?Enter 키를 누르면 닫힙니다. '
  exit 1
fi
exec "$runtime_node" launch.mjs
