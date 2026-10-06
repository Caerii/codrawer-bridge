//! Bridge configuration: env vars give the defaults, flags override (main.go).
//!
//! The command line follows Go's `flag` package so the same invocations work for both binaries:
//! `-name value`, `-name=value`, `--name`, bool flags as `-name` or `-name=false`, parsing stops at
//! the first non-flag argument or `--`, `-h`/`-help` prints usage and exits 0, errors exit 2.

use crate::util::{getenv_bool_default, getenv_default, getenv_float_default, getenv_int_default};

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub ws_url: String,
    pub brush: String,
    pub color: String,
    pub input_device: String,
    pub batch_hz: i64,
    pub max_batch_points: i64,
    pub no_grab: bool,

    pub touch_mode: String,
    pub pressure_threshold: f64,
    pub distance_threshold: i64,

    pub debug: bool,
    pub dump_events: bool,
    pub list_devices: bool,

    pub probe_seconds: f64,
    pub ping_seconds: f64,
    pub pong_timeout_seconds: f64,

    /// "auto" (find a kbd device), "off", or an explicit /dev/input/eventN.
    pub keyboard: String,
    pub keyboard_grab: bool,

    /// Type terminal (`term`) replies into the tablet's focused text field (uinput).
    pub type_replies: bool,
    /// Pause after each typed write, ms; 0 (default) keeps the speed preset's own (typer.rs).
    pub type_char_ms: i64,

    /// Cursor messages per second while the pen hovers (0: off).
    pub hover_hz: i64,

    /// Run the stroke router in this process; `router_only` skips the pen and keyboard.
    pub serve_addr: String,
    pub router_only: bool,

    /// Page watcher (page_watch.rs): `auto`, `on` or `off`; xochitl's data directory (read-only);
    /// how often it is checked (ms).
    pub page_watch: String,
    pub xochitl_dir: String,
    pub page_poll_ms: i64,
    /// Where the codrawer-layer XOVI extension reports xochitl's selected tool ([`crate::toolhint`]),
    /// so that the toolbar Eraser used with the tip streams as an eraser. "off" disables it; an
    /// absent or stale file changes nothing.
    pub tool_file: String,
    /// The codrawer-layer extension's socket ([`crate::agent_ink`]); "off" disables it (agent ink
    /// and dock actions).
    pub ink_socket: String,
    /// Forward the router's ai-layer strokes to that socket, to be committed as real xochitl ink
    /// on the "codrawer: agent" layer (NATIVE_AGENT_INK, off by default).
    pub native_agent_ink: bool,
    /// `-page-dump`: print the open page's `page` message and exit (no env var, as in Go).
    pub page_dump: bool,
}

impl Config {
    /// Defaults from the environment, exactly as the Go binary reads them.
    pub fn from_env() -> Self {
        Config {
            ws_url: getenv_default("DESKTOP_WS", "ws://127.0.0.1:8000/ws/session1"),
            brush: getenv_default("BRUSH", "pen"),
            color: std::env::var("COLOR").unwrap_or_default(),
            input_device: std::env::var("INPUT_DEVICE").unwrap_or_default(),
            batch_hz: getenv_int_default("BATCH_HZ", 60),
            max_batch_points: getenv_int_default("MAX_BATCH_POINTS", 64),
            no_grab: getenv_bool_default("NO_GRAB", true),
            touch_mode: getenv_default("TOUCH_MODE", "auto"),
            pressure_threshold: getenv_float_default("PRESSURE_THRESHOLD", 0.02),
            distance_threshold: getenv_int_default("DISTANCE_THRESHOLD", 0),
            debug: getenv_bool_default("DEBUG", false),
            dump_events: getenv_bool_default("DUMP_EVENTS", false),
            list_devices: false,
            probe_seconds: getenv_float_default("PROBE_SECONDS", 1.5),
            ping_seconds: getenv_float_default("PING_SECONDS", 10.0),
            pong_timeout_seconds: getenv_float_default("PONG_TIMEOUT_SECONDS", 25.0),
            keyboard: getenv_default("KEYBOARD_DEVICE", "auto"),
            keyboard_grab: getenv_bool_default("KEYBOARD_GRAB", false),
            type_replies: getenv_bool_default("TYPE_REPLIES", true),
            type_char_ms: getenv_int_default("TYPE_CHAR_MS", 0),
            hover_hz: getenv_int_default("HOVER_HZ", 30),
            serve_addr: std::env::var("SERVE_ADDR").unwrap_or_default(),
            router_only: getenv_bool_default("ROUTER_ONLY", false),
            page_watch: getenv_default("PAGE_WATCH", "auto"),
            xochitl_dir: getenv_default("XOCHITL_DIR", crate::pagewatch::DEFAULT_DIR),
            page_poll_ms: getenv_int_default("PAGE_POLL_MS", 1000),
            tool_file: getenv_default("TOOL_FILE", crate::toolhint::DEFAULT_PATH),
            ink_socket: getenv_default("INK_SOCKET", "/run/codrawer/ink.sock"),
            native_agent_ink: getenv_bool_default("NATIVE_AGENT_INK", false),
            page_dump: false,
        }
    }
}

