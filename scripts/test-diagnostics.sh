#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
xcrun swiftc FloorFrame/DiagnosticLog.swift Tests/Diagnostics/main.swift -o "$output/diagnostic-tests"
"$output/diagnostic-tests"
