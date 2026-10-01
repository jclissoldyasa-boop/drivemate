#!/bin/bash
# Publishes a new version: web app + API to Cloudflare, APK to a GitHub release.
# The Android app sees the new release and offers the update.
#   ./release.sh "What changed"
set -euo pipefail
cd "$(dirname "$0")"
[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first."; exit 1; }
export VERSION_CODE=$(( $(date +%s) / 60 ))
export VERSION_NAME="1.0.$VERSION_CODE"
./build.sh
(cd server && npm run deploy)
git push
gh release create "v$VERSION_NAME" DriveMate.apk --title "DriveMate $VERSION_NAME" --notes "${1:-Bug fixes and improvements.}"
