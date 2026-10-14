//! Local, conservative word-level readings. No normalization or alignment edits
//! the source. The embedded dictionary is initialized only on a blocking worker.
use std::borrow::Cow;
use std::sync::OnceLock;

use lindera::{dictionary::load_dictionary, mode::Mode, segmenter::Segmenter};
use protocol::{AnnotatedLyrics, LyricReading, LyricsStatus, TrackLyrics};

// Bump when the dictionary, segmentation, conversion or offset rules change.
pub(crate) const VERSION: &str = concat!(
    "lindera-6.2.0-ipadic-2.7.0-20250920-jmdict-",
    env!("JMDICT_RELEASE"),
    "-",
    env!("JMDICT_SHA256"),
    "-ruby-meanings-v2"
);
static SEGMENTER: OnceLock<Result<Segmenter, String>> = OnceLock::new();
// Meaning payloads are optional beyond this per-source budget; ruby still covers
// the entire unchanged lyric source. None is distinct from an explicit no match.
const MEANING_BUDGET: usize = 128 * 1024;

pub(crate) fn needs_annotation(lyrics: &TrackLyrics) -> bool {
    lyrics.status == LyricsStatus::Available
        && lyrics
            .annotated_lyrics
            .as_ref()
            .is_none_or(|a| a.version != VERSION)
}

fn contains_kanji(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(c,
            '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' |
            '\u{f900}'..='\u{faff}' | '\u{20000}'..='\u{2ffff}' |
            '\u{30000}'..='\u{323af}' | '々'
        )
    })
}

/// IPADIC's reading field, not pronunciation: retain orthographic kana.
/// Reject unknown/non-kana readings rather than generating a fallback.
pub(crate) fn hiragana(reading: &str) -> Option<String> {
    if reading.is_empty() || !reading.chars().all(|c| {
        matches!(c, '\u{30a1}'..='\u{30f6}' | '\u{3041}'..='\u{3096}' | 'ー' | '・' | '\u{3099}' | '\u{309a}')
    }) {
        return None;
    }
    Some(
        reading
            .chars()
            .map(|c| {
                if matches!(c, '\u{30a1}'..='\u{30f6}') {
                    char::from_u32(c as u32 - 0x60).expect("hiragana codepoint")
                } else {
                    c
                }
            })
            .collect(),
    )
}

