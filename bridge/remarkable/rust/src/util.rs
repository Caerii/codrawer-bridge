//! Small helpers used across the bridge (util.go).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

pub fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

pub fn norm(v: i32, vmin: i32, vmax: i32) -> f64 {
    if vmax <= vmin {
        return 0.0;
    }
    clamp01((v as f64 - vmin as f64) / (vmax as f64 - vmin as f64))
}

fn getenv(k: &str) -> String {
    std::env::var(k).unwrap_or_default()
}

pub fn getenv_default(k: &str, def: &str) -> String {
    let v = getenv(k);
    if v.is_empty() {
        def.to_string()
    } else {
        v
    }
}

/// Like Go's `fmt.Sscanf(v, "%d", &out)`: a leading (optionally signed) integer, rest ignored.
pub fn getenv_int_default(k: &str, def: i64) -> i64 {
    let v = getenv(k);
    if v.is_empty() {
        return def;
    }
    scan_int(&v).unwrap_or(def)
}

/// Like Go's `fmt.Sscanf(v, "%f", &out)`, rejecting NaN and ±Inf.
pub fn getenv_float_default(k: &str, def: f64) -> f64 {
    let v = getenv(k);
    if v.is_empty() {
        return def;
    }
    match scan_float(&v) {
        Some(f) if f.is_finite() => f,
        _ => def,
    }
}

pub fn getenv_bool_default(k: &str, def: bool) -> bool {
    let v = getenv(k);
    if v.is_empty() {
        return def;
    }
    match v.trim().to_lowercase().as_str() {
        "1" | "true" | "yes" | "y" => true,
        "0" | "false" | "no" | "n" => false,
        _ => def,
    }
}

pub fn scan_int(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let b = s.as_bytes();
    let mut end = 0;
    if end < b.len() && (b[end] == b'+' || b[end] == b'-') {
        end += 1;
    }
    let digits_start = end;
    while end < b.len() && (b[end].is_ascii_digit() || b[end] == b'_') {
        end += 1;
    }
    if end == digits_start {
        return None;
    }
    s[..end].replace('_', "").parse().ok()
}

pub fn scan_float(s: &str) -> Option<f64> {
    let s = s.trim_start();
    // The longest prefix that parses as a float (Sscanf stops at the first character that can't
    // continue the number).
    let end = s
        .char_indices()
        .take_while(|(_, c)| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.' | '_'))
        .map(|(i, c)| i + c.len_utf8())
        .last()?;
    (1..=end)
        .rev()
        .filter(|&i| s.is_char_boundary(i))
        .find_map(|i| s[..i].replace('_', "").parse::<f64>().ok())
}

/// Formats a duration the way Go's `time.Duration.String` does (e.g. `500ms`, `1.445s`).
pub fn go_duration(d: Duration) -> String {
    let ns = d.as_nanos();
    if ns == 0 {
        return "0s".into();
    }
    fn frac(v: u128, unit: u128, suffix: &str) -> String {
        let whole = v / unit;
        let rem = v % unit;
        if rem == 0 {
            return format!("{whole}{suffix}");
        }
        let width = unit.to_string().len() - 1;
        let f = format!("{rem:0width$}");
        format!("{whole}.{}{suffix}", f.trim_end_matches('0'))
    }
    if ns < 1_000 {
        format!("{ns}ns")
    } else if ns < 1_000_000 {
        frac(ns, 1_000, "µs")
    } else if ns < 1_000_000_000 {
        frac(ns, 1_000_000, "ms")
    } else {
        let total_s = ns / 1_000_000_000;
        let (h, m) = (total_s / 3600, (total_s / 60) % 60);
        let secs = frac(ns % 60_000_000_000, 1_000_000_000, "s");
        match (h, m) {
            (0, 0) => secs,
            (0, _) => format!("{m}m{secs}"),
            _ => format!("{h}h{m}m{secs}"),
        }
    }
}

/// `YYYY/MM/DD HH:MM:SS ` in UTC, the prefix Go's `log.Printf` writes (Go uses local time; the
/// tablet runs on UTC).
pub fn log_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}/{m:02}/{d:02} {:02}:{:02}:{:02} ",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_format_like_go() {
        assert_eq!(go_duration(Duration::from_millis(500)), "500ms");
        assert_eq!(go_duration(Duration::from_millis(1445)), "1.445s");
        assert_eq!(go_duration(Duration::from_secs(5)), "5s");
        assert_eq!(go_duration(Duration::from_micros(632_100)), "632.1ms");
        assert_eq!(go_duration(Duration::from_secs(90)), "1m30s");
    }

    #[test]
    fn scans_like_sscanf() {
        assert_eq!(scan_int(" 60"), Some(60));
        assert_eq!(scan_int("12abc"), Some(12));
        assert_eq!(scan_int("x"), None);
        assert_eq!(scan_float("0.02"), Some(0.02));
        assert_eq!(scan_float("1.5s"), Some(1.5));
        assert_eq!(scan_float("abc"), None);
    }

    #[test]
    fn norm_clamps() {
        assert_eq!(norm(5, 0, 10), 0.5);
        assert_eq!(norm(20, 0, 10), 1.0);
        assert_eq!(norm(5, 10, 10), 0.0);
    }
}
