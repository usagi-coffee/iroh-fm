# Android TWA client

This app wraps the hosted iroh-fm web UI in a Trusted Web Activity while moving iroh networking and playback into native code:

- `crates/android-native` reuses the Rust `client` crate and exposes JNI calls.
- `IrohDataSource` streams bytes from Rust into Media3/ExoPlayer.
- `PlaybackService` is a Media3 foreground media session, so playback continues while the TWA is asleep or removed from recents.
- `MainActivity` bridges JSON RPC over the Custom Tabs postMessage channel and publishes player state whenever the web UI wakes.

Build the Rust libraries first (install `cargo-ndk` if necessary):

```sh
./android/build-rust.sh
gradle -p android assembleDebug
```

The default web origin is the GitHub Pages deployment. Override it for another signed origin:

```sh
gradle -p android assembleDebug \
  -PirohFmOrigin=https://music.example.com \
  -PirohFmLaunchUrl=https://music.example.com/
```

That origin must publish `/.well-known/assetlinks.json` for `fm.iroh.android` and the signing certificate used for the APK. Without Digital Asset Links validation Chrome falls back to a Custom Tab and does not grant the trusted postMessage relationship.

Current seek behavior reopens a stream and consumes bytes up to Media3's requested byte offset. Adding a ranged `OpenStream` request to the protocol will make long forward seeks efficient.

## GitHub Actions and release signing

The Android workflow builds only signed release APKs. It builds for every pushed tag and for pushes to `master` whose commit subject starts exactly with `android:`. Pull requests and other branch commits never receive the release keystore or its passwords. An eligible build fails rather than falling back to an unsigned APK when any signing secret is missing.

Create the long-lived release keystore locally. Do not create it in GitHub Actions and do not commit it:

```sh
mkdir -p "$HOME/.local/share/iroh-fm"
keytool -genkeypair -v \
  -keystore "$HOME/.local/share/iroh-fm/android-release.p12" \
  -storetype PKCS12 \
  -alias iroh-fm \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

Back up that file and its passwords. Android updates must be signed by the same signing identity.

Configure the three repository secrets with the GitHub CLI:

```sh
base64 -w0 "$HOME/.local/share/iroh-fm/android-release.p12" \
  | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS --body iroh-fm
```

The password command prompts for its value without placing it in the command line. PKCS12 uses that password for both the keystore and private key. The workflow expects:

- `ANDROID_KEYSTORE_BASE64`: the base64-encoded PKCS12 file
- `ANDROID_KEYSTORE_PASSWORD`: the keystore password
- `ANDROID_KEY_ALIAS`: `iroh-fm`, unless another alias was chosen

Trigger a signed release build from `master` with a matching commit subject:

```sh
git commit -m "android: describe the Android change"
git push
```

Create a signed release artifact by pushing any tag, conventionally a version tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

A tag becomes the APK `versionName` without one leading `v`. An `android:` branch build uses `0.1.0-ci.<run-number>` as its `versionName`. The workflow run number supplies the monotonically increasing `versionCode` for both paths.

The workflow verifies that the release certificate matches the SHA-256 fingerprint published for this app, then prints that fingerprint in the workflow summary.
