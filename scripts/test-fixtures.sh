#!/bin/sh
# Swift side of the shared Swift/TypeScript fixtures in Tests/fixtures.
set -eu
cd "$(dirname "$0")/.."
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
xcrun swiftc -O FloorFrame/MatrixMath.swift FloorFrame/SurfacePose.swift FloorFrame/FloorCalibration.swift \
  FloorFrame/CalibrationSampler.swift FloorFrame/AccuracyBudget.swift FloorFrame/HeightCorrection.swift \
  FloorFrame/SurveyManifest.swift FloorFrame/ReferenceFusion.swift FloorFrame/ReferenceFrameController.swift \
  FloorFrame/HitMarkers.swift FloorFrame/RectangleGeometry.swift Tests/FixtureTests/main.swift -o "$output/fixture-tests"
"$output/fixture-tests"
