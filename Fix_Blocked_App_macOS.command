#!/bin/bash
# macOS refuses to launch this app after downloading it, with either
#
#   "the application is damaged and can't be opened"        (broken signature)
#   "Apple could not verify ... is free of malware"          (not notarized)
#
# Neither means the download is bad. The app is ad-hoc signed but NOT notarized,
# because notarization needs a paid Apple Developer ID this project does not
# have. macOS attaches a `com.apple.quarantine` flag to anything downloaded, and
# for a non-notarized app that flag is what triggers the refusal.
#
# This removes the quarantine flag from the installed app. Run it once after
# each install or update. Double-click this file in Finder, or run it from a
# terminal. It touches nothing except this one app.
set -e
APP="/Applications/Pumpfun Sniper Bot.app"

if [ ! -d "$APP" ]; then
  echo "Not found: $APP"
  echo "Open the .dmg and drag 'Pumpfun Sniper Bot' into Applications first, then run this again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

echo "Removing the download quarantine flag from:"
echo "  $APP"
xattr -dr com.apple.quarantine "$APP"

# Confirm the signature is intact. If this fails the app really is broken and
# should be re-downloaded rather than forced open.
if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "Signature verified. You can open the app normally now."
else
  echo "WARNING: the signature does NOT verify. Re-download the .dmg instead of opening this."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

read -n 1 -s -r -p "Done. Press any key to close."
