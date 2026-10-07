//! Embeds the git commit into the build so the game can show its exact version.
use std::process::Command;

fn main() {
    let hash = std::env::var("WEBRA_GIT_HASH").ok().filter(|h| !h.is_empty()).unwrap_or_else(|| {
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| "unknown".into())
    });
    // Always the short form, so local builds and CI (full SHA in the env) agree
    // with tools/build-dist.mjs on the build id "<version>+<8 hex chars>".
    let hash: String = hash.chars().take(8).collect();
    println!("cargo:rustc-env=WEBRA_GIT_HASH={hash}");
    println!("cargo:rerun-if-env-changed=WEBRA_GIT_HASH");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
}
