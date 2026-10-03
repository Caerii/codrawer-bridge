//! Builds, signs and verifies codrawer releases for the tablet (package release + release_cmd.go;
//! docs/investigations/durable-install.md §5). Interchangeable with the Go tool: either side can
//! verify what the other signed.
//!
//! A release is a directory of files plus:
//!
//! ```text
//! MANIFEST      "version <v>" then one "<sha256>  <relative/path>" line per file, sorted
//! MANIFEST.sig  base64 ed25519 signature over the MANIFEST bytes
//! ```
//!
//! The format is plain text so shell scripts can read the version. Verification checks the
//! signature first, then every hash, and rejects files the manifest does not list, so a release
//! on the tablet is exactly what was signed.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Component, Path, PathBuf};

use data_encoding::BASE64;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

pub const MANIFEST_NAME: &str = "MANIFEST";
pub const SIGNATURE_NAME: &str = "MANIFEST.sig";

/// A new key pair as base64 strings `(private, public)`; the private key is the 32-byte seed.
pub fn generate_key() -> Result<(String, String), String> {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| format!("random: {e}"))?;
    let sk = SigningKey::from_bytes(&seed);
    Ok((BASE64.encode(&seed), BASE64.encode(sk.verifying_key().as_bytes())))
}

fn parse_priv(s: &str) -> Result<SigningKey, String> {
    let seed = BASE64.decode(s.trim().as_bytes()).ok().and_then(|b| <[u8; 32]>::try_from(b).ok());
    seed.map(|s| SigningKey::from_bytes(&s)).ok_or_else(|| "private key: want base64 of a 32-byte ed25519 seed".into())
}

fn parse_pub(s: &str) -> Result<VerifyingKey, String> {
    let b = BASE64.decode(s.trim().as_bytes()).ok().and_then(|b| <[u8; 32]>::try_from(b).ok());
    // A 32-byte string that is not a curve point can never verify; Go fails it at Verify instead.
    b.and_then(|b| VerifyingKey::from_bytes(&b).ok()).ok_or_else(|| "public key: want base64 of a 32-byte ed25519 key".into())
}

fn err_at(p: &Path, e: io::Error) -> String {
    format!("{}: {e}", p.display())
}

/// The release's files (relative, slash-separated, sorted by bytes), excluding the manifest and
/// its signature. Anything but a regular file or a directory (e.g. a symlink) is an error.
pub fn files(dir: &Path) -> Result<Vec<String>, String> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<String>) -> Result<(), String> {
        for e in fs::read_dir(dir).map_err(|e| err_at(dir, e))? {
            let e = e.map_err(|e| err_at(dir, e))?;
            let name = e.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            let ft = e.file_type().map_err(|err| err_at(&e.path(), err))?;
            if ft.is_dir() {
                walk(&e.path(), &r, out)?;
                continue;
            }
            if r == MANIFEST_NAME || r == SIGNATURE_NAME {
                continue;
            }
            if !ft.is_file() {
                return Err(format!("{r}: not a regular file"));
            }
            out.push(r);
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(dir, "", &mut out)?;
    out.sort();
    Ok(out)
}

fn hash_file(p: &Path) -> Result<String, String> {
    let mut f = fs::File::open(p).map_err(|e| err_at(p, e))?;
    let mut h = Sha256::new();
    io::copy(&mut f, &mut h).map_err(|e| err_at(p, e))?;
    Ok(hex(&h.finalize()))
}

fn hex(b: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    b.iter().flat_map(|x| [D[(x >> 4) as usize] as char, D[(x & 15) as usize] as char]).collect()
}

fn join_rel(dir: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(dir.to_path_buf(), |p, part| p.join(part))
}

/// The MANIFEST bytes for every file in `dir`.
pub fn manifest(dir: &Path, version: &str) -> Result<Vec<u8>, String> {
    if version.is_empty() || version.contains([' ', '\n', '/']) {
        return Err(format!("bad version {version:?}"));
    }
    let mut b = format!("version {version}\n");
    for n in files(dir)? {
        b.push_str(&format!("{}  {n}\n", hash_file(&join_rel(dir, &n))?));
    }
    Ok(b.into_bytes())
}

/// Writes MANIFEST for every file in `dir`.
pub fn build_manifest(dir: &Path, version: &str) -> Result<(), String> {
    let m = manifest(dir, version)?;
    let p = dir.join(MANIFEST_NAME);
    fs::write(&p, m).map_err(|e| err_at(&p, e))
}

/// Writes MANIFEST.sig for the existing MANIFEST.
pub fn sign(dir: &Path, priv_b64: &str) -> Result<(), String> {
    let sk = parse_priv(priv_b64)?;
    let mp = dir.join(MANIFEST_NAME);
    let m = fs::read(&mp).map_err(|e| err_at(&mp, e))?;
    let sig = BASE64.encode(&sk.sign(&m).to_bytes());
    let sp = dir.join(SIGNATURE_NAME);
    fs::write(&sp, format!("{sig}\n")).map_err(|e| err_at(&sp, e))
}

/// A manifest path that stays inside the release: Go's checks (no `..` anywhere, not starting
/// with `/`) plus only plain components, so no drive or root can replace the directory on join.
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && !name.starts_with('/')
        && name.split('/').all(|part| {
            let mut c = Path::new(part).components();
            matches!((c.next(), c.next()), (Some(Component::Normal(_)), None))
        })
}

