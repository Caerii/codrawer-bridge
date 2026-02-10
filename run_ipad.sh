#!/bin/bash
set -e

PROJECT_DIR="codrawer-ipad"
SCHEME="Codrawer"
DESTINATION="platform=iOS Simulator,id=6B015EB1-5B42-4258-9997-A591B23CD1E0"
DERIVED_DATA="/Users/ember/Library/Developer/Xcode/DerivedData/Codrawer-evwrvhweujofloatgvhitiuktikh"

echo "Building project..."
cd $PROJECT_DIR
xcodegen generate
xcodebuild -project Codrawer.xcodeproj -scheme $SCHEME -sdk iphonesimulator -destination "$DESTINATION" build | xcbeautify

echo "Installing and launching..."
xcrun simctl install 6B015EB1-5B42-4258-9997-A591B23CD1E0 $DERIVED_DATA/Build/Products/Debug-iphonesimulator/Codrawer.app
xcrun simctl launch 6B015EB1-5B42-4258-9997-A591B23CD1E0 com.example.Codrawer
echo "Done!"
