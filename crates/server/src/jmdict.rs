//! Local indexed dictionary lookup, called only by the blocking annotation worker.
use std::sync::OnceLock;

use protocol::{LyricDictionary, LyricMeaning};

static INDEX: OnceLock<fst::Map<&'static [u8]>> = OnceLock::new();
const DATA: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/jmdict.data"));
const MAX_MEANINGS: usize = 2;
const MAX_SENSES: usize = 3;
const MAX_GLOSSES: usize = 2;
const MAX_TEXT: usize = 160;

pub(crate) fn lookup(lemma: &str, reading: Option<&str>) -> LyricDictionary {
    let index = INDEX.get_or_init(|| {
        fst::Map::new(include_bytes!(concat!(env!("OUT_DIR"), "/jmdict.fst")).as_slice())
            .expect("build-verified JMdict index")
    });
    let meanings = index.get(lemma).map_or_else(Vec::new, |position| {
        let offset = (position >> 32) as usize;
        let length = (position & u64::from(u32::MAX)) as usize;
        serde_json::from_slice::<Vec<LyricMeaning>>(&DATA[offset..offset + length])
            .expect("build-verified JMdict definitions")
    });
    bounded(lemma, reading, meanings)
}

fn bounded(lemma: &str, reading: Option<&str>, meanings: Vec<LyricMeaning>) -> LyricDictionary {
    let mut meanings: Vec<_> = meanings
        .into_iter()
        .filter(|m| {
            reading.is_none_or(|reading| {
                super::furigana::hiragana(&m.reading).as_deref() == Some(reading)
            })
        })
        .collect();
    let mut truncated = meanings.len() > MAX_MEANINGS;
    meanings.truncate(MAX_MEANINGS);
    for meaning in &mut meanings {
        truncated |= meaning.senses.len() > MAX_SENSES;
        meaning.senses.truncate(MAX_SENSES);
        for sense in &mut meaning.senses {
            truncated |= sense.glosses.len() > MAX_GLOSSES || sense.labels.len() > 3;
            sense.glosses.truncate(MAX_GLOSSES);
            sense.labels.truncate(3);
            for text in sense.glosses.iter_mut().chain(&mut sense.labels) {
                if text.chars().count() > MAX_TEXT {
                    *text = text.chars().take(MAX_TEXT - 1).chain(['…']).collect();
                    truncated = true;
                }
            }
        }
    }
    LyricDictionary {
        lemma: lemma.into(),
        meanings,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_unknown_and_reading_disambiguation() {
        let eat = lookup("食べる", Some("たべる"));
        assert_eq!(eat.meanings[0].senses[0].glosses[0], "to eat");
        assert!(eat.meanings[0].senses.len() > 1);
        assert!(lookup("食べる", Some("くう")).meanings.is_empty());
        assert!(lookup("絶対存在しない𠮷𠮷𠮷", None).meanings.is_empty());
        let life = lookup("生", Some("せい"));
        assert!(!life.meanings.is_empty());
        assert!(life.meanings.iter().all(|m| m.reading == "せい"));
        let ambiguous = lookup("生", None);
        assert!(ambiguous.truncated);
        assert_eq!(ambiguous.meanings.len(), MAX_MEANINGS);
    }

    #[test]
    fn payload_bounds_are_explicit() {
        let mut candidates = lookup("食べる", None).meanings;
        candidates[0].senses[0].glosses = vec!["x".repeat(500); 10];
        candidates = vec![candidates[0].clone(); 10];
        let result = bounded("食べる", None, candidates);
        assert!(result.truncated);
        assert_eq!(result.meanings.len(), MAX_MEANINGS);
        assert_eq!(result.meanings[0].senses[0].glosses.len(), MAX_GLOSSES);
        assert_eq!(
            result.meanings[0].senses[0].glosses[0].chars().count(),
            MAX_TEXT
        );
    }
}