enum Slot<'a> {
    Str(&'a mut String),
    Int(&'a mut i64),
    Float(&'a mut f64),
    Bool(&'a mut bool),
}

struct FlagDef {
    name: &'static str,
    usage: &'static str,
}

const FLAGS: &[FlagDef] = &[
    FlagDef { name: "ws", usage: "WebSocket URL to desktop server" },
    FlagDef { name: "brush", usage: "Brush name for pen strokes (non-eraser)" },
    FlagDef { name: "color", usage: "Optional color hint (e.g. #00ff88). Not available from raw input; set via config." },
    FlagDef { name: "input", usage: "Input device path (e.g. /dev/input/event3). If empty, auto-detect." },
    FlagDef { name: "batch-hz", usage: "Batch flush rate (Hz)" },
    FlagDef { name: "max-batch", usage: "Max points per batch" },
    FlagDef { name: "no-grab", usage: "Do not EVIOCGRAB the input device (recommended)" },
    FlagDef { name: "touch-mode", usage: "How to detect contact: auto|btn|pressure|distance|tool" },
    FlagDef { name: "pressure-threshold", usage: "Contact threshold for pressure mode (0..1)" },
    FlagDef { name: "distance-threshold", usage: "Contact threshold for distance mode (down if ABS_DISTANCE <= threshold)" },
    FlagDef { name: "debug", usage: "Print contact transitions + periodic stats" },
    FlagDef { name: "dump-events", usage: "Print raw input events (type/code/value). Noisy." },
    FlagDef { name: "list-devices", usage: "Print /proc/bus/input/devices names/handlers and exit" },
    FlagDef { name: "probe-seconds", usage: "Seconds to probe each /dev/input/event* for activity when auto-detecting (draw during this!)" },
    FlagDef { name: "ping-seconds", usage: "WebSocket ping interval (seconds)." },
    FlagDef { name: "pong-timeout-seconds", usage: "Reconnect if no pong is received in this window." },
    FlagDef { name: "keyboard", usage: "Keyboard device: auto (find a kbd device), off, or /dev/input/eventN. Emits key messages." },
    FlagDef { name: "keyboard-grab", usage: "EVIOCGRAB the keyboard so only the bridge receives it (default: the tablet UI keeps it too)" },
    FlagDef { name: "type-replies", usage: "Type terminal replies into the tablet's focused text field via a virtual keyboard (uinput)" },
    FlagDef { name: "type-char-ms", usage: "Milliseconds of pause after each typed write (0: the speed preset's; TYPE_SPEED picks careful, fast or instant)" },
    FlagDef { name: "hover-hz", usage: "Pen hover position (cursor messages) per second, for a pointer on viewers; 0 disables" },
    FlagDef { name: "serve", usage: "Also run the stroke router on this address (e.g. :8577); point -ws at ws://127.0.0.1:<port>/ws/<session>" },
    FlagDef { name: "router-only", usage: "Run only the router (-serve), no pen or keyboard (e.g. on a desktop)" },
    FlagDef { name: "page-watch", usage: "Send xochitl's saved page as `page` snapshots: auto (only on an OS boot.sh lists as tested), on, off" },
    FlagDef { name: "xochitl-dir", usage: "xochitl's data directory (read-only)" },
    FlagDef { name: "page-poll-ms", usage: "How often the page watcher checks xochitl's files (ms)" },
    FlagDef { name: "tool-file", usage: "xochitl's selected tool, written by the codrawer-layer XOVI extension (toolbar Eraser → eraser strokes); off disables" },
    FlagDef { name: "ink-socket", usage: "The codrawer-layer XOVI extension's socket (agent ink in, dock actions out); off disables" },
    FlagDef { name: "native-agent-ink", usage: "Commit the router's ai-layer strokes as native xochitl ink on the codrawer: agent layer (needs the extension)" },
    FlagDef { name: "page-dump", usage: "Print the `page` message for the open document and page, then exit (read-only)" },
];

fn slot<'a>(cfg: &'a mut Config, name: &str) -> Option<Slot<'a>> {
    Some(match name {
        "ws" => Slot::Str(&mut cfg.ws_url),
        "brush" => Slot::Str(&mut cfg.brush),
        "color" => Slot::Str(&mut cfg.color),
        "input" => Slot::Str(&mut cfg.input_device),
        "batch-hz" => Slot::Int(&mut cfg.batch_hz),
        "max-batch" => Slot::Int(&mut cfg.max_batch_points),
        "no-grab" => Slot::Bool(&mut cfg.no_grab),
        "touch-mode" => Slot::Str(&mut cfg.touch_mode),
        "pressure-threshold" => Slot::Float(&mut cfg.pressure_threshold),
        "distance-threshold" => Slot::Int(&mut cfg.distance_threshold),
        "debug" => Slot::Bool(&mut cfg.debug),
        "dump-events" => Slot::Bool(&mut cfg.dump_events),
        "list-devices" => Slot::Bool(&mut cfg.list_devices),
        "probe-seconds" => Slot::Float(&mut cfg.probe_seconds),
        "ping-seconds" => Slot::Float(&mut cfg.ping_seconds),
        "pong-timeout-seconds" => Slot::Float(&mut cfg.pong_timeout_seconds),
        "keyboard" => Slot::Str(&mut cfg.keyboard),
        "keyboard-grab" => Slot::Bool(&mut cfg.keyboard_grab),
        "type-replies" => Slot::Bool(&mut cfg.type_replies),
        "type-char-ms" => Slot::Int(&mut cfg.type_char_ms),
        "hover-hz" => Slot::Int(&mut cfg.hover_hz),
        "serve" => Slot::Str(&mut cfg.serve_addr),
        "router-only" => Slot::Bool(&mut cfg.router_only),
        "page-watch" => Slot::Str(&mut cfg.page_watch),
        "xochitl-dir" => Slot::Str(&mut cfg.xochitl_dir),
        "page-poll-ms" => Slot::Int(&mut cfg.page_poll_ms),
        "tool-file" => Slot::Str(&mut cfg.tool_file),
        "ink-socket" => Slot::Str(&mut cfg.ink_socket),
        "native-agent-ink" => Slot::Bool(&mut cfg.native_agent_ink),
        "page-dump" => Slot::Bool(&mut cfg.page_dump),
        _ => return None,
    })
}

/// Outcome of a parse that should not continue into the program.
#[derive(Debug, PartialEq)]
pub enum FlagExit {
    /// `-h` / `-help`: usage printed, exit 0.
    Help,
    /// A bad flag: the message (usage follows), exit 2.
    Error(String),
}

/// Go's `strconv.ParseBool`.
fn parse_go_bool(s: &str) -> Option<bool> {
    match s {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Some(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Some(false),
        _ => None,
    }
}

/// Go's `strconv.ParseInt(s, 0, 64)`: optional sign, 0x/0o/0b/0 prefixes, underscores.
fn parse_go_int(s: &str) -> Option<i64> {
    let (neg, body) = match s.as_bytes().first()? {
        b'-' => (true, &s[1..]),
        b'+' => (false, &s[1..]),
        _ => (false, s),
    };
    let lower = body.to_ascii_lowercase();
    let (radix, digits) = if let Some(d) = lower.strip_prefix("0x") {
        (16, d.to_string())
    } else if let Some(d) = lower.strip_prefix("0o") {
        (8, d.to_string())
    } else if let Some(d) = lower.strip_prefix("0b") {
        (2, d.to_string())
    } else if lower.len() > 1 && lower.starts_with('0') {
        (8, lower[1..].to_string())
    } else {
        (10, lower.clone())
    };
    let digits = digits.replace('_', "");
    if digits.is_empty() || digits.starts_with('+') || digits.starts_with('-') {
        return None;
    }
    let v = i64::from_str_radix(&digits, radix).ok()?;
    Some(if neg { -v } else { v })
}

fn set(cfg: &mut Config, name: &str, value: &str) -> Result<(), String> {
    let bad = || format!("invalid value {value:?} for flag -{name}: parse error");
    match slot(cfg, name).expect("known flag") {
        Slot::Str(s) => *s = value.to_string(),
        Slot::Int(i) => *i = parse_go_int(value).ok_or_else(bad)?,
        Slot::Float(f) => *f = value.replace('_', "").parse().map_err(|_| bad())?,
        Slot::Bool(b) => *b = parse_go_bool(value).ok_or_else(bad)?,
    }
    Ok(())
}

/// Applies Go-style flags (without the program name) on top of `cfg`.
pub fn parse_args(cfg: &mut Config, args: &[String]) -> Result<(), FlagExit> {
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg.len() < 2 || !arg.starts_with('-') {
            break; // first non-flag argument
        }
        let mut name = &arg[1..];
        if let Some(rest) = name.strip_prefix('-') {
            if rest.is_empty() {
                break; // "--" terminates the flags
            }
            name = rest;
        }
        if name.is_empty() || name.starts_with('-') || name.starts_with('=') {
            return Err(FlagExit::Error(format!("bad flag syntax: {arg}")));
        }
        i += 1;
        let (name, inline) = match name.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (name, None),
        };
        let is_bool = match slot(cfg, name) {
            None if name == "h" || name == "help" => return Err(FlagExit::Help),
            None => return Err(FlagExit::Error(format!("flag provided but not defined: -{name}"))),
            Some(Slot::Bool(_)) => true,
            Some(_) => false,
        };
        let value = match inline {
            Some(v) => v,
            None if is_bool => "true".to_string(),
            None => {
                let Some(v) = args.get(i) else {
                    return Err(FlagExit::Error(format!("flag needs an argument: -{name}")));
                };
                i += 1;
                v.clone()
            }
        };
        set(cfg, name, &value).map_err(FlagExit::Error)?;
    }
    Ok(())
}

