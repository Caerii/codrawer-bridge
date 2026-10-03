//! `/proc/bus/input/devices` parsing and keyboard selection (device_select.go, keyboard.go).
//! Portable: on a host without /proc the list is simply empty.

use crate::keymap::VIRTUAL_KEYBOARD_NAME;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct InputDeviceInfo {
    pub name: String,
    pub handlers: Vec<String>,
    /// A uinput device (bus 0x06), e.g. a typist injecting text.
    pub virtual_dev: bool,
}

pub fn parse_proc_input_devices(text: &str) -> Vec<InputDeviceInfo> {
    let mut out = Vec::new();
    for blk in text.split("\n\n") {
        let mut info = InputDeviceInfo::default();
        for line in blk.split('\n') {
            // "I: Bus=0006 Vendor=…": bus 0x06 is BUS_VIRTUAL (uinput devices)
            if let Some(v) = line.strip_prefix("I: Bus=") {
                info.virtual_dev = v.starts_with("0006");
            }
            if let Some(v) = line.strip_prefix("N: Name=") {
                info.name = v.trim_matches(|c| c == ' ' || c == '"').to_string();
            }
            if let Some(v) = line.strip_prefix("H: Handlers=") {
                info.handlers = v.split_whitespace().map(str::to_string).collect();
            }
        }
        if !info.name.is_empty() || !info.handlers.is_empty() {
            out.push(info);
        }
    }
    out
}

pub fn list_proc_input_devices() -> Vec<InputDeviceInfo> {
    std::fs::read_to_string("/proc/bus/input/devices")
        .map(|t| parse_proc_input_devices(&t))
        .unwrap_or_default()
}

/// Picks a keyboard's event node: a device with a `kbd` handler that is not the tablet's power
/// key, our own virtual keyboard, or any other virtual (uinput) keyboard; a name containing "keyboard" wins, else the first candidate.
pub fn pick_keyboard(devs: &[InputDeviceInfo]) -> Option<String> {
    let mut fallback = None;
    for d in devs {
        let has_kbd = d.handlers.iter().any(|h| h == "kbd");
        let event = d.handlers.iter().rev().find(|h| h.starts_with("event"));
        let (true, Some(event)) = (has_kbd, event) else { continue };
        let lname = d.name.to_lowercase();
        // Skip the power key, our own typer, and any other virtual (uinput) keyboard: e.g.
        // smart_remarkable's typist would otherwise be streamed as the user's keystrokes.
        if lname.contains("powerkey") || lname.contains("power button") || lname == VIRTUAL_KEYBOARD_NAME || d.virtual_dev {
            continue;
        }
        let path = format!("/dev/input/{event}");
        if lname.contains("keyboard") {
            return Some(path);
        }
        fallback.get_or_insert(path);
    }
    fallback
}

/// An explicit path wins; "auto" (or empty) searches /proc.
pub fn find_keyboard_device(explicit: &str) -> Result<String, String> {
    if !explicit.is_empty() && explicit != "auto" {
        return Ok(explicit.to_string());
    }
    pick_keyboard(&list_proc_input_devices()).ok_or_else(|| {
        "no keyboard input device found (pair one with bluetoothctl, or pass -keyboard /dev/input/eventN)"
            .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROC: &str = "I: Bus=0019 Vendor=0001 Product=0001 Version=0100
N: Name=\"30370000.snvs:snvs-powerkey\"
H: Handlers=kbd event0

I: Bus=0018 Vendor=04f3 Product=2d42 Version=0100
N: Name=\"Elan marker input\"
H: Handlers=event2

I: Bus=0006 Vendor=5349 Product=4742 Version=0001
N: Name=\"codrawer virtual keyboard\"
H: Handlers=sysrq kbd event5

I: Bus=0005 Vendor=05ac Product=0256 Version=0001
N: Name=\"Pebble Keys 2 K380s\"
H: Handlers=sysrq kbd leds event6
";

    #[test]
    fn parses_proc() {
        let devs = parse_proc_input_devices(PROC);
        assert_eq!(devs.len(), 4);
        assert_eq!(devs[1].name, "Elan marker input");
        assert_eq!(devs[1].handlers, vec!["event2"]);
        assert_eq!(devs.iter().map(|d| d.virtual_dev).collect::<Vec<_>>(), [false, false, true, false]);
    }

    #[test]
    fn keyboard_auto_detect_skips_power_key_and_virtual_keyboard() {
        let devs = parse_proc_input_devices(PROC);
        assert_eq!(pick_keyboard(&devs).as_deref(), Some("/dev/input/event6"));
        // At boot only the power key and our virtual keyboard exist: nothing to pick.
        assert_eq!(pick_keyboard(&devs[..3]), None);
    }

    #[test]
    fn keyboard_auto_detect_skips_every_virtual_device() {
        // Another uinput keyboard (e.g. smart_remarkable's typist), named like a keyboard: skipped.
        let text = format!(
            "{PROC}\nI: Bus=0006 Vendor=0000 Product=0000 Version=0000\nN: Name=\"typist keyboard\"\nH: Handlers=sysrq kbd event7\n"
        );
        let devs = parse_proc_input_devices(&text);
        assert!(devs[4].virtual_dev && devs[4].name == "typist keyboard");
        assert_eq!(pick_keyboard(&devs).as_deref(), Some("/dev/input/event6"));
        let without_pebble: Vec<_> = devs.iter().filter(|d| !d.name.starts_with("Pebble")).cloned().collect();
        assert_eq!(pick_keyboard(&without_pebble), None);
    }

    #[test]
    fn keyboard_named_device_wins_over_fallback() {
        let mut devs = parse_proc_input_devices(PROC);
        devs.push(InputDeviceInfo { name: "Logitech Keyboard".into(), handlers: vec!["kbd".into(), "event9".into()], virtual_dev: false });
        assert_eq!(pick_keyboard(&devs).as_deref(), Some("/dev/input/event9"));
        assert_eq!(find_keyboard_device("/dev/input/event3").unwrap(), "/dev/input/event3");
    }
}
