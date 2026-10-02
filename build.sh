#!/bin/bash
# Builds DriveMate.apk from app.html + the Android shell. No Gradle needed.
set -euo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_HOME:-$HOME/android-sdk}
BT=$SDK/build-tools/35.0.0
JAR=$SDK/platforms/android-34/android.jar
VERSION_CODE=${VERSION_CODE:-$(( $(date +%s) / 60 ))}  # minutes since 1970: always increases
VERSION_NAME=${VERSION_NAME:-1.0.$VERSION_CODE}
rm -rf build && mkdir -p build/gen build/classes build/dex
node server/build.mjs

# Android libraries (ML Kit text recognition and what it needs), fetched by tools/fetch-libs.py.
[ -d libs ] || python3 tools/fetch-libs.py
mkdir -p build/aar build/libres
CP="$JAR"; LIBRES=(); LIBMAN=(); PKGS=()
for f in libs/*; do
  n=$(basename "$f"); n=${n%.*}
  case "$f" in
    *.jar) CP="$CP:$f" ;;
    *.aar)
      d=build/aar/$n; mkdir -p "$d"; unzip -qo "$f" -d "$d"
      [ -f "$d/classes.jar" ] && CP="$CP:$d/classes.jar"
      for j in "$d"/libs/*.jar; do [ -f "$j" ] && CP="$CP:$j"; done
      if [ -d "$d/res" ] && [ -n "$(ls -A "$d/res")" ]; then
        $BT/aapt2 compile --dir "$d/res" -o "build/libres/$n.zip"; LIBRES+=(-R "build/libres/$n.zip")
      fi
      LIBMAN+=("$d/AndroidManifest.xml")
      PKGS+=("$(grep -o 'package="[^"]*"' "$d/AndroidManifest.xml" | head -1 | cut -d'"' -f2)") ;;
  esac
done
python3 tools/merge-manifest.py AndroidManifest.xml build/AndroidManifest.xml "${LIBMAN[@]}"
EXTRA=$(IFS=:; echo "${PKGS[*]}")

$BT/aapt2 compile --dir res -o build/res.zip
$BT/aapt2 link -I "$JAR" --manifest build/AndroidManifest.xml -A assets build/res.zip "${LIBRES[@]}" --auto-add-overlay \
  --extra-packages "$EXTRA" --java build/gen --min-sdk-version 29 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" -o build/unsigned.apk
javac -nowarn -Xlint:-options --release 11 -cp "$CP" -d build/classes $(find src build/gen -name '*.java') 2>&1 \
  | grep -v "^Note:" || true
[ -f build/classes/app/drivemate/MainActivity.class ] || { echo "javac failed"; exit 1; }
$BT/d8 --min-api 29 --lib "$JAR" --output build/dex $(find build/classes -name '*.class') $(echo "${CP#$JAR:}" | tr ':' ' ')
(cd build/dex && zip -qj ../unsigned.apk classes*.dex)
$BT/zipalign -f 4 build/unsigned.apk build/aligned.apk

# Keep this keystore: Android only installs updates signed with the same key.
[ -f drivemate.keystore ] || keytool -genkeypair -keystore drivemate.keystore -alias drivemate \
  -keyalg RSA -keysize 2048 -validity 10000 -storepass drivemate -keypass drivemate \
  -dname "CN=DriveMate" >/dev/null 2>&1
$BT/apksigner sign --ks drivemate.keystore --ks-pass pass:drivemate --out DriveMate.apk build/aligned.apk
$BT/apksigner verify DriveMate.apk && ls -lh DriveMate.apk
