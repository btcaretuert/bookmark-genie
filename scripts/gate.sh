#!/bin/sh
# Project gate: types, tests, and a floor on the test count. The floor exists because a test
# runner can lose results and still exit 0, as --test-force-exit did on Node 26.
set -u

MIN_TESTS=1100

cd "$(dirname "$0")/.." || exit 2

out=$(npm run --silent check 2>&1)
status=$?
printf '%s\n' "$out" | tail -n 12

if [ "$status" -ne 0 ]; then
  echo "gate: npm run check failed with exit $status"
  exit 1
fi

count=$(printf '%s\n' "$out" | sed -n 's/^ℹ tests //p' | tail -n 1)
if [ -z "$count" ] || [ "$count" -lt "$MIN_TESTS" ]; then
  echo "gate: only ${count:-no} tests reported, expected at least $MIN_TESTS"
  exit 1
fi

echo "gate: ok, $count tests"
