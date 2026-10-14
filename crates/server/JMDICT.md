# Japanese lyric dictionary meanings

The optional Meanings checkbox adds a short English dictionary gloss above the
existing automatic furigana for kanji-containing words. It is off by default and
requires Furigana. Turning Furigana off hides both optional annotations.
No-match words keep their original ruby, without an invented English gloss.
These are dictionary senses, not lyric translations. A `/ …` suffix indicates
additional senses or omitted data; the word's title describes bounded senses.
There is no AI, external lookup, full-line translation, or lyric fetch switch.

## Data and licence

Meanings come from the Japanese-English components of EDRDG's JMdict:
https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project

The maintained weekly converter https://github.com/scriptin/jmdict-simplified
publishes English-only snapshots. `jmdict-source.json` pins release
`3.6.2+20261012204142`, its archive URL and SHA-256. No large dataset is in Git.
Build-time Rust code verifies the archive, respects reading and sense spelling
restrictions, ranks common forms first, and generates a deterministic FST
spelling index and English definition blob.

JMdict is copyright James William Breen and EDRDG, used under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
The derived dictionary index and extracts retain this licence; the application
code retains its own licence. `JMDICT-NOTICE` and `CC-BY-SA-4.0` accompany
container images under `/usr/share/licenses/iroh-fm/`. Standalone distributions
should include these files and this document; `iroh-fm --jmdict-license` also
prints the notice and full licence. The lyrics footer credits and links the
dictionary and licence whenever meanings are enabled. No endorsement is implied.

## Builds and runtime

```sh
cargo build --locked --release --package server --bin iroh-fm
```

A clean build downloads an approximately 11 MiB pinned archive once into Cargo
`OUT_DIR`. Downloads have a 180-second timeout and 16 MiB limit; extracted JSON
has a 160 MiB limit. Build parsing temporarily needs several hundred MiB of RAM.
Rebuilds reuse the verified archive; normal Cargo/container caches retain it.
For an offline build, set `IROH_FM_JMDICT_ARCHIVE` to a previously downloaded
archive matching the pinned SHA-256. This is a build-only input, not a runtime
configuration. Lindera has its independent build-time download/cache requirement.

The FST is 4,010,121 bytes (3.8 MiB), with 51,402,509 bytes (49 MiB) of
definition data. These add about 53 MiB to the server binary before distribution
compression. Embedded byte slices allow demand paging and bounded per-key JSON
decoding rather than allocating or decompressing the whole dictionary.
Container layer compression reduces transfer size. Resident memory depends on
the words used. Dictionary data is not compiled into any client or WASM binary.

Lookup uses the IPADIC base form and exact dictionary spelling. When that
base form is the unchanged surface word, its known reading filters homographs.
For inflected words, candidates retain their individual dictionary readings:
re-tokenizing a bare lemma can select a different homograph from the original
token. This deliberately preserves ambiguity rather than guessing a base
pronunciation. Spelling/reading sense restrictions apply before runtime limits.

Each spelling's encoded candidates are bounded to 128 KiB at build time.
Returned definitions have at most two entries, three senses per entry, two
glosses and three labels per sense, each at most 160 characters. Omission sets
`truncated`. Meaning payloads are capped at 128 KiB for each plain/LRC source;
remaining ruby spans omit the dictionary field, not an explicit no-match.
Old servers also omit that field. An empty meanings list means an actual
dictionary lookup found no matching entry. Original furigana coverage remains
unchanged, and unknown tokens still receive no guessed reading.

The existing bounded, coalesced annotation worker owns initialization,
tokenization and lookups in `spawn_blocking`, separate from
audio handlers and LRCLIB's HTTP worker. Versioned annotations upgrade existing
cached lyrics lazily with no LRCLIB refetch. The version includes the dictionary
release. Conditional cache writes protect replaced source and track metadata.
The version also includes the source SHA-256, so changing data under the same
release name cannot reuse stale meanings. Plain text, LRC timestamps and
exclusive UTF-16 source offsets are unchanged.

## Release maintenance

The [EDRDG licence statement](https://www.edrdg.org/edrdg/licence.html) requires
a regular dictionary update procedure. Check for new English snapshots at least
monthly and before releasing the dictionary-enabled server:

1. Inspect https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest
   and select the `jmdict-eng-<release>.json.tgz` asset (not common-only/examples).
2. Download that release asset, verify its published SHA-256 `digest`, and update
   all three fields in `jmdict-source.json`. Review converter schema/licence changes.
3. Update the snapshot attribution in `JMDICT-NOTICE` and this document.
4. Run the full protocol/server/client tests and server/container builds. Confirm
   the generated index/data size limits and the inflection/restriction fixtures.
5. Release the rebuilt server. Its changed annotation version upgrades cached
   songs on demand; a source or dictionary update never needs an LRCLIB refetch.

Runtime does not auto-update or contact dictionary servers. Deployments must
install regularly refreshed server releases rather than treating this pin as
a permanently current dictionary.
