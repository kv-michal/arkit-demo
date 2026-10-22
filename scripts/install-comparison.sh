#!/bin/sh
# After npm ci, Expo prebuild and pod install in floor-frame-viro/.
set -eu
cd "$(dirname "$0")/.."
comparison_device=${1:?Usage: scripts/install-comparison.sh IPHONE_UDID}
if [ ! -d floor-frame-viro/ios/FloorFrameViro.xcworkspace ]; then
  echo 'First run npm ci, npm run prebuild and pod install inside floor-frame-viro/.' >&2
  exit 1
fi
xcodebuild -project FloorFrame.xcodeproj -scheme FloorFrame -configuration Release \
  -destination "id=$comparison_device" -derivedDataPath build/native-release -allowProvisioningUpdates build
xcodebuild -workspace floor-frame-viro/ios/FloorFrameViro.xcworkspace -scheme FloorFrameViro -configuration Release \
  -destination "id=$comparison_device" -derivedDataPath build/viro -allowProvisioningUpdates build
xcrun devicectl device install app --device "$comparison_device" build/native-release/Build/Products/Release-iphoneos/FloorFrame.app
xcrun devicectl device install app --device "$comparison_device" build/viro/Build/Products/Release-iphoneos/FloorFrameViro.app
