# ChadGPT iOS — TestFlight build

This directory is a Capacitor wrapper that loads the live ChadGPT site
(https://chadgpt-964.pages.dev) inside a native iOS shell. Everything that
can be prepped away from a Mac is prepped — the remaining work is:
Xcode, your Apple Developer account, and one upload.

## What this is

Capacitor turns `www/` + `capacitor.config.ts` into a real native project
(`ios/App/App.xcodeproj`) at `cap add ios` time. The app is 99% a WebView
pointed at `chadgpt-964.pages.dev`, with the native shell providing:

- real app icon + launch screen (both pre-rendered in `resources/`)
- native status bar + keyboard handling
- share sheet, haptics, system open-in-Safari for external links
- offline fallback (the `www/index.html` shell displays when the device
  has no connection — it never shows otherwise)

## Honest expectations

**Internal TestFlight: fine.** Up to 100 of your own Apple IDs as testers,
no Apple review, builds show up ~5–30 min after upload.

**External TestFlight or App Store: will be rejected as-is** under
guideline 4.2 (Minimum Functionality) and 4.3 (Spam / clones of a web
browser). To pass review you need native features the web app can't do:

- native push notifications (not WebPush — iOS push is APNs-only in-app)
- offline chat history (the shell needs real local storage, not just the
  wrapped site)
- Sign in with Apple (required if you offer third-party sign-in and want
  to ship to App Store)
- in-app purchase for the Plus upgrade (Apple takes 15–30%, non-negotiable
  for digital goods sold in-app)

Keep that in mind before paying the $99 developer account. **Everything
below gets you to internal TestFlight today.**

## Prerequisites (do these on your Mac)

1. **Xcode 16+** from the Mac App Store. First-run install takes ~45 min.
2. **Apple Developer account** — $99/yr at https://developer.apple.com.
   You can skip this for simulator-only testing but TestFlight requires it.
3. **Node 20+** and **Bun or npm** installed.
4. **CocoaPods**: `sudo gem install cocoapods` (Capacitor uses pods under the hood).
5. **App Store Connect API key** for CLI uploads — one-time setup, next section.

## One-time Apple setup

1. Go to https://appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API
2. Create a key with **Developer** role. Download the `.p8` file **immediately**
   (Apple shows it one time only). Save as `~/.appstore/AuthKey_XXXXX.p8`.
3. Note down:
   - **Key ID** (10 chars, e.g. `2X56AYZ9CL`)
   - **Issuer ID** (UUID at the top of the Keys page)
   - **Team ID** (10 chars, under Membership at developer.apple.com)
4. In App Store Connect, click **My Apps → + → New App**:
   - Platform: iOS
   - Name: `ChadGPT`
   - Bundle ID: `dev.chadgpt.app` (must match `capacitor.config.ts`; create
     it under Certificates, Identifiers & Profiles if it's not in the dropdown)
   - SKU: `chadgpt-ios-1`
   - User Access: Full Access

## Build locally (10 minutes)

```bash
# 1. Clone this repo and cd here
cd ios-app

# 2. Install Capacitor + plugins
npm install

# 3. Generate native project
npx cap add ios

# 4. Render icon + splash into the native project
npx @capacitor/assets generate --ios \
  --iconSource resources/icon.png \
  --splashSource resources/splash.png \
  --splashDarkSource resources/splash-dark.png

# 5. Open in Xcode
npx cap open ios
```

In Xcode:

1. Click the top-level **App** target → **Signing & Capabilities**
2. Check **Automatically manage signing** and pick your Team from the dropdown
3. Hit the **▶** play button once with a simulator picked — make sure it
   boots and loads chadgpt-964.pages.dev

## Upload to TestFlight

```bash
export APP_STORE_API_KEY_ID='2X56AYZ9CL'
export APP_STORE_API_ISSUER_ID='69a6de8c-...'
export APP_STORE_API_KEY_PATH=~/.appstore/AuthKey_2X56AYZ9CL.p8
export APPLE_TEAM_ID='ABCDE12345'

npm run testflight
```

What the script does:

1. `cap sync ios` — copies latest `www/` + plugins into the Xcode project
2. `xcodebuild archive` — builds a release `.xcarchive` with auto-signing
3. `xcodebuild -exportArchive` — uploads via App Store Connect API

After it finishes:

1. Watch **App Store Connect → My Apps → ChadGPT → TestFlight**
2. Build goes through "Processing" (~5–30 min)
3. **Internal Testing** → **+** → add your own Apple ID → done

External testers (>100 or non-dev-team Apple IDs) require a one-time Beta
App Review. Submit it from the same TestFlight tab after adding the build.

## Updating the app

The app loads the live site, so **95% of changes don't need a new TestFlight
build** — a `wrangler pages deploy` pushes the new UI to every installed
copy instantly. Only ship a new binary when:

- the native shell changes (new plugin, new entitlement, new icon)
- the Capacitor runtime version needs bumping
- the bundled `www/index.html` offline shell changes

## Files you'll edit later

| File | What for |
| --- | --- |
| `capacitor.config.ts` | app id, server url, status bar color |
| `resources/icon-source.svg` | app icon (re-run the assets command to regenerate) |
| `www/index.html` | offline fallback shell |
| `ios/App/App/Info.plist` (after `cap add ios`) | privacy strings, URL schemes |

## If Apple rejects for 4.2 Minimum Functionality

Expected for a WebView-only app. The upgrade path:

1. Add real **APNs push** via `@capacitor/push-notifications`
2. Add **Sign in with Apple** via `@capacitor-community/apple-sign-in`
3. Replace web-based Plus upgrade with **in-app purchase**
   (`@capgo/capacitor-purchases` or RevenueCat)
4. Add **offline chat history** — store the last N messages in IndexedDB
   or SQLite (`@capacitor-community/sqlite`), show them in the offline shell

Tell me when you're ready for any of those and I'll wire them in.