/// Checks the signature, every file's hash, and that no unlisted file is present. Returns the
/// release's version.
pub fn verify(dir: &Path, pub_b64: &str) -> Result<String, String> {
    let pk = parse_pub(pub_b64)?;
    let mp = dir.join(MANIFEST_NAME);
    let m = fs::read(&mp).map_err(|e| err_at(&mp, e))?;
    let sp = dir.join(SIGNATURE_NAME);
    let sig_text = fs::read_to_string(&sp).map_err(|e| err_at(&sp, e))?;
    let sig = BASE64.decode(sig_text.trim().as_bytes()).ok().and_then(|b| Signature::from_slice(&b).ok());
    // Go's ed25519.Verify: RFC 8032, cofactorless, canonical S.
    if !sig.is_some_and(|s| pk.verify(&m, &s).is_ok()) {
        return Err("signature does not match the manifest".into());
    }
    let text = String::from_utf8_lossy(&m);
    let mut lines = text.trim_end_matches('\n').split('\n');
    let Some(version) = lines.next().and_then(|l| l.strip_prefix("version ")) else {
        return Err("manifest: missing version line".into());
    };
    let mut listed = HashSet::new();
    for l in lines {
        let Some((want, name)) = l.split_once("  ") else {
            return Err(format!("manifest: bad line {l:?}"));
        };
        if !safe_name(name) {
            return Err(format!("manifest: bad line {l:?}"));
        }
        let got = hash_file(&join_rel(dir, name)).map_err(|e| format!("{name}: {e}"))?;
        if got != want {
            return Err(format!("{name}: hash mismatch"));
        }
        listed.insert(name.to_string());
    }
    for n in files(dir)? {
        if !listed.contains(&n) {
            return Err(format!("{n}: not in the manifest"));
        }
    }
    Ok(version.to_string())
}

/// `codrawer_bridge_rs release …` (release_cmd.go). Returns the exit code.
///
/// ```text
/// release keygen <priv-file> <pub-file>
/// release manifest <dir> <version>
/// release sign <dir> <priv-file>
/// release verify <dir> <pub-file-or-base64>   prints the version; exit 1 if invalid
/// ```
pub fn run_release(args: &[String]) -> i32 {
    let usage = || {
        eprintln!("usage: release keygen <priv> <pub> | manifest <dir> <version> | sign <dir> <priv> | verify <dir> <pub>");
        2
    };
    if args.len() < 3 {
        return usage();
    }
    // a path to a key file, or the key itself given inline
    let read = |p: &str| fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_else(|_| p.to_string());
    let (a1, a2) = (args[1].as_str(), args[2].as_str());
    let r = match args[0].as_str() {
        "keygen" => generate_key().and_then(|(sk, pk)| {
            write_file(a1, &format!("{sk}\n"), 0o600)?;
            write_file(a2, &format!("{pk}\n"), 0o644)
        }),
        "manifest" => build_manifest(Path::new(a1), a2),
        "sign" => sign(Path::new(a1), &read(a2)),
        "verify" => verify(Path::new(a1), &read(a2)).map(|v| println!("{v}")),
        _ => return usage(),
    };
    match r {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("release {}: {e}", args[0]);
            1
        }
    }
}

