//! Validates the WGSL shaders in web/shaders with naga, the same front end
//! wgpu and Firefox use. Each shader is checked with common.wgsl prepended,
//! exactly as the renderer loads it.
//!
//! Usage: cargo run -p shader-check

use std::path::Path;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/shaders");
    let common = std::fs::read_to_string(dir.join("common.wgsl")).expect("common.wgsl");
    let mut failed = false;
    let mut entries: Vec<_> = std::fs::read_dir(&dir).expect("shader dir").flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with(".wgsl") || name == "common.wgsl" {
            continue;
        }
        let src = format!("{common}\n{}", std::fs::read_to_string(&path).unwrap());
        let module = match naga::front::wgsl::parse_str(&src) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("{name}: parse error\n{}", e.emit_to_string(&src));
                failed = true;
                continue;
            }
        };
        let mut validator = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty());
        match validator.validate(&module) {
            Ok(_) => println!("{name}: ok ({} entry points)", module.entry_points.len()),
            Err(e) => {
                eprintln!("{name}: validation error\n{}", e.emit_to_string(&src));
                failed = true;
            }
        }
    }
    if failed {
        std::process::exit(1);
    }
}
