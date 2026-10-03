//! The byte-level reader for v6 `.rm` files: little-endian scalars, varuints, CRDT ids, and the
//! tagged values every block body is made of.
//!
//! A tag is a varuint `index << 4 | type`. Types: [`TAG_ID`] (a CRDT id follows), [`TAG_LENGTH4`]
//! (a u32 length and a subblock follow), [`TAG_BYTE8`], [`TAG_BYTE4`], [`TAG_BYTE1`] (a scalar of
//! that size follows). The reader has a moving limit (`end`): the current block or subblock.
//! Reading past it is [`ReadError::Truncated`]; [`Reader::sub`] narrows the limit to a subblock
//! and afterwards skips whatever the closure left unread (fields added by newer firmware).

use super::CrdtId;

pub(super) const TAG_ID: u8 = 0xF;
pub(super) const TAG_LENGTH4: u8 = 0xC;
pub(super) const TAG_BYTE8: u8 = 0x8;
pub(super) const TAG_BYTE4: u8 = 0x4;
pub(super) const TAG_BYTE1: u8 = 0x1;

/// Why a read failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ReadError {
    /// The data ends (or the current block ends) before the value does.
    Truncated,
    /// The bytes are there but do not have the expected shape.
    Malformed(String),
}

pub(super) type ReadResult<T> = Result<T, ReadError>;

/// A cursor over the whole file with a limit for the current block or subblock.
pub(super) struct Reader<'a> {
    pub(super) b: &'a [u8],
    pub(super) pos: usize,
    /// The current block or subblock ends here; reads never go past it.
    pub(super) end: usize,
}

impl<'a> Reader<'a> {
    pub(super) fn new(b: &'a [u8], pos: usize) -> Self {
        Reader { b, pos, end: b.len() }
    }

    /// Bytes left before the current limit.
    pub(super) fn remaining(&self) -> usize {
        self.end.saturating_sub(self.pos)
    }

    /// Fails unless `n` more bytes are available before the limit.
    pub(super) fn need(&self, n: usize) -> ReadResult<()> {
        match self.pos.checked_add(n) {
            Some(stop) if stop <= self.end => Ok(()),
            _ => Err(ReadError::Truncated),
        }
    }

    /// Takes the next `n` bytes.
    pub(super) fn bytes(&mut self, n: usize) -> ReadResult<&'a [u8]> {
        self.need(n)?;
        let out = &self.b[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    fn array<const N: usize>(&mut self) -> ReadResult<[u8; N]> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.bytes(N)?);
        Ok(out)
    }

    pub(super) fn u8(&mut self) -> ReadResult<u8> {
        Ok(self.array::<1>()?[0])
    }

    pub(super) fn u16(&mut self) -> ReadResult<u16> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    pub(super) fn u32(&mut self) -> ReadResult<u32> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    pub(super) fn f32(&mut self) -> ReadResult<f32> {
        Ok(f32::from_le_bytes(self.array()?))
    }

    pub(super) fn f64(&mut self) -> ReadResult<f64> {
        Ok(f64::from_le_bytes(self.array()?))
    }

    /// An unsigned LEB128 value of at most 64 bits.
    pub(super) fn varuint(&mut self) -> ReadResult<u64> {
        let mut value = 0u64;
        let mut shift = 0;
        while shift < 64 {
            let c = self.u8()?;
            value |= u64::from(c & 0x7f) << shift;
            if c & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
        }
        Err(ReadError::Malformed("varuint overflow".into()))
    }

    /// A CRDT id: a u8 author, then a varuint counter.
    pub(super) fn crdt(&mut self) -> ReadResult<CrdtId> {
        let author = self.u8()?;
        let counter = self.varuint()?;
        Ok(CrdtId { author, counter })
    }

    /// Whether the next tag is `(index, typ)`, without consuming anything.
    pub(super) fn peek_tag(&mut self, index: u64, typ: u8) -> bool {
        if self.pos >= self.end {
            return false;
        }
        let save = self.pos;
        let matches = matches!(self.varuint(), Ok(x) if is_tag(x, index, typ));
        self.pos = save;
        matches
    }

    /// Consumes the tag `(index, typ)`; on a different tag nothing is consumed.
    pub(super) fn tag(&mut self, index: u64, typ: u8) -> ReadResult<()> {
        let save = self.pos;
        let x = self.varuint()?;
        if is_tag(x, index, typ) {
            return Ok(());
        }
        self.pos = save;
        Err(ReadError::Malformed(format!(
            "unexpected tag: want {index}/{typ:#x}, got {}/{:#x} at {save}",
            x >> 4,
            x & 0xF
        )))
    }

    /// A tagged CRDT id.
    pub(super) fn id(&mut self, index: u64) -> ReadResult<CrdtId> {
        self.tag(index, TAG_ID)?;
        self.crdt()
    }

    /// A tagged u32.
    pub(super) fn t_int(&mut self, index: u64) -> ReadResult<u32> {
        self.tag(index, TAG_BYTE4)?;
        self.u32()
    }

    /// A tagged f32.
    pub(super) fn t_float(&mut self, index: u64) -> ReadResult<f32> {
        self.tag(index, TAG_BYTE4)?;
        self.f32()
    }

    /// A tagged f64.
    pub(super) fn t_double(&mut self, index: u64) -> ReadResult<f64> {
        self.tag(index, TAG_BYTE8)?;
        self.f64()
    }

    /// A tagged bool (one byte, non-zero is true).
    pub(super) fn t_bool(&mut self, index: u64) -> ReadResult<bool> {
        self.tag(index, TAG_BYTE1)?;
        Ok(self.u8()? != 0)
    }

    /// Whether a subblock with this index comes next.
    pub(super) fn has_sub(&mut self, index: u64) -> bool {
        self.peek_tag(index, TAG_LENGTH4)
    }

    /// Reads a subblock header, runs `read` with the limit set to the subblock, then moves to
    /// the subblock's end (skipping fields `read` did not know) and restores the outer limit.
    pub(super) fn sub<T>(&mut self, index: u64, read: impl FnOnce(&mut Self) -> ReadResult<T>) -> ReadResult<T> {
        self.tag(index, TAG_LENGTH4)?;
        let len = self.u32()? as usize;
        self.need(len)?;
        let (outer_end, sub_end) = (self.end, self.pos + len);
        self.end = sub_end;
        let result = read(self);
        self.pos = sub_end;
        self.end = outer_end;
        result
    }
}

