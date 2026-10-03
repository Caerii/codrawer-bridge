//! The router's minimal HTTP layer: read a request head off a TCP stream, decode the path and
//! the few query values the router uses, answer plain requests, and hand the stream (with the
//! head replayed by [`Prefixed`]) to tungstenite for a WebSocket upgrade. Also [`bind`], which
//! listens the way Go's `net.Listen("tcp", ":port")` does.
//!
//! Deliberately not a general HTTP server: no keep-alive and no path cleaning (see the README).

use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

/// Largest request head accepted.
const MAX_HEADER: usize = 64 << 10;

/// What the router needs from a request head.
pub(super) struct Head {
    pub(super) path: String,
    pub(super) upgrade: bool,
    /// False when the query says `replay=0` (a pen source).
    pub(super) replay: bool,
    /// The `token` query value (first, decoded; empty if absent).
    pub(super) token: String,
    /// The first `Authorization` header's value, trimmed (empty if absent).
    pub(super) authorization: String,
}

/// Reads until the blank line that ends the request head (at most [`MAX_HEADER`] bytes). May
/// read past it; [`Prefixed`] gives those bytes back to the WebSocket layer.
pub(super) async fn read_head(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(buf);
        }
        if buf.len() > MAX_HEADER {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "header too large"));
        }
    }
}

/// Parses the request line and the headers the router uses; `None` for a malformed head.
pub(super) fn parse_head(head: &[u8]) -> Option<Head> {
    let end = head.windows(4).position(|w| w == b"\r\n\r\n")?;
    let text = std::str::from_utf8(&head[..end]).ok()?;
    let mut lines = text.split("\r\n");
    let mut parts = lines.next()?.split(' ');
    let (_method, target) = (parts.next()?, parts.next()?);
    let (raw_path, query) = target.split_once('?').unwrap_or((target, ""));
    let path = percent_decode(raw_path)?;
    let (mut upgrade, mut authorization) = (false, None);
    for (k, v) in lines.filter_map(|l| l.split_once(':')) {
        let (k, v) = (k.trim(), v.trim());
        if k.eq_ignore_ascii_case("upgrade") && v.eq_ignore_ascii_case("websocket") {
            upgrade = true;
        }
        if k.eq_ignore_ascii_case("authorization") && authorization.is_none() {
            authorization = Some(v.to_string());
        }
    }
    let replay = query_get(query, "replay").as_deref() != Some("0");
    let token = query_get(query, "token").unwrap_or_default();
    Some(Head { path, upgrade, replay, token, authorization: authorization.unwrap_or_default() })
}

/// The first value of `key` in a query string, decoded like Go's `url.Values.Get` (`+` is a
/// space; pairs that fail to decode are skipped).
fn query_get(query: &str, key: &str) -> Option<String> {
    let dec = |s: &str| percent_decode(&s.replace('+', " "));
    query.split('&').filter(|p| !p.is_empty()).find_map(|p| {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        (dec(k)? == key).then(|| dec(v)).flatten()
    })
}

/// Decodes `%XX` escapes; `None` for a bad escape or a result that is not UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Writes a complete plain HTTP response and closes the connection.
pub(super) async fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &str) -> io::Result<()> {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.shutdown().await
}

/// A TCP stream that first replays the request head already read from it.
pub struct Prefixed {
    pub(super) prefix: Vec<u8>,
    pub(super) pos: usize,
    pub(super) inner: TcpStream,
}

impl AsyncRead for Prefixed {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if self.pos < self.prefix.len() {
            let n = (self.prefix.len() - self.pos).min(buf.remaining());
            let start = self.pos;
            buf.put_slice(&self.prefix[start..start + n]);
            self.pos += n;
            if self.pos == self.prefix.len() {
                self.prefix = Vec::new();
                self.pos = 0;
            }
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for Prefixed {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
/// Binds `addr` the way Go's `net.Listen("tcp", addr)` does: `":8577"` means every interface,
/// IPv4 and IPv6 (falling back to IPv4 only where IPv6 is unavailable).
pub async fn bind(addr: &str) -> io::Result<TcpListener> {
    if let Some(port) = addr.strip_prefix(':') {
        let port: u16 = port.parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("listen tcp {addr}: invalid port")))?;
        // Dual-stack first; fall back to IPv4 where IPv6 is unavailable.
        if let Ok(l) = dual_stack(port) {
            return Ok(l);
        }
        return TcpListener::bind(("0.0.0.0", port)).await;
    }
    TcpListener::bind(addr).await
}

/// One IPv6 socket that also accepts IPv4 (as IPv4-mapped addresses).
fn dual_stack(port: u16) -> io::Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))?;
    s.set_only_v6(false)?;
    #[cfg(unix)]
    s.set_reuse_address(true)?;
    s.bind(&SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port)).into())?;
    s.listen(1024)?;
    s.set_nonblocking(true)?;
    TcpListener::from_std(s.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_request_heads() {
        let h = parse_head(b"GET /ws/session1?x=1 HTTP/1.1\r\nHost: a\r\nUpgrade: WebSocket\r\n\r\n").unwrap();
        assert_eq!(h.path, "/ws/session1");
        assert!(h.upgrade);
        let h = parse_head(b"GET /ws/my%20session HTTP/1.1\r\n\r\n").unwrap();
        assert_eq!(h.path, "/ws/my session");
        assert!(!h.upgrade);
        assert!(parse_head(b"GET / HTTP/1.1\r\n").is_none());
    }

    #[test]
    fn replay_query_matches_go_values_get() {
        let replay = |target: &str| parse_head(format!("GET {target} HTTP/1.1\r\n\r\n").as_bytes()).unwrap().replay;
        assert!(replay("/ws/s1"));
        assert!(!replay("/ws/s1?replay=0"));
        assert!(!replay("/ws/s1?a=1&replay=%30"));
        assert!(replay("/ws/s1?replay=1"));
        assert!(replay("/ws/s1?replay="));
        assert!(!replay("/ws/s1?replay=0&replay=1")); // the first value wins
        assert!(replay("/ws/s1?replays=0"));
    }

    #[test]
    fn parses_pairing_code_from_query_and_header() {
        let h = parse_head(b"GET /ws/s1?replay=0&token=K7Q2%2DM9TX HTTP/1.1\r\nauthorization:  Bearer abc \r\nAuthorization: Bearer second\r\n\r\n").unwrap();
        assert_eq!(h.token, "K7Q2-M9TX");
        assert_eq!(h.authorization, "Bearer abc");
        let h = parse_head(b"GET /ws/s1 HTTP/1.1\r\n\r\n").unwrap();
        assert!(h.token.is_empty() && h.authorization.is_empty());
    }
}
