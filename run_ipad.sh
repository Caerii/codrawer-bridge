#!/usr/bin/env bash
# Build the iPad client (codrawer-ipad/) and run it in an iOS Simulator (macOS, Xcode, xcodegen).
#   IPAD_SIM_ID=<simulator udid> ./run_ipad.sh
# List simulators and their UDIDs with `xcrun simctl list devices available`; boot the one you
# pick first (`xcrun simctl boot <udid>` or open it in Simulator.app). Build products go to
# codrawer-ipad/DerivedData (gitignored). xcbeautify is used when installed.
set -euo pipefail

if [ -z "${IPAD_SIM_ID:-}" ]; then
  echo "run_ipad.sh: set IPAD_SIM_ID to a simulator UDID (xcrun simctl list devices available)" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$ROOT/codrawer-ipad"
SCHEME="Codrawer"
BUNDLE_ID="${IPAD_BUNDLE_ID:-com.example.Codrawer}" # PRODUCT_BUNDLE_IDENTIFIER in project.yml
DERIVED_DATA="$PROJECT_DIR/DerivedData"

echo "Building project..."
cd "$PROJECT_DIR"
xcodegen generate
build=(xcodebuild -project Codrawer.xcodeproj -scheme "$SCHEME" -sdk iphonesimulator
  -destination "platform=iOS Simulator,id=$IPAD_SIM_ID" -derivedDataPath "$DERIVED_DATA" build)
if command -v xcbeautify > /dev/null; then "${build[@]}" | xcbeautify; else "${build[@]}"; fi

echo "Installing and launching..."
xcrun simctl install "$IPAD_SIM_ID" "$DERIVED_DATA/Build/Products/Debug-iphonesimulator/Codrawer.app"
xcrun simctl launch "$IPAD_SIM_ID" "$BUNDLE_ID"
echo "Done!"
