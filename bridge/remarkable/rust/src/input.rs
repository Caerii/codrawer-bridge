//! Linux input constants and the `input_event` stream parser (linux_input.go). Portable: the
//! parser only sees bytes, so it is tested on any host; the ioctls live in `linux`.

pub use crate::pen::{
    Event as RawEvent, Ranges as AbsRanges, ABS_DISTANCE, ABS_PRESSURE, ABS_X, ABS_Y, BTN_TOOL_PEN, BTN_TOOL_RUBBER,
    BTN_TOUCH, EV_ABS, EV_KEY, EV_SYN, SYN_DROPPED, SYN_REPORT,
};

/// `sizeof(struct input_event)` on this platform: a `timeval` of two `long`s, then type, code
/// and value. 24 bytes where `long` is 64-bit (the Paper Pro is aarch64), else 16.
pub const EVENT_SIZE: usize = if std::mem::size_of::<usize>() == 8 { 24 } else { 16 };

/// Parses `input_event` structs, with their kernel timestamps, from a byte stream. The struct
/// size follows the platform (Go used to guess it from the first read, which misread 48-byte
/// reads of 16-byte events).
#[derive(Debug)]
pub struct InputParser {
    /// A partial event carried over to the next read.
    buf: Vec<u8>,
    sz: usize,
}

impl Default for InputParser {
    fn default() -> Self {
        Self::new()
    }
}

impl InputParser {
    pub fn new() -> Self {
        Self::with_size(EVENT_SIZE)
    }

    /// A parser for `sz`-byte events (16 or 24); tests use it to cover the other layout.
    pub fn with_size(sz: usize) -> Self {
        assert!(sz == 16 || sz == 24, "input_event is 16 or 24 bytes");
        InputParser { buf: Vec::new(), sz }
    }

    pub fn feed(&mut self, chunk: &[u8], mut cb: impl FnMut(RawEvent)) {
        let sz = self.sz;
        let mut rest = chunk;
        if !self.buf.is_empty() {
            // complete the carried-over partial event first
            let need = sz - self.buf.len();
            let take = need.min(rest.len());
            self.buf.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.buf.len() < sz {
                return;
            }
            cb(decode(&self.buf, sz));
            self.buf.clear();
        }
        // common case: whole events straight from the caller's (reused) buffer, no copy
        let mut evs = rest.chunks_exact(sz);
        for ev in &mut evs {
            cb(decode(ev, sz));
        }
        self.buf.extend_from_slice(evs.remainder());
    }
}

fn le16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

fn le32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn le64(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().expect("8 bytes"))
}

fn decode(ev: &[u8], sz: usize) -> RawEvent {
    let (sec, usec, off) = if sz == 24 {
        (le64(ev, 0) as i64, le64(ev, 8) as i64, 16)
    } else {
        (le32(ev, 0) as i32 as i64, le32(ev, 4) as i32 as i64, 8)
    };
    RawEvent {
        etype: le16(ev, off),
        code: le16(ev, off + 2),
        value: le32(ev, off + 4) as i32,
        time_ms: sec * 1000 + usec / 1000,
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

    fn ev(etype: u16, code: u16, value: i32, time_ms: i64) -> RawEvent {
        RawEvent { etype, code, value, time_ms }
    }

    fn timed24(etype: u16, code: u16, value: i32, sec: i64, usec: i64) -> [u8; 24] {
        let mut b = encode_event24(etype, code, value);
        b[0..8].copy_from_slice(&sec.to_le_bytes());
        b[8..16].copy_from_slice(&usec.to_le_bytes());
        b
    }

    fn timed16(etype: u16, code: u16, value: i32, sec: i32, usec: i32) -> [u8; 16] {
        let mut b = [0u8; 16];
        b[0..4].copy_from_slice(&sec.to_le_bytes());
        b[4..8].copy_from_slice(&usec.to_le_bytes());
        b[8..10].copy_from_slice(&etype.to_le_bytes());
        b[10..12].copy_from_slice(&code.to_le_bytes());
        b[12..16].copy_from_slice(&value.to_le_bytes());
        b
    }

    #[test]
    fn parses_24_byte_events_across_chunk_boundaries() {
        let mut bytes = Vec::new();
        bytes.extend(timed24(EV_ABS, ABS_X, 1234, 1_790_000_000, 123_456));
        bytes.extend(encode_event24(EV_KEY, BTN_TOUCH, 1));
        bytes.extend(encode_event24(EV_SYN, SYN_REPORT, 0));
        let mut p = InputParser::with_size(24);
        let mut got = Vec::new();
        p.feed(&bytes[..10], |e| got.push(e)); // less than one event
        p.feed(&bytes[10..60], |e| got.push(e)); // ends half way through the third
        p.feed(&bytes[60..], |e| got.push(e));
        assert_eq!(
            got,
            vec![ev(EV_ABS, ABS_X, 1234, 1_790_000_000_123), ev(EV_KEY, BTN_TOUCH, 1, 0), ev(EV_SYN, SYN_REPORT, 0, 0)]
        );
    }

    #[test]
    fn parses_16_byte_events_even_in_48_byte_reads() {
        // Three 16-byte events are 48 bytes: the old size guess took them for two 24-byte ones.
        let mut bytes = Vec::new();
        bytes.extend(timed16(EV_ABS, ABS_X, 7, 100, 2_000));
        bytes.extend(timed16(EV_ABS, ABS_Y, -7, 100, 3_000));
        bytes.extend(timed16(EV_SYN, SYN_REPORT, 0, 100, 4_999));
        let mut p = InputParser::with_size(16);
        let mut got = Vec::new();
        p.feed(&bytes, |e| got.push(e));
        assert_eq!(got, vec![ev(EV_ABS, ABS_X, 7, 100_002), ev(EV_ABS, ABS_Y, -7, 100_003), ev(EV_SYN, SYN_REPORT, 0, 100_004)]);
    }

    #[test]
    fn size_follows_the_platform() {
        assert_eq!(EVENT_SIZE, if cfg!(target_pointer_width = "64") { 24 } else { 16 });
    }
}