/// Go's `flag.UnquoteUsage`: the first back-quoted word in a usage string names the flag's
/// argument and loses its quotes (`"as `page` snapshots"` → `("page", "as page snapshots")`);
/// otherwise the argument is named after its type (`kind`, empty for bools).
fn unquote_usage(usage: &str, kind: &str) -> (String, String) {
    if let Some(start) = usage.find('`') {
        if let Some(len) = usage[start + 1..].find('`') {
            let name = &usage[start + 1..start + 1 + len];
            let text = format!("{}{}{}", &usage[..start], name, &usage[start + 2 + len..]);
            return (name.to_string(), text);
        }
    }
    (kind.to_string(), usage.to_string())
}

/// Usage text in the shape Go's `flag.PrintDefaults` prints.
pub fn usage(prog: &str, defaults: &Config) -> String {
    let mut d = defaults.clone();
    let mut out = format!("Usage of {prog}:\n");
    let mut names: Vec<&FlagDef> = FLAGS.iter().collect();
    names.sort_by_key(|f| f.name);
    for f in names {
        let (kind, def) = match slot(&mut d, f.name).expect("known flag") {
            Slot::Str(s) => ("string", if s.is_empty() { None } else { Some(format!("{s:?}")) }),
            Slot::Int(i) => ("int", if *i == 0 { None } else { Some(i.to_string()) }),
            Slot::Float(x) => ("float", if *x == 0.0 { None } else { Some(x.to_string()) }),
            Slot::Bool(b) => ("", if *b { Some("true".into()) } else { None }),
        };
        let (arg_name, text) = unquote_usage(f.usage, kind);
        out.push_str(&format!("  -{}", f.name));
        if !arg_name.is_empty() {
            out.push(' ');
            out.push_str(&arg_name);
        }
        out.push_str("\n    \t");
        out.push_str(&text);
        if let Some(def) = def {
            out.push_str(&format!(" (default {def})"));
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn base() -> Config {
        let mut c = Config::from_env();
        c.ws_url = "ws://x".into();
        c.no_grab = true;
        c
    }

    #[test]
    fn parses_like_go_flag() {
        let mut c = base();
        parse_args(
            &mut c,
            &args(&[
                "-ws", "ws://192.168.50.2:8577/ws/session1", "-input=/dev/input/event2",
                "--touch-mode", "auto", "-keyboard", "auto", "-type-replies", "-no-grab=false",
                "-batch-hz", "0x3c", "-pressure-threshold", "0.05", "-serve", ":8577", "-hover-hz", "0",
            ]),
        )
        .unwrap();
        assert_eq!(c.ws_url, "ws://192.168.50.2:8577/ws/session1");
        assert_eq!(c.input_device, "/dev/input/event2");
        assert!(c.type_replies);
        assert!(!c.no_grab);
        assert_eq!(c.batch_hz, 60);
        assert_eq!(c.pressure_threshold, 0.05);
        assert_eq!(c.serve_addr, ":8577");
        assert_eq!(c.hover_hz, 0);
        assert_eq!(crate::bridge::hover_every(0), std::time::Duration::ZERO);
        assert_eq!(crate::bridge::hover_every(30), std::time::Duration::from_nanos(33_333_333));
    }

    #[test]
    fn stops_at_first_non_flag_and_reports_errors() {
        let mut c = base();
        parse_args(&mut c, &args(&["-debug", "extra", "-ws", "nope"])).unwrap();
        assert!(c.debug);
        assert_eq!(c.ws_url, "ws://x");
        assert_eq!(parse_args(&mut c, &args(&["-h"])), Err(FlagExit::Help));
        assert!(matches!(parse_args(&mut c, &args(&["-bogus"])), Err(FlagExit::Error(_))));
        assert!(matches!(parse_args(&mut c, &args(&["-batch-hz", "fast"])), Err(FlagExit::Error(_))));
        assert!(matches!(parse_args(&mut c, &args(&["-ws"])), Err(FlagExit::Error(_))));
        // A bool flag never consumes the next argument.
        parse_args(&mut c, &args(&["-router-only", "-serve", ":1"])).unwrap();
        assert!(c.router_only);
        assert_eq!(c.serve_addr, ":1");
    }

    #[test]
    fn usage_lists_every_flag() {
        let u = usage("codrawer_bridge_rs", &base());
        for f in FLAGS {
            assert!(u.contains(&format!("  -{}", f.name)), "{}", f.name);
        }
    }

    #[test]
    fn page_watch_flags_and_go_style_usage() {
        let mut c = base();
        parse_args(&mut c, &args(&["-page-watch", "on", "-xochitl-dir=/tmp/x", "-page-poll-ms", "250", "-page-dump"])).unwrap();
        assert_eq!((c.page_watch.as_str(), c.xochitl_dir.as_str(), c.page_poll_ms, c.page_dump), ("on", "/tmp/x", 250, true));

        let mut d = base();
        d.page_watch = "auto".into();
        let u = usage("p", &d);
        // a back-quoted word names the argument, as Go's flag.UnquoteUsage does
        assert!(u.contains("  -page-watch page\n    \tSend xochitl's saved page as page snapshots: auto"), "{u}");
        assert!(u.contains("on, off (default \"auto\")\n"), "{u}");
        assert!(u.contains("  -page-dump page\n    \tPrint the page message"), "{u}");
        assert!(u.contains("  -page-poll-ms int\n"), "{u}");
        assert_eq!(unquote_usage("no quotes", "int"), ("int".to_string(), "no quotes".to_string()));
        assert_eq!(unquote_usage("one ` only", ""), (String::new(), "one ` only".to_string()));
    }

    /// Go's configuration source: flags and env defaults live in config.go (main.go wires).
    const GO_CONFIG: &str = include_str!("../../native/config.go");

    /// The flags match Go's config.go: every `flag.XxxVar(&v, "name", default, "usage")` there is
    /// defined here with the same usage text, and none other.
    #[test]
    fn same_flags_as_go() {
        let go = GO_CONFIG;
        let mut go_flags: Vec<(&str, &str)> = Vec::new();
        for line in go.lines().filter(|l| l.trim_start().starts_with("flag.") && l.contains("Var(")) {
            let parts: Vec<&str> = line.split('"').collect();
            go_flags.push((parts[1], parts[parts.len() - 2]));
        }
        go_flags.sort();
        let mut ours: Vec<(&str, &str)> = FLAGS.iter().map(|f| (f.name, f.usage)).collect();
        ours.sort();
        assert_eq!(ours, go_flags);
    }

    /// The environment variables read for the config match the ones Go's config.go reads.
    #[test]
    fn same_env_vars_as_go() {
        fn env_names(src: &str, markers: &[&str]) -> Vec<String> {
            let mut names = Vec::new();
            for marker in markers {
                for piece in src.split(marker).skip(1) {
                    if let Some(name) = piece.split('"').next() {
                        names.push(name.to_string());
                    }
                }
            }
            names.sort();
            names.dedup();
            names
        }
        let go = GO_CONFIG;
        let ours = include_str!("flags.rs").split("#[cfg(test)]").next().unwrap();
        let go_names = env_names(go, &["Default(\"", " env(\"", "(env(\"", "os.Getenv(\""]);
        let our_names = env_names(ours, &["_default(\"", "env::var(\""]);
        assert_eq!(our_names, go_names);
    }
}