fn is_tag(x: u64, index: u64, typ: u8) -> bool {
    x >> 4 == index && (x & 0xF) as u8 == typ
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varuints_and_ids() {
        let data = [0xAC, 0x02, 0x05, 0x81, 0x01];
        let mut r = Reader::new(&data, 0);
        assert_eq!(r.varuint(), Ok(300));
        assert_eq!(r.crdt(), Ok(CrdtId { author: 5, counter: 129 }));
        assert_eq!(r.u8(), Err(ReadError::Truncated));
        let overflow = [0xFF; 11];
        assert!(matches!(Reader::new(&overflow, 0).varuint(), Err(ReadError::Malformed(_))));
    }

    #[test]
    fn tags_are_checked_without_consuming_on_mismatch() {
        // tag 1/byte4, then 7
        let data = [0x14, 7, 0, 0, 0];
        let mut r = Reader::new(&data, 0);
        assert!(r.peek_tag(1, TAG_BYTE4));
        assert!(!r.peek_tag(2, TAG_BYTE4));
        assert_eq!(r.pos, 0, "peeking consumed bytes");
        assert!(r.t_double(1).is_err());
        assert_eq!(r.pos, 0, "a wrong tag consumed bytes");
        assert_eq!(r.t_int(1), Ok(7));
    }

    #[test]
    fn subblocks_skip_unread_fields_and_restore_the_limit() {
        // subblock 2 of 6 bytes: a byte1 field (index 1) and 3 bytes of a newer field; then 0x99
        let data = [0x2C, 6, 0, 0, 0, 0x11, 1, 0xAA, 0xBB, 0xCC, 0xDD, 0x99];
        let mut r = Reader::new(&data, 0);
        let v = r.sub(2, |r| r.t_bool(1)).unwrap();
        assert!(v);
        assert_eq!(r.u8(), Ok(0x99));
        // a subblock longer than the data is truncated
        let short = [0x2C, 60, 0, 0, 0, 1];
        assert_eq!(Reader::new(&short, 0).sub(2, |r| r.u8()), Err(ReadError::Truncated));
        // reads inside a subblock stop at its end
        let data = [0x2C, 1, 0, 0, 0, 1, 2, 3];
        assert_eq!(Reader::new(&data, 0).sub(2, |r| r.u16()), Err(ReadError::Truncated));
    }
}
