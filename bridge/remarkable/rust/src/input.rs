//! Linux input constants and the `input_event` stream parser (linux_input.go). Portable: the
//! parser only sees bytes, so it is tested on any host; the ioctls live in `linux`.

pub const EV_SYN: u16 = 0x00;
pub const EV_KEY: u16 = 0x01;
pub const EV_ABS: u16 = 0x03;

// Stylus tool keys
pub const BTN_TOUCH: u16 = 0x14A;
pub const BTN_TOOL_PEN: u16 = 0x140;
pub const BTN_TOOL_RUBBER: u16 = 0x141;

// ABS axes
pub const ABS_X: u16 = 0x00;
pub const ABS_Y: u16 = 0x01;
pub const ABS_PRESSURE: u16 = 0x18;
pub const ABS_DISTANCE: u16 = 0x19;

pub const SYN_REPORT: u16 = 0x00;

/// One parsed `input_event` (type, code, value).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawEvent {
    pub etype: u16,
    pub code: u16,
    pub value: i32,
}

/// Axis ranges from EVIOCGABS, used to normalize to 0..1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AbsRanges {
    pub x_min: i32,
    pub x_max: i32,
    pub y_min: i32,
    pub y_max: i32,
    pub p_min: i32,
    pub p_max: i32,
}

impl Default for AbsRanges {
    /// The fallback when an ioctl fails (same as Go).
    fn default() -> Self {
        AbsRanges { x_min: 0, x_max: 1, y_min: 0, y_max: 1, p_min: 0, p_max: 4096 }
    }
}

/// Parses `input_event` structs from a byte stream. The kernel struct is 24 bytes on 64-bit
/// (timeval 16 + type 2 + code 2 + value 4) and 16 on 32-bit; the size is guessed from the
/// first chunk exactly as the Go parser does.
#[derive(Debug, Default)]
pub struct InputParser {
    buf: Vec<u8>,
    sz: usize,
}

impl InputParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, chunk: &[u8], mut cb: impl FnMut(RawEvent)) {
        self.buf.extend_from_slice(chunk);
        if self.sz == 0 {
            let n = self.buf.len();
            if n >= 48 && n % 24 == 0 {
                self.sz = 24;
            } else if n >= 32 && n % 16 == 0 {
                self.sz = 16;
            } else if n >= 24 {
                // fallback: assume 24 on 64-bit devices (Paper Pro is aarch64)
                self.sz = 24;
            }
        }
        if self.sz == 0 {
            return;
        }
        let sz = self.sz;
        let whole = self.buf.len() / sz * sz;
        for ev in self.buf[..whole].chunks_exact(sz) {
            let off = if sz == 24 { 16 } else { 8 };
            cb(RawEvent {
                etype: u16::from_le_bytes([ev[off], ev[off + 1]]),
                code: u16::from_le_bytes([ev[off + 2], ev[off + 3]]),
                value: i32::from_le_bytes([ev[off + 4], ev[off + 5], ev[off + 6], ev[off + 7]]),
            });
        }
        self.buf.drain(..whole);
    }
}

/// Encodes one 24-byte (aarch64) `input_event` with a zero timestamp, as uinput expects.
pub fn encode_event24(etype: u16, code: u16, value: i32) -> [u8; 24] {
    let mut ev = [0u8; 24];
    ev[16..18].copy_from_slice(&etype.to_le_bytes());
    ev[18..20].copy_from_slice(&code.to_le_bytes());
    ev[20..24].copy_from_slice(&value.to_le_bytes());
    ev
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_24_byte_events_across_chunk_boundaries() {
        let mut bytes = Vec::new();
        bytes.extend(encode_event24(EV_ABS, ABS_X, 1234));
        bytes.extend(encode_event24(EV_KEY, BTN_TOUCH, 1));
        bytes.extend(encode_event24(EV_SYN, SYN_REPORT, 0));
        let mut p = InputParser::new();
        let mut got = Vec::new();
        p.feed(&bytes[..48], |e| got.push(e)); // first chunk fixes the size
        p.feed(&bytes[48..60], |e| got.push(e)); // half an event
        p.feed(&bytes[60..], |e| got.push(e));
        assert_eq!(
            got,
            vec![
                RawEvent { etype: EV_ABS, code: ABS_X, value: 1234 },
                RawEvent { etype: EV_KEY, code: BTN_TOUCH, value: 1 },
                RawEvent { etype: EV_SYN, code: SYN_REPORT, value: 0 },
            ]
        );
    }

    #[test]
    fn negative_values_survive() {
        let mut p = InputParser::new();
        let mut got = Vec::new();
        let mut b = encode_event24(EV_ABS, ABS_Y, -7).to_vec();
        b.extend(encode_event24(EV_SYN, SYN_REPORT, 0));
        p.feed(&b, |e| got.push(e));
        assert_eq!(got[0].value, -7);
    }
}
