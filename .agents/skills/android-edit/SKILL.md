---
name: android-edit
description: "Use only when editing Android code under android, crates/android-native, packages/client/src/native.js, or Android playback, JNI, Gradle, and TWA integration."
---

# Android Edit

`android` is the Trusted Web Activity and Media3 application. `crates/android-native` is its JNI-facing Rust bridge and native client; `packages/client/src/native.js` connects the shared Web UI to that bridge. Keep Rust exports, Kotlin declarations, and JSON payloads in sync.

## Verify

Choose checks by the code changed:

- Kotlin, resources, manifest, or Gradle: assemble the debug APK.
- Rust/JNI: run `cargo check`, then `build-rust.sh` before assembling the APK.
- Android-facing Web/client behavior: run the Android E2E project.

```sh
cargo check -p iroh-fm-android-native
./android/build-rust.sh
gradle -p android assembleDebug
bun run --cwd packages/web test:e2e --project=android
```

Do not rebuild Rust for a Kotlin-only change when all three existing JNI libraries are present under `android/app/src/main/jniLibs`. Do not run the signed release build merely for validation.

## Commit Strategy

Be especially careful before choosing `android:`: use it only for an explicit Android release when Android-native code or configuration really changes. A Web fix that affects Android through the shared UI does not need the `android:` prefix if it does not change native Android code. `android:` publishes the signed APK and advances the Android epoch. An empty `android:` commit is valid when native work is already merged and only a release is needed.
