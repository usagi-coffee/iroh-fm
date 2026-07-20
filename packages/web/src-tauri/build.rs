use std::{env, path::Path, process::Command};

fn git(workspace: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn main() {
    println!("cargo:rerun-if-env-changed=DESKTOP_EPOCH");
    println!("cargo:rerun-if-env-changed=DESKTOP_EPOCH_COMMIT");
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set");
    let workspace = Path::new(&manifest).join("../../..");
    let commit = env::var("DESKTOP_EPOCH_COMMIT").ok().or_else(|| {
        git(
            &workspace,
            &["log", "--format=%H", "--grep=^desktop:", "-1"],
        )
    });
    let epoch = env::var("DESKTOP_EPOCH")
        .ok()
        .or_else(|| {
            commit
                .as_deref()
                .and_then(|sha| git(&workspace, &["rev-list", "--count", sha]))
        })
        .unwrap_or_else(|| "0".to_owned());
    println!("cargo:rustc-env=DESKTOP_EPOCH={epoch}");
    println!(
        "cargo:rustc-env=DESKTOP_EPOCH_COMMIT={}",
        commit.as_deref().unwrap_or("development")
    );
    tauri_build::build()
}
