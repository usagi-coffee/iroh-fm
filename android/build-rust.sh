#!/usr/bin/env sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cargo ndk \
  --manifest-path "$repo_dir/Cargo.toml" \
  --target arm64-v8a \
  --target armeabi-v7a \
  --target x86_64 \
  --platform 26 \
  --output-dir "$repo_dir/android/app/src/main/jniLibs" \
  build --release -p iroh-fm-android-native