fn readings(source: &str) -> Result<Vec<LyricReading>, String> {
    if !contains_kanji(source) {
        return Ok(Vec::new());
    }
    let segmenter = SEGMENTER
        .get_or_init(|| {
            load_dictionary("embedded://ipadic")
                .map(|dictionary| Segmenter::new(Mode::Normal, dictionary, None))
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    let tokens = segmenter
        .segment(Cow::Borrowed(source))
        .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    let mut previous_byte = 0;
    let mut previous_utf16 = 0;
    let mut meaning_bytes = 0;
    for mut token in tokens {
        let start = token.byte_start;
        let end = token.byte_end;
        // Use exact source slices, not normalized token surfaces. SPACE tokens
        // can be omitted by Lindera; their offsets still count in the source.
        if !contains_kanji(&source[start..end]) || token.word_id.is_unknown() {
            continue;
        }
        // IPADIC details: POS 0..3, conjugation 4..5, base 6, reading 7.
        let Some(reading) = token.get_detail(7).and_then(hiragana) else {
            continue;
        };
        let lemma = token
            .get_detail(6)
            .filter(|s| !s.is_empty() && *s != "*")
            .unwrap_or(&source[start..end])
            .to_owned();
        // Re-tokenizing an inflected word's lemma can choose a different
        // homograph (空い/あい -> 空く/すく). Only filter by a reading already
        // known for this exact surface; otherwise retain dictionary ambiguity.
        let base_reading = (lemma == source[start..end]).then_some(reading.as_str());
        let dictionary = if meaning_bytes < MEANING_BUDGET {
            let dictionary = crate::jmdict::lookup(&lemma, base_reading);
            let size = serde_json::to_vec(&dictionary)
                .map_err(|e| e.to_string())?
                .len();
            if meaning_bytes + size <= MEANING_BUDGET {
                meaning_bytes += size;
                Some(dictionary)
            } else {
                meaning_bytes = MEANING_BUDGET;
                None
            }
        } else {
            None
        };
        let utf16_start = previous_utf16 + source[previous_byte..start].encode_utf16().count();
        let utf16_end = utf16_start + source[start..end].encode_utf16().count();
        result.push(LyricReading {
            start: utf16_start as u32,
            end: utf16_end as u32,
            reading,
            dictionary,
        });
        previous_byte = end;
        previous_utf16 = utf16_end;
    }
    Ok(result)
}

pub(crate) fn annotate(mut lyrics: TrackLyrics) -> Result<TrackLyrics, String> {
    lyrics.annotated_lyrics = Some(AnnotatedLyrics {
        version: VERSION.into(),
        plain: readings(lyrics.plain_lyrics.as_deref().unwrap_or_default())?,
        synced: readings(lyrics.synced_lyrics.as_deref().unwrap_or_default())?,
    });
    lyrics.retry_after_seconds = None;
    Ok(lyrics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_reading_kana_without_guessing_unknowns() {
        assert_eq!(hiragana("ニホンゴ"), Some("にほんご".into()));
        assert_eq!(
            hiragana("ヴァイオリン・コーヒー"),
            Some("ゔぁいおりん・こーひー".into())
        );
        for unknown in ["", "*", "UNK", "日本", "abc"] {
            assert_eq!(hiragana(unknown), None);
        }
    }

    #[test]
    fn japanese_mixed_unknown_and_source_offsets() {
        let source = " 😀 日本語の歌！ hello カタカナ\r\n𠮷𠮷𠮷 [00:01.20]海 ";
        let spans = readings(source).unwrap();
        let units: Vec<_> = source.encode_utf16().collect();
        let words: Vec<_> = spans
            .iter()
            .map(|span| {
                (
                    String::from_utf16(&units[span.start as usize..span.end as usize]).unwrap(),
                    span.reading.as_str(),
                )
            })
            .collect();
        assert!(words.contains(&("日本語".into(), "にほんご")));
        assert!(words.contains(&("歌".into(), "うた")));
        assert!(words.contains(&("海".into(), "うみ")));
        assert!(!words.iter().any(|(text, _)| text.contains('𠮷')));
        assert!(words.iter().all(|(text, _)| contains_kanji(text)));
        assert!(readings("Hello! カタカナ かな 😀").unwrap().is_empty());
    }

    #[test]
    fn inflected_kanji_uses_base_form_without_changing_surface_ruby_or_offsets() {
        let source = "😀[00:01.20] 食べた！ 歌った\r\n海";
        let spans = readings(source).unwrap();
        let eat = spans
            .iter()
            .find(|s| s.dictionary.as_ref().is_some_and(|d| d.lemma == "食べる"))
            .unwrap();
        let units: Vec<_> = source.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&units[eat.start as usize..eat.end as usize]).unwrap(),
            "食べ"
        );
        assert_eq!(eat.reading, "たべ");
        let dictionary = eat.dictionary.as_ref().unwrap();
        assert_eq!(dictionary.meanings[0].reading, "たべる");
        assert_eq!(dictionary.meanings[0].senses[0].glosses[0], "to eat");
        assert!(spans.iter().all(|s| s.dictionary.is_some()));
    }

    #[test]
    fn inflected_homographs_retain_ambiguity_instead_of_retokenizing_the_lemma() {
        for (source, lemma, surface_reading, original_base_reading) in [
            ("空いた", "空く", "あい", "あく"),
            ("汚した", "汚す", "よごし", "よごす"),
        ] {
            let spans = readings(source).unwrap();
            let word = spans
                .iter()
                .find(|span| span.dictionary.as_ref().is_some_and(|d| d.lemma == lemma))
                .unwrap();
            assert_eq!(word.reading, surface_reading);
            let dictionary = word.dictionary.as_ref().unwrap();
            assert_eq!(dictionary, &crate::jmdict::lookup(lemma, None));
            assert!(
                dictionary
                    .meanings
                    .iter()
                    .any(|m| m.reading == original_base_reading)
            );
        }
    }

    #[test]
    fn long_sources_bound_meanings_without_losing_furigana() {
        let spans = readings(&"海 ".repeat(2000)).unwrap();
        assert_eq!(spans.len(), 2000);
        let bytes: usize = spans
            .iter()
            .filter_map(|s| s.dictionary.as_ref())
            .map(|d| serde_json::to_vec(d).unwrap().len())
            .sum();
        assert!(bytes <= MEANING_BUDGET);
        assert!(spans.last().unwrap().dictionary.is_none());
    }
}
