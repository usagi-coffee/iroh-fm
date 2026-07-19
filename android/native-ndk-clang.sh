#!/usr/bin/env sh
set -eu

tool_name=${0##*/}
case "$tool_name" in
    aarch64-linux-android26-clang)
        compiler=$IROH_FM_NATIVE_CLANG
        target=aarch64-linux-android26
        ;;
    aarch64-linux-android26-clang++)
        compiler=$IROH_FM_NATIVE_CLANGXX
        target=aarch64-linux-android26
        ;;
    armv7a-linux-androideabi26-clang)
        compiler=$IROH_FM_NATIVE_CLANG
        target=armv7a-linux-androideabi26
        ;;
    armv7a-linux-androideabi26-clang++)
        compiler=$IROH_FM_NATIVE_CLANGXX
        target=armv7a-linux-androideabi26
        ;;
    x86_64-linux-android26-clang)
        compiler=$IROH_FM_NATIVE_CLANG
        target=x86_64-linux-android26
        ;;
    x86_64-linux-android26-clang++)
        compiler=$IROH_FM_NATIVE_CLANGXX
        target=x86_64-linux-android26
        ;;
    *)
        echo "Unsupported native NDK compiler wrapper name: $tool_name" >&2
        exit 2
        ;;
esac

: "${IROH_FM_NDK_PREBUILT:?IROH_FM_NDK_PREBUILT is not set}"
exec "$compiler" \
    "--target=$target" \
    "--sysroot=$IROH_FM_NDK_PREBUILT/sysroot" \
    "$@"
