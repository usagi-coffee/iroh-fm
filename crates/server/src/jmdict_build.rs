//! Deterministic build-time index generation. Also compiled by unit tests.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Dictionary {
    words: Vec<Word>,
    tags: BTreeMap<String, String>,
}
#[derive(Deserialize)]
struct Word {
    id: String,
    kanji: Vec<Spelling>,
    kana: Vec<Kana>,
    sense: Vec<Sense>,
}
#[derive(Deserialize)]
struct Spelling {
    text: String,
    common: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Kana {
    text: String,
    common: bool,
    applies_to_kanji: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sense {
    applies_to_kanji: Vec<String>,
    applies_to_kana: Vec<String>,
    part_of_speech: Vec<String>,
    misc: Vec<String>,
    field: Vec<String>,
    dialect: Vec<String>,
    info: Vec<String>,
    gloss: Vec<Gloss>,
}
#[derive(Deserialize)]
struct Gloss {
    lang: String,
    text: String,
}
#[derive(Serialize)]
struct Candidate {
    entry_id: String,
    reading: String,
    senses: Vec<Definition>,
}
#[derive(Serialize)]
struct Definition {
    glosses: Vec<String>,
    labels: Vec<String>,
}

fn applies(restrictions: &[String], text: &str) -> bool {
    restrictions.iter().any(|s| s == "*" || s == text)
}

pub fn generate(json: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let dictionary: Dictionary = serde_json::from_slice(json).expect("JMdict schema");
    let mut spellings: BTreeMap<String, Vec<(bool, Candidate)>> = BTreeMap::new();
    for word in dictionary.words {
        for spelling in &word.kanji {
            for kana in &word.kana {
                if !applies(&kana.applies_to_kanji, &spelling.text) {
                    continue;
                }
                let senses: Vec<_> = word
                    .sense
                    .iter()
                    .filter_map(|sense| {
                        if !applies(&sense.applies_to_kanji, &spelling.text)
                            || !applies(&sense.applies_to_kana, &kana.text)
                        {
                            return None;
                        }
                        let glosses: Vec<_> = sense
                            .gloss
                            .iter()
                            .filter(|g| g.lang == "eng")
                            .map(|g| g.text.clone())
                            .collect();
                        if glosses.is_empty() {
                            return None;
                        }
                        let labels = sense
                            .part_of_speech
                            .iter()
                            .chain(&sense.misc)
                            .chain(&sense.field)
                            .chain(&sense.dialect)
                            .map(|tag| dictionary.tags.get(tag).unwrap_or(tag).clone())
                            .chain(sense.info.iter().cloned())
                            .collect();
                        Some(Definition { glosses, labels })
                    })
                    .collect();
                if !senses.is_empty() {
                    spellings.entry(spelling.text.clone()).or_default().push((
                        spelling.common || kana.common,
                        Candidate {
                            entry_id: word.id.clone(),
                            reading: kana.text.clone(),
                            senses,
                        },
                    ));
                }
            }
        }
    }
    let mut builder = fst::MapBuilder::memory();
    let mut data = Vec::new();
    for (spelling, mut candidates) in spellings {
        candidates.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.entry_id.cmp(&b.1.entry_id))
                .then_with(|| a.1.reading.cmp(&b.1.reading))
        });
        let candidates: Vec<_> = candidates.into_iter().map(|(_, c)| c).collect();
        let bytes = serde_json::to_vec(&candidates).unwrap();
        // Bound lookup decoding even if a future snapshot has pathological keys.
        assert!(
            bytes.len() <= 128 * 1024,
            "oversized JMdict spelling: {spelling}"
        );
        let offset = u32::try_from(data.len()).expect("JMdict data under 4 GiB");
        let length = u32::try_from(bytes.len()).unwrap();
        builder
            .insert(spelling, (u64::from(offset) << 32) | u64::from(length))
            .unwrap();
        data.extend(bytes);
    }
    (builder.into_inner().unwrap(), data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_index_respects_spelling_reading_and_sense_restrictions() {
        let json = serde_json::json!({
            "tags": { "n": "noun" },
            "words": [{
                "id": "1",
                "kanji": [
                    { "text": "生", "common": true },
                    { "text": "性", "common": false }
                ],
                "kana": [
                    { "text": "せい", "common": true, "appliesToKanji": ["*"] },
                    { "text": "なま", "common": false, "appliesToKanji": ["生"] },
                    { "text": "しょう", "common": false, "appliesToKanji": [] }
                ],
                "sense": [
                    { "appliesToKanji": ["生"], "appliesToKana": ["なま"],
                      "partOfSpeech": ["n"], "misc": [], "field": [], "dialect": [], "info": [],
                      "gloss": [{ "lang": "eng", "text": "raw" }, { "lang": "ger", "text": "roh" }] },
                    { "appliesToKanji": ["性"], "appliesToKana": ["せい"],
                      "partOfSpeech": ["n"], "misc": [], "field": [], "dialect": [], "info": [],
                      "gloss": [{ "lang": "eng", "text": "nature" }] }
                ]
            }]
        });
        let source = serde_json::to_vec(&json).unwrap();
        let (index, data) = generate(&source);
        assert_eq!(generate(&source), (index.clone(), data.clone()));
        let index = fst::Map::new(index).unwrap();
        let definitions = |spelling| {
            let position = index.get(spelling).unwrap();
            let start = (position >> 32) as usize;
            let len = (position & u64::from(u32::MAX)) as usize;
            serde_json::from_slice::<Vec<protocol::LyricMeaning>>(&data[start..start + len])
                .unwrap()
        };
        let raw = definitions("生");
        assert_eq!(raw.len(), 1);
        assert_eq!(raw[0].reading, "なま");
        assert_eq!(raw[0].senses[0].glosses, ["raw"]);
        assert_eq!(raw[0].senses[0].labels, ["noun"]);
        let nature = definitions("性");
        assert_eq!(nature.len(), 1);
        assert_eq!(nature[0].reading, "せい");
        assert_eq!(nature[0].senses[0].glosses, ["nature"]);
        // Only kanji spelling keys are indexed for the approved feature scope.
        assert!(index.get("なま").is_none());
    }
}
