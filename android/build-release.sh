#!/usr/bin/env sh
set -eu

android_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

host_arch=$(uname -m)

run_android_tool() {
    case "$host_arch" in
        aarch64 | arm64)
            if ! command -v muvm >/dev/null 2>&1; then
                echo "muvm is required to run Android x86_64 tools on $host_arch." >&2
                exit 1
            fi
            muvm \
                -e ANDROID_HOME \
                -e ANDROID_SDK_ROOT \
                -e ANDROID_KEYSTORE_PATH \
                -e ANDROID_KEYSTORE_PASSWORD \
                -e ANDROID_KEY_ALIAS \
                -e GRADLE_USER_HOME \
                -i -t -- \
                "$@"
            ;;
        *)
            "$@"
            ;;
    esac
}

for abi in arm64-v8a armeabi-v7a x86_64; do
    library="$android_dir/app/src/main/jniLibs/$abi/libiroh_fm_android_native.so"
    if [ ! -f "$library" ]; then
        echo "Missing $library" >&2
        echo "Run $android_dir/build-rust.sh first." >&2
        exit 1
    fi
done

android_sdk_root=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}
if [ -z "$android_sdk_root" ] || [ ! -d "$android_sdk_root" ]; then
    echo "Set ANDROID_HOME or ANDROID_SDK_ROOT to your Android SDK directory." >&2
    exit 1
fi
ANDROID_HOME=${ANDROID_HOME:-$android_sdk_root}
ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-$android_sdk_root}
export ANDROID_HOME ANDROID_SDK_ROOT

gradle_bin=${GRADLE_BIN:-}
if [ -z "$gradle_bin" ]; then
    gradle_bin=$(find "$HOME/.gradle/wrapper/dists" -path '*/gradle-8.11.1/bin/gradle' -type f 2>/dev/null | head -n 1)
fi
if [ -z "$gradle_bin" ] || [ ! -x "$gradle_bin" ]; then
    echo "Gradle 8.11.1 was not found. Set GRADLE_BIN to its executable." >&2
    exit 1
fi

ANDROID_KEYSTORE_PATH=${ANDROID_KEYSTORE_PATH:-$HOME/.local/share/iroh-fm/android-release.p12}
ANDROID_KEY_ALIAS=${ANDROID_KEY_ALIAS:-iroh-fm}
if [ ! -f "$ANDROID_KEYSTORE_PATH" ]; then
    echo "Release keystore not found: $ANDROID_KEYSTORE_PATH" >&2
    exit 1
fi

if [ -z "${ANDROID_KEYSTORE_PASSWORD:-}" ]; then
    if [ ! -t 0 ]; then
        echo "Set ANDROID_KEYSTORE_PASSWORD or run this script from an interactive terminal." >&2
        exit 1
    fi
    printf 'Release keystore password: ' >&2
    trap 'stty echo 2>/dev/null || true' 0 1 2 15
    stty -echo
    IFS= read -r ANDROID_KEYSTORE_PASSWORD
    stty echo
    trap - 0 1 2 15
    printf '\n' >&2
fi
export ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS

IROH_FM_VERSION_NAME=${IROH_FM_VERSION_NAME:-local}
IROH_FM_VERSION_CODE=${IROH_FM_VERSION_CODE:-$(date +%s)}
GRADLE_USER_HOME=${GRADLE_USER_HOME:-$HOME/.gradle}
export GRADLE_USER_HOME

run_android_tool \
    "$gradle_bin" -p "$android_dir" --no-daemon \
    -PirohFmVersionName="$IROH_FM_VERSION_NAME" \
    -PirohFmVersionCode="$IROH_FM_VERSION_CODE" \
    :app:assembleRelease

apk="$android_dir/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$apk" ]; then
    echo "Signed release APK was not produced at $apk" >&2
    exit 1
fi

apksigner=$(find "$ANDROID_SDK_ROOT/build-tools" -type f -name apksigner 2>/dev/null | sort -V | tail -n 1)
if [ -z "$apksigner" ]; then
    echo "apksigner was not found under $ANDROID_SDK_ROOT/build-tools." >&2
    exit 1
fi

run_android_tool "$apksigner" verify --verbose --print-certs "$apk"

echo "Signed release APK: $apk"
