#!/usr/bin/env sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
android_dir="$repo_dir/android"
output_dir="$android_dir/app/src/main/jniLibs"

find_android_ndk() {
    if [ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ]; then
        printf '%s\n' "$ANDROID_NDK_HOME"
        return
    fi

    android_sdk_root=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}
    if [ -n "$android_sdk_root" ] && [ -d "$android_sdk_root/ndk" ]; then
        find "$android_sdk_root/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1
    fi
}

build_with_cargo_ndk() {
    cargo ndk \
        --manifest-path "$repo_dir/Cargo.toml" \
        --target arm64-v8a \
        --target armeabi-v7a \
        --target x86_64 \
        --platform 26 \
        --output-dir "$output_dir" \
        build --release -p iroh-fm-android-native
}

prepare_arm_tools() {
    tool_root="${CARGO_TARGET_DIR:-$repo_dir/target}/android-tool-wrappers"
    native_wrapper_dir="$tool_root/native"
    muvm_wrapper_dir="$tool_root/muvm"
    mkdir -p "$native_wrapper_dir" "$muvm_wrapper_dir"

    for tool in \
        aarch64-linux-android26-clang \
        aarch64-linux-android26-clang++ \
        armv7a-linux-androideabi26-clang \
        armv7a-linux-androideabi26-clang++ \
        x86_64-linux-android26-clang \
        x86_64-linux-android26-clang++
    do
        ln -sf "$android_dir/native-ndk-clang.sh" "$native_wrapper_dir/$tool"
        ln -sf "$android_dir/muvm-ndk-tool.sh" "$muvm_wrapper_dir/$tool"
    done
}

build_muvm_target() {
    rust_target=$1
    android_abi=$2
    env_suffix=$3
    cargo_suffix=$4
    clang_name=$5
    native_clang="$native_wrapper_dir/$clang_name"
    native_clangxx="$native_clang++"
    linker="$muvm_wrapper_dir/$clang_name"

    mkdir -p "$output_dir/$android_abi"

    env \
        "CC_$env_suffix=$native_clang" \
        "CXX_$env_suffix=$native_clangxx" \
        "AR_$env_suffix=$IROH_FM_NATIVE_AR" \
        "RANLIB_$env_suffix=$IROH_FM_NATIVE_RANLIB" \
        "CARGO_TARGET_${cargo_suffix}_LINKER=$linker" \
        "CARGO_TARGET_${cargo_suffix}_AR=$IROH_FM_NATIVE_AR" \
        cargo build \
            --manifest-path "$repo_dir/Cargo.toml" \
            --target "$rust_target" \
            --release \
            -p iroh-fm-android-native

    cp \
        "${CARGO_TARGET_DIR:-$repo_dir/target}/$rust_target/release/libiroh_fm_android_native.so" \
        "$output_dir/$android_abi/libiroh_fm_android_native.so"
}

build_on_arm() {
    if ! command -v muvm >/dev/null 2>&1; then
        echo "muvm is required to run the x86_64 Android NDK on this ARM host." >&2
        exit 1
    fi

    ndk_dir=$(find_android_ndk)
    if [ -z "$ndk_dir" ]; then
        echo "Set ANDROID_NDK_HOME, ANDROID_HOME, or ANDROID_SDK_ROOT." >&2
        exit 1
    fi

    IROH_FM_NDK_PREBUILT="$ndk_dir/toolchains/llvm/prebuilt/linux-x86_64"
    IROH_FM_NDK_BIN="$IROH_FM_NDK_PREBUILT/bin"
    if [ ! -x "$IROH_FM_NDK_BIN/clang" ]; then
        echo "The Android NDK x86_64 toolchain was not found under $ndk_dir." >&2
        exit 1
    fi
    IROH_FM_NATIVE_CLANG=$(command -v clang || true)
    IROH_FM_NATIVE_CLANGXX=$(command -v clang++ || true)
    IROH_FM_NATIVE_AR=$(command -v llvm-ar || true)
    IROH_FM_NATIVE_RANLIB=$(command -v llvm-ranlib || true)
    if [ -z "$IROH_FM_NATIVE_CLANG" ] || \
        [ -z "$IROH_FM_NATIVE_CLANGXX" ] || \
        [ -z "$IROH_FM_NATIVE_AR" ] || \
        [ -z "$IROH_FM_NATIVE_RANLIB" ]; then
        echo "Native clang, clang++, llvm-ar, and llvm-ranlib are required on ARM." >&2
        exit 1
    fi
    export IROH_FM_NDK_PREBUILT IROH_FM_NDK_BIN
    export IROH_FM_NATIVE_CLANG IROH_FM_NATIVE_CLANGXX
    export IROH_FM_NATIVE_AR IROH_FM_NATIVE_RANLIB

    prepare_arm_tools

    # Cargo, rustc, and all host build scripts stay native to the ARM host.
    # Native Clang compiles Android C dependencies against the NDK sysroot.
    # Only final Rust cdylib links use the official x86_64 NDK Clang via muvm.
    build_muvm_target \
        aarch64-linux-android arm64-v8a \
        aarch64_linux_android AARCH64_LINUX_ANDROID \
        aarch64-linux-android26-clang
    build_muvm_target \
        armv7-linux-androideabi armeabi-v7a \
        armv7_linux_androideabi ARMV7_LINUX_ANDROIDEABI \
        armv7a-linux-androideabi26-clang
    build_muvm_target \
        x86_64-linux-android x86_64 \
        x86_64_linux_android X86_64_LINUX_ANDROID \
        x86_64-linux-android26-clang
}

case $(uname -m) in
    aarch64 | arm64)
        build_on_arm
        ;;
    *)
        build_with_cargo_ndk
        ;;
esac
