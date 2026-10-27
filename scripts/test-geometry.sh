#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
xcrun swiftc FloorFrame/MatrixMath.swift FloorFrame/SurfacePose.swift FloorFrame/RectangleGeometry.swift Tests/main.swift -o "$output/geometry-tests"
"$output/geometry-tests"
