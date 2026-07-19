#!/usr/bin/env sh
set -eu

tool_name=${0##*/}
case "$tool_name" in
    aarch64-linux-android26-clang | \
    aarch64-linux-android26-clang++ | \
    armv7a-linux-androideabi26-clang | \
    armv7a-linux-androideabi26-clang++ | \
    x86_64-linux-android26-clang | \
    x86_64-linux-android26-clang++)
        ;;
    *)
        echo "Unsupported NDK tool wrapper name: $tool_name" >&2
        exit 2
        ;;
esac

: "${IROH_FM_NDK_BIN:?IROH_FM_NDK_BIN is not set}"

attempt=1
while [ "$attempt" -le 3 ]; do
    if muvm -i -- "$IROH_FM_NDK_BIN/$tool_name" "$@"; then
        exit 0
    else
        status=$?
    fi
    if [ "$attempt" -eq 3 ]; then
        exit "$status"
    fi
    echo "muvm NDK tool launch failed; retrying ($attempt/3)" >&2
    attempt=$((attempt + 1))
    sleep 1
done
