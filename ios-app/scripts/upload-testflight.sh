#!/usr/bin/env bash
# upload-testflight.sh — build + upload to TestFlight.
# Run from your Mac after `cap add ios` has created ios/App/App.xcodeproj.
#
# Required env vars:
#   APP_STORE_API_KEY_ID        App Store Connect API key id (e.g. 2X56AYZ9CL)
#   APP_STORE_API_ISSUER_ID     The issuer UUID from App Store Connect
#   APP_STORE_API_KEY_PATH      Path to the .p8 private key file
#   APPLE_TEAM_ID               Your 10-char team id
#
# Generate the API key at:
#   https://appstoreconnect.apple.com/access/integrations/api
# Download the .p8 ONCE — Apple only shows it one time.

set -euo pipefail

: "${APP_STORE_API_KEY_ID:?set APP_STORE_API_KEY_ID}"
: "${APP_STORE_API_ISSUER_ID:?set APP_STORE_API_ISSUER_ID}"
: "${APP_STORE_API_KEY_PATH:?set APP_STORE_API_KEY_PATH}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"

SCHEME="App"
WORKSPACE="ios/App/App.xcworkspace"
ARCHIVE_PATH="build/ChadGPT.xcarchive"
EXPORT_PATH="build/export"

mkdir -p build

echo "[1/4] cap sync ios"
npx cap sync ios

echo "[2/4] xcodebuild archive"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  clean archive

echo "[3/4] xcodebuild export (TestFlight / App Store)"
cat > build/ExportOptions.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>                <string>app-store-connect</string>
  <key>teamID</key>                <string>${APPLE_TEAM_ID}</string>
  <key>uploadSymbols</key>         <true/>
  <key>stripSwiftSymbols</key>     <true/>
  <key>signingStyle</key>          <string>automatic</string>
  <key>destination</key>           <string>upload</string>
</dict>
</plist>
EOF

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist build/ExportOptions.plist \
  -allowProvisioningUpdates \
  -authenticationKeyID "$APP_STORE_API_KEY_ID" \
  -authenticationKeyIssuerID "$APP_STORE_API_ISSUER_ID" \
  -authenticationKeyPath "$APP_STORE_API_KEY_PATH"

echo "[4/4] upload finished. Check status at:"
echo "    https://appstoreconnect.apple.com/apps"
echo
echo "The build will appear in TestFlight → Internal Testing within 5–30 minutes"
echo "once Apple finishes processing. No review is needed for internal testers."
