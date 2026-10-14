// The data generated here is derived from JMdict and licensed CC BY-SA 4.0.
// Only a pinned, checksum-verified archive is accepted, including offline input.
#[path = "src/jmdict_build.rs"]
mod dictionary;

use std::{env, fs, io::Read, path::PathBuf, time::Duration};

use sha2::{Digest, Sha256};

fn main() {
    println!("cargo:rerun-if-changed=jmdict-source.json");
    println!("cargo:rerun-if-changed=src/jmdict_build.rs");
    println!("cargo:rerun-if-env-changed=IROH_FM_JMDICT_ARCHIVE");
    let source: serde_json::Value =
        serde_json::from_str(include_str!("jmdict-source.json")).expect("JMdict source manifest");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let archive = env::var_os("IROH_FM_JMDICT_ARCHIVE")
        .map(PathBuf::from)
        .unwrap_or_else(|| out.join("jmdict.tgz"));
    if env::var_os("IROH_FM_JMDICT_ARCHIVE").is_some() {
        println!("cargo:rerun-if-changed={}", archive.display());
    } else if !archive.exists() {
        let mut response = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .expect("JMdict build HTTP client")
            .get(source["url"].as_str().expect("JMdict URL"))
            .send()
            .and_then(|r| r.error_for_status())
            .expect(
                "download pinned JMdict archive; use IROH_FM_JMDICT_ARCHIVE for offline builds",
            );
        let mut bytes = Vec::new();
        (&mut response)
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        assert!(bytes.len() <= 16 * 1024 * 1024, "oversized JMdict archive");
        verify(&bytes, &source);
        fs::write(&archive, bytes).expect("cache JMdict archive");
    }
    assert!(
        fs::metadata(&archive)
            .expect("JMdict archive metadata")
            .len()
            <= 16 * 1024 * 1024,
        "oversized JMdict archive"
    );
    let bytes = fs::read(&archive).expect("read pinned JMdict archive");
    verify(&bytes, &source);
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(bytes.as_slice()));
    let mut json = None;
    for file in tar.entries().expect("JMdict archive entries") {
        let mut file = file.expect("JMdict archive entry");
        if file
            .path()
            .unwrap()
            .extension()
            .is_some_and(|e| e == "json")
        {
            assert!(json.is_none(), "multiple JSON files in JMdict archive");
            let mut data = Vec::new();
            (&mut file)
                .take(160 * 1024 * 1024 + 1)
                .read_to_end(&mut data)
                .unwrap();
            assert!(data.len() <= 160 * 1024 * 1024, "oversized JMdict JSON");
            json = Some(data);
        }
    }
    let (index, data) = dictionary::generate(&json.expect("JMdict JSON file"));
    println!(
        "cargo:warning=JMdict embedded index {} bytes, definitions {} bytes",
        index.len(),
        data.len()
    );
    fs::write(out.join("jmdict.fst"), index).unwrap();
    fs::write(out.join("jmdict.data"), data).unwrap();
    println!(
        "cargo:rustc-env=JMDICT_RELEASE={}",
        source["release"].as_str().unwrap()
    );
    println!(
        "cargo:rustc-env=JMDICT_SHA256={}",
        source["sha256"].as_str().unwrap()
    );
}

fn verify(bytes: &[u8], source: &serde_json::Value) {
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        source["sha256"].as_str().expect("JMdict SHA-256"),
        "JMdict archive checksum mismatch"
    );
}