/// Go's `os.WriteFile(p, data, mode)`: the mode applies when the file is created.
fn write_file(p: &str, data: &str, mode: u32) -> Result<(), String> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut f = o.open(p).map_err(|e| format!("open {p}: {e}"))?;
    f.write_all(data.as_bytes()).map_err(|e| format!("write {p}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A fresh directory under the system temp dir, removed on drop (Go's `t.TempDir`).
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!("codrawer-release-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(dir: &Path, name: &str, body: &[u8]) {
        let p = join_rel(dir, name);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn signed() -> (TempDir, String) {
        let t = TempDir::new();
        write(&t.0, "codrawer_bridge_native", b"binary");
        write(&t.0, "boot.sh", b"#!/bin/sh\n");
        write(&t.0, "units/codrawer-bridge.service", b"[Unit]\n");
        let (sk, pk) = generate_key().unwrap();
        build_manifest(&t.0, "2026.10.02-1").unwrap();
        sign(&t.0, &sk).unwrap();
        (t, pk)
    }

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    #[test]
    fn signed_release_verifies() {
        let (t, pk) = signed();
        assert_eq!(verify(&t.0, &pk).unwrap(), "2026.10.02-1");
        let m = fs::read_to_string(t.0.join(MANIFEST_NAME)).unwrap();
        assert!(m.contains("  units/codrawer-bridge.service\n"), "manifest lists nested files with slashes:\n{m}");
    }

    #[test]
    fn tampering_is_rejected() {
        type Tamper = fn(&Path);
        let cases: [(&str, Tamper); 4] = [
            ("changed file", |d| write(d, "boot.sh", b"#!/bin/sh\nrm -rf /\n")),
            ("extra file", |d| write(d, "evil.sh", b"x")),
            ("missing file", |d| fs::remove_file(d.join("boot.sh")).unwrap()),
            ("edited manifest", |d| {
                let p = d.join(MANIFEST_NAME);
                let m = fs::read_to_string(&p).unwrap();
                fs::write(&p, m.replacen("2026.10.02-1", "9999", 1)).unwrap();
            }),
        ];
        for (name, tamper) in cases {
            let (t, pk) = signed();
            tamper(&t.0);
            assert!(verify(&t.0, &pk).is_err(), "{name}: tampered release verified");
        }
    }

    #[test]
    fn wrong_key_is_rejected() {
        let (t, _) = signed();
        let (_, other) = generate_key().unwrap();
        assert!(verify(&t.0, &other).is_err(), "verified with someone else's key");
    }

    // Interop with the Go tool: tests/fixtures/go-release was sealed by
    // `go run ./cmd/codrawer-release seal` (bridge/remarkable/native) with the throwaway key
    // go-release.TEST-ONLY.priv.

    #[test]
    fn verifies_a_release_signed_by_go() {
        let pk = fs::read_to_string(fixture("go-release.pub")).unwrap();
        assert_eq!(verify(&fixture("go-release"), &pk).unwrap(), "2026.10.02-go");
    }

    #[test]
    fn manifest_and_signature_match_go_byte_for_byte() {
        let dir = fixture("go-release");
        let go_manifest = fs::read(dir.join(MANIFEST_NAME)).unwrap();
        assert_eq!(String::from_utf8(manifest(&dir, "2026.10.02-go").unwrap()).unwrap(), String::from_utf8(go_manifest.clone()).unwrap());
        // ed25519 is deterministic: the same seed signs the same bytes identically.
        let t = TempDir::new();
        for n in files(&dir).unwrap() {
            write(&t.0, &n, &fs::read(join_rel(&dir, &n)).unwrap());
        }
        build_manifest(&t.0, "2026.10.02-go").unwrap();
        let seed = fs::read_to_string(fixture("go-release.TEST-ONLY.priv")).unwrap();
        sign(&t.0, &seed).unwrap();
        assert_eq!(fs::read(t.0.join(MANIFEST_NAME)).unwrap(), go_manifest);
        assert_eq!(fs::read_to_string(t.0.join(SIGNATURE_NAME)).unwrap(), fs::read_to_string(dir.join(SIGNATURE_NAME)).unwrap());
        // and the public key is the one Go derived from that seed
        let sk = parse_priv(&seed).unwrap();
        assert_eq!(BASE64.encode(sk.verifying_key().as_bytes()), fs::read_to_string(fixture("go-release.pub")).unwrap().trim());
    }

    #[test]
    fn manifest_paths_must_stay_inside() {
        for bad in ["", "../x", "a/../b", "/etc/passwd", "a//b", "./a", "a/.", "x..y"] {
            assert!(!safe_name(bad), "{bad:?} accepted");
        }
        #[cfg(windows)]
        for bad in ["C:/x", "C:x", "\\\\server\\share"] {
            assert!(!safe_name(bad), "{bad:?} accepted");
        }
        for good in ["boot.sh", "units/codrawer-bridge.service", "a b/c.d"] {
            assert!(safe_name(good), "{good:?} rejected");
        }
        // a signed manifest that names a path outside the release is refused before reading it
        let t = TempDir::new();
        write(&t.0, "a", b"x");
        let (sk, pk) = generate_key().unwrap();
        fs::write(t.0.join(MANIFEST_NAME), format!("version 1\n{}  ../a\n", hex(&Sha256::digest(b"x")))).unwrap();
        sign(&t.0, &sk).unwrap();
        let e = verify(&t.0, &pk).unwrap_err();
        assert!(e.starts_with("manifest: bad line"), "{e}");
    }

    #[test]
    fn bad_inputs() {
        let t = TempDir::new();
        assert!(build_manifest(&t.0, "").is_err());
        assert!(build_manifest(&t.0, "1 2").is_err());
        assert!(build_manifest(&t.0, "a/b").is_err());
        build_manifest(&t.0, "1").unwrap();
        assert_eq!(fs::read_to_string(t.0.join(MANIFEST_NAME)).unwrap(), "version 1\n");
        assert!(sign(&t.0, "short").is_err());
        let (_, pk) = generate_key().unwrap();
        assert!(sign(&t.0, &pk).is_ok(), "any 32 bytes are a seed");
        assert!(verify(&t.0, "bm9wZQ==").is_err());
        assert_eq!(hex(&[0x00, 0xab, 0xff]), "00abff");
    }

    #[test]
    fn command_line() {
        let t = TempDir::new();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let a = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let rel = t.0.join("rel");
        write(&rel, "f", b"1");
        let (sk, pk) = (s(&t.0.join("k.priv")), s(&t.0.join("k.pub")));
        assert_eq!(run_release(&a(&["keygen", &sk, &pk])), 0);
        assert_eq!(run_release(&a(&["manifest", &s(&rel), "v1"])), 0);
        assert_eq!(run_release(&a(&["sign", &s(&rel), &sk])), 0);
        assert_eq!(run_release(&a(&["verify", &s(&rel), &pk])), 0);
        let inline = fs::read_to_string(&pk).unwrap();
        assert_eq!(run_release(&a(&["verify", &s(&rel), inline.trim()])), 0, "a key given inline");
        write(&rel, "f", b"2");
        assert_eq!(run_release(&a(&["verify", &s(&rel), &pk])), 1);
        assert_eq!(run_release(&a(&["verify", &s(&rel)])), 2);
        assert_eq!(run_release(&a(&["bogus", "a", "b"])), 2);
    }
}
