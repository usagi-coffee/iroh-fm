# Japanese lyrics readings

Optional English dictionary senses are documented in [JMDICT.md](JMDICT.md).
They extend the same blocking annotation worker and versioned cache without
changing ruby coverage, original lyric text, timings or UTF-16 offsets.

Lindera 6.2.0 is pinned with `default-features = false` and `embed-ipadic`.
Its IPADIC 2.7.0-20250920 dictionary provides word-level katakana readings,
converted to hiragana only for known tokens containing kanji. There are no
normalization filters, inferred unknown readings or per-kanji alignments.
Dictionary readings are automatic and may differ from names or sung readings.

## Packaging and build

Build the server with:

```sh
cargo build --locked --release --package server --bin iroh-fm
```

Rust 1.88 or newer is required by Lindera. Its build script downloads and
checksum-verifies the dictionary archive on the first clean Cargo/container
build. A clean build needs network access, or a populated Lindera build cache
configured with `LINDERA_BUILD_DICTIONARY_CACHE_DIR`. There is no runtime
download, dictionary path, configuration or volume requirement.

The embedded dictionary data occupies approximately 46 MiB before
binary/container compression and increases server size and memory use.
IPADIC is smaller than NEologd but misses more names and new words. Dictionary
data never enters the browser, Desktop or Android client builds.

`Containerfile` embeds the dictionary through the normal server release build.
The existing target/registry build caches also retain its build artifacts.
`.containerignore` includes `crates/server/IPADIC-COPYING` because it is a
compile-time `include_str!` input and a runtime image license notice.
Standalone binaries expose this notice via `iroh-fm --ipadic-license`;
containers also install it at `/usr/share/licenses/iroh-fm/IPADIC-COPYING`.

## Work and cache lifecycle

The dictionary initializes lazily in `spawn_blocking`. A separate bounded,
coalescing annotation queue processes one song at a time, independently of
the LRCLIB HTTP worker and its rate-limit/cooldown gate.

Versioned annotations persist inside the existing lyrics result JSON,
alongside unchanged plain and LRC source. Older entries and obsolete
annotation versions upgrade lazily without an LRCLIB refetch. Conditional
updates cannot overwrite replaced sources or changed metadata.

`Available` with a positive `retry_after_seconds` hint means original lyrics
are usable while local annotation is pending. The server omits outdated
annotations while preparing their replacement. The UI honors the retry hint
independently of annotation presence and continues bounded polling on the same
track without hiding the original text.
If retries exhaust, the panel offers its existing manual retry control.

Spans use UTF-16 source indices with an exclusive end. The client retains
indices while stripping timestamp/enhanced tags and display whitespace.
Repeated timestamps share parts; source timing, offsets and plain-text
duration estimates do not change when furigana is toggled.
