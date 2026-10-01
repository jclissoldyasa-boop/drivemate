# DriveMate for Android

Vehicle logbook for Australian car tax claims: trips, odometer readings, expenses, and a cents-per-km vs logbook comparison.

`app.html` is the whole app. The Android shell in `src/` wraps it in a WebView and provides the `DriveMateNative` bridge:

- **TrackerService**: foreground GPS that keeps counting kilometres with the screen off, and optional automatic trips that start when the phone goes on a wireless charger
- **MainActivity**: permissions, receipt camera, and saving exports to Downloads

## Accounts and sync

`server/` is a Cloudflare Worker with a D1 database. It hosts the web version and the API: email + password accounts (with a recovery code instead of email resets), per-user sync, and in-app bug reports. Deploy with `cd server && npm run deploy`.

Bug reports are stored in D1. If the Worker has `GITHUB_TOKEN` (a fine-grained token with Issues: write on this repo) and `GITHUB_REPO` set, each report is also opened as an issue here. The reporter's email is never published.

## Releases and updates

`./release.sh "What changed"` builds the APK, deploys the server, pushes, and creates a GitHub release with `DriveMate.apk`. The Android app checks the latest release about twice a day and offers the update.

## Build

Needs JDK 17+ and the Android SDK (`platforms;android-34`, `build-tools;35.0.0`) at `~/android-sdk` or `$ANDROID_HOME`. No Gradle.

```
./build.sh   # → DriveMate.apk
```

The first build creates `drivemate.keystore`. It is not committed. Back it up, because Android only installs updates signed with the same key.
