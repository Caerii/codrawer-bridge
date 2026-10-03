//! Ports of bridge/remarkable/native/router/router_test.go, run against a real listener.

use std::time::Duration;

use codrawer_bridge::router::{Router, DOC_COMPACT_AT};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

type Ws = WebSocketStream<TcpStream>;

async fn new_server() -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap().to_string();
    tokio::spawn(Router::quiet().serve(l));
    addr
}

/// Connects to `ws://{addr}{path}` without reading anything.
async fn dial_path(addr: &str, path: &str) -> Ws {
    let stream = TcpStream::connect(addr).await.unwrap();
    let (ws, _) = tokio_tungstenite::client_async(format!("ws://{addr}{path}"), stream).await.expect("dial");
    ws
}

async fn dial(addr: &str, session: &str) -> Ws {
    let mut ws = dial_path(addr, &format!("/ws/{session}")).await;
    let m = read(&mut ws).await;
    assert!(m["t"] == "hello" && m["session"] == session, "want hello for {session}, got {m}");
    ws
}

async fn send(ws: &mut Ws, msg: &str) {
    ws.send(Message::text(msg)).await.expect("write");
}

async fn read(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .expect("read: timeout")
            .expect("read: closed")
            .expect("read: error");
        if let Message::Text(t) = msg {
            return serde_json::from_str(t.as_str()).unwrap_or_else(|e| panic!("bad json {t}: {e}"));
        }
    }
}

/// Asserts nothing (but control frames) arrives within `d`.
async fn expect_quiet(ws: &mut Ws, d: Duration) {
    let deadline = tokio::time::Instant::now() + d;
    loop {
        match tokio::time::timeout_at(deadline, ws.next()).await {
            Err(_) => return,
            Ok(Some(Ok(Message::Text(t)))) => panic!("expected nothing, got {t}"),
            Ok(Some(Ok(_))) => continue,
            Ok(other) => panic!("connection ended: {other:?}"),
        }
    }
}

#[tokio::test]
async fn relays_to_others_not_sender() {
    let srv = new_server().await;
    let mut tablet = dial(&srv, "s1").await;
    let mut glasses = dial(&srv, "s1").await;
    let mut other = dial(&srv, "s2").await;

    send(&mut tablet, r#"{"t":"stroke_begin","id":"u_1","layer":"user","brush":"pen","ts":1}"#).await;
    send(&mut tablet, r#"{"t":"stroke_pts","id":"u_1","pts":[[0.1,0.2,0.5,2],[0.11,0.21,0.5,3]]}"#).await;
    send(&mut tablet, r#"{"t":"key","key":"a","char":"a"}"#).await;

    let m = read(&mut glasses).await;
    assert!(m["t"] == "stroke_begin" && m["brush"] == "pen", "begin: {m}");
    let m = read(&mut glasses).await;
    assert!(m["t"] == "stroke_pts" && m["pts"].as_array().unwrap().len() == 2, "pts: {m}");
    let m = read(&mut glasses).await;
    assert!(m["t"] == "key" && m["char"] == "a", "key: {m}");
    expect_quiet(&mut tablet, Duration::from_millis(150)).await;
    expect_quiet(&mut other, Duration::from_millis(150)).await;
}

#[tokio::test]
async fn late_joiner_gets_page_replay() {
    let srv = new_server().await;
    let mut tablet = dial(&srv, "s1").await;
    let mut watcher = dial(&srv, "s1").await; // a live client: tells us the router processed the strokes

    send(&mut tablet, r#"{"t":"stroke_begin","id":"u_1","brush":"pen"}"#).await;
    let pts = vec!["[0.5,0.5,0.5,1]"; 300].join(","); // more than one replay chunk
    send(&mut tablet, &format!(r#"{{"t":"stroke_pts","id":"u_1","pts":[{pts}]}}"#)).await;
    send(&mut tablet, r#"{"t":"stroke_end","id":"u_1"}"#).await;
    send(&mut tablet, r#"{"t":"stroke_begin","id":"u_2","brush":"pen"}"#).await; // still being drawn
    for _ in 0..4 {
        read(&mut watcher).await;
    }

    let mut late = dial(&srv, "s1").await;
    let mut got = Vec::new();
    let mut n = 0;
    for _ in 0..5 {
        let m = read(&mut late).await;
        got.push(format!("{}:{}", m["t"].as_str().unwrap(), m["id"].as_str().unwrap()));
        if m["t"] == "stroke_pts" {
            n += m["pts"].as_array().unwrap().len();
        }
    }
    let want = "stroke_begin:u_1 stroke_pts:u_1 stroke_pts:u_1 stroke_end:u_1 stroke_begin:u_2";
    assert_eq!(got.join(" "), want, "replay order");
    assert_eq!(n, 300, "replayed points");

    // The open stroke keeps streaming to the late joiner.
    send(&mut tablet, r#"{"t":"stroke_pts","id":"u_2","pts":[[0.2,0.2,0.4,9]]}"#).await;
    let m = read(&mut late).await;
    assert!(m["t"] == "stroke_pts" && m["id"] == "u_2", "live after replay: {m}");
}

#[tokio::test]
async fn clear_wipes_replay() {
    let srv = new_server().await;
    let mut tablet = dial(&srv, "s1").await;
    let mut glasses = dial(&srv, "s1").await;

    send(&mut tablet, r#"{"t":"stroke_begin","id":"u_1"}"#).await;
    send(&mut tablet, r#"{"t":"stroke_end","id":"u_1"}"#).await;
    read(&mut glasses).await;
    read(&mut glasses).await;
    send(&mut glasses, r#"{"t":"clear","ts":5}"#).await;
    let m = read(&mut tablet).await;
    assert_eq!(m["t"], "clear", "clear not relayed: {m}");

    let mut late = dial(&srv, "s1").await;
    expect_quiet(&mut late, Duration::from_millis(150)).await;
}

#[tokio::test]
async fn term_gets_status_and_ai_is_dropped() {
    let srv = new_server().await;
    let mut app = dial(&srv, "s1").await;
    let mut tablet = dial(&srv, "s1").await;

    send(&mut app, r#"{"t":"prompt","text":"draw a cat","mode":"draw"}"#).await;
    send(&mut app, r#"{"t":"term_prompt","text":"hi"}"#).await;
    let m = read(&mut app).await;
    assert!(m["t"] == "term" && m["kind"] == "status", "term status: {m}");
    expect_quiet(&mut tablet, Duration::from_millis(150)).await;
}

#[tokio::test]
async fn doc_updates_relay_replay_and_compact() {
    let srv = new_server().await;
    let mut a = dial(&srv, "s1").await;
    let mut b = dial(&srv, "s1").await;

    // Relay to the others, not back to the sender.
    send(&mut a, r#"{"t":"doc_update","u":"AAA="}"#).await;
    let m = read(&mut b).await;
    assert!(m["t"] == "doc_update" && m["u"] == "AAA=", "relay: {m}");

    // Grow the log past DOC_COMPACT_AT: the writer is asked for a snapshot exactly once.
    for _ in 0..DOC_COMPACT_AT {
        send(&mut a, r#"{"t":"doc_update","u":"BBB="}"#).await;
        read(&mut b).await;
    }
    let m = read(&mut a).await;
    assert_eq!(m["t"], "doc_compact", "want doc_compact, got {m}");
    send(&mut b, r#"{"t":"doc_update","u":"LATE"}"#).await; // arrives after the request; must survive
    let m = read(&mut a).await;
    assert_eq!(m["u"], "LATE", "late relay: {m}");
    send(&mut a, r#"{"t":"doc_state","u":"SNAP"}"#).await;
    send(&mut a, r#"{"t":"doc_update","u":"AFTER"}"#).await;
    let m = read(&mut b).await;
    assert_eq!(m["u"], "AFTER", "after relay: {m}");

    // A joiner gets the compacted log: snapshot, then what came after the request.
    let mut c = dial(&srv, "s1").await;
    let m = read(&mut c).await;
    let got: Vec<&str> = m["us"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    assert!(m["t"] == "doc_update" && got.join(",") == "SNAP,LATE,AFTER", "replay after compaction: {m}");
    expect_quiet(&mut a, Duration::from_millis(100)).await; // never echoed its own updates, asked only once
}

#[tokio::test]
async fn doc_survives_clear() {
    let srv = new_server().await;
    let mut a = dial(&srv, "s1").await;
    let mut b = dial(&srv, "s1").await;
    send(&mut a, r#"{"t":"doc_update","u":"AAA="}"#).await;
    read(&mut b).await;
    send(&mut a, r#"{"t":"clear"}"#).await;
    read(&mut b).await;
    let mut c = dial(&srv, "s1").await;
    let m = read(&mut c).await;
    assert_eq!(m["t"], "doc_update", "doc lost on clear: {m}");
}

#[tokio::test]
async fn healthz_and_bad_paths() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let srv = new_server().await;
    for (req, want) in [
        ("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n", "200 OK"),
        ("GET /nope HTTP/1.1\r\nHost: x\r\n\r\n", "404 Not Found"),
        ("GET /ws/ HTTP/1.1\r\nHost: x\r\n\r\n", "404 Not Found"),
        ("GET /ws/s1 HTTP/1.1\r\nHost: x\r\n\r\n", "400 Bad Request"),
    ] {
        let mut s = TcpStream::connect(&srv).await.unwrap();
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with(&format!("HTTP/1.1 {want}")), "{req:?} -> {out}");
        if want == "200 OK" {
            assert!(out.ends_with(r#"{"ok":true}"#));
        }
    }
}

#[tokio::test]
async fn stalled_client_is_dropped_not_blocking() {
    // A client that never reads must not stall the sender or other clients.
    let srv = new_server().await;
    let mut tablet = dial(&srv, "s1").await;
    let _stalled = dial(&srv, "s1").await; // never read
    let mut glasses = dial(&srv, "s1").await;
    let big = format!(r#"{{"t":"cursor","pad":"{}"}}"#, "x".repeat(16 << 10));
    // 48 MB in batches of 500 (inside the 1024-message queue for the client that keeps up).
    for _ in 0..6 {
        for _ in 0..500 {
            send(&mut tablet, &big).await;
        }
        for _ in 0..500 {
            assert_eq!(read(&mut glasses).await["t"], "cursor");
        }
    }
    send(&mut tablet, r#"{"t":"key","key":"z"}"#).await;
    assert_eq!(read(&mut glasses).await["key"], "z");
}

fn stroke_id(i: usize) -> String {
    format!("u_{}{}", (b'a' + (i % 26) as u8) as char, "x".repeat(i / 26))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn big_page_replay_does_not_drop_joiner() {
    let srv = new_server().await;
    let mut tablet = dial(&srv, "s1").await;
    let mut watcher = dial(&srv, "s1").await;
    const STROKES: usize = 600; // 1800 replay messages, well past SEND_QUEUE
    // The watcher drains while the tablet sends, like a live client; it also tells us when the
    // router has processed everything. The tablet waits for it every 100 strokes so a slow CI
    // machine never lets the watcher's backlog reach the stalled-client limit.
    let seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen_w = seen.clone();
    let drained = tokio::spawn(async move {
        for _ in 0..STROKES * 3 {
            read(&mut watcher).await;
            seen_w.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        watcher
    });
    for i in 0..STROKES {
        let id = stroke_id(i);
        send(&mut tablet, &format!(r#"{{"t":"stroke_begin","id":"{id}"}}"#)).await;
        send(&mut tablet, &format!(r#"{{"t":"stroke_pts","id":"{id}","pts":[[0.5,0.5,0.5,1]]}}"#)).await;
        send(&mut tablet, &format!(r#"{{"t":"stroke_end","id":"{id}"}}"#)).await;
        if (i + 1) % 100 == 0 {
            while seen.load(std::sync::atomic::Ordering::SeqCst) < (i + 1) * 3 {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        }
    }
    let _watcher = drained.await.expect("watcher");
    let mut late = dial(&srv, "s1").await;
    for i in 0..STROKES * 3 {
        let m = read(&mut late).await;
        assert!(m["t"].is_string(), "replay message {i}: {m}");
    }
}

#[tokio::test]
async fn hello_says_replay_and_source_can_skip_it() {
    let srv = new_server().await;
    let mut tablet = dial(&srv, "s1").await;
    let mut watcher = dial(&srv, "s1").await;
    send(&mut tablet, r#"{"t":"stroke_begin","id":"u_1"}"#).await;
    send(&mut tablet, r#"{"t":"stroke_end","id":"u_1"}"#).await;
    read(&mut watcher).await;
    read(&mut watcher).await;

    let mut src = dial_path(&srv, "/ws/s1?replay=0").await;
    let m = read(&mut src).await;
    assert!(m["t"] == "hello" && m["replay"] == false, "hello for a source: {m}");

    let mut v = dial_path(&srv, "/ws/s1").await;
    let m = read(&mut v).await;
    assert_eq!(m["replay"], true, "hello for a viewer: {m}");
    let m = read(&mut v).await;
    assert_eq!(m["t"], "stroke_begin", "viewer replay: {m}");
    expect_quiet(&mut src, Duration::from_millis(150)).await; // the pen source got no page replay
}

#[tokio::test]
async fn leaving_mid_stroke_ends_it_for_everyone() {
    let srv = new_server().await;
    let mut tablet = dial(&srv, "s1").await;
    let mut glasses = dial(&srv, "s1").await;
    send(&mut tablet, r#"{"t":"stroke_begin","id":"u_1"}"#).await;
    read(&mut glasses).await;
    drop(tablet); // the bridge's socket dies mid-stroke
    let m = read(&mut glasses).await;
    assert!(m["t"] == "stroke_end" && m["id"] == "u_1", "want synthetic stroke_end, got {m}");
    let mut late = dial(&srv, "s1").await;
    read(&mut late).await; // stroke_begin
    let m = read(&mut late).await;
    assert_eq!(m["t"], "stroke_end", "replayed stroke still open: {m}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_messages_during_replay_keep_order() {
    let srv = new_server().await;
    let mut tablet = dial(&srv, "s1").await;
    let mut watcher = dial(&srv, "s1").await;
    const PAGE: usize = 400;
    for i in 0..PAGE {
        send(&mut tablet, &format!(r#"{{"t":"stroke_begin","id":"u_{i}"}}"#)).await;
        send(&mut tablet, &format!(r#"{{"t":"stroke_end","id":"u_{i}"}}"#)).await;
    }
    for _ in 0..PAGE * 2 {
        read(&mut watcher).await;
    }
    // Join while the tablet keeps drawing: nothing replayed may arrive after a live message.
    const LIVE: usize = 50;
    let writer = tokio::spawn(async move {
        for i in 0..LIVE {
            send(&mut tablet, &format!(r#"{{"t":"stroke_begin","id":"live_{i}"}}"#)).await;
        }
        tablet
    });
    let mut late = dial(&srv, "s1").await;
    let _tablet = writer.await.expect("writer");
    let (mut n_live, mut n_replayed) = (0, 0);
    for _ in 0..PAGE * 2 + LIVE {
        let m = read(&mut late).await;
        let id = m["id"].as_str().unwrap();
        if id.starts_with("live_") {
            n_live += 1;
            continue;
        }
        assert_eq!(n_live, 0, "replayed {id} after a live message");
        n_replayed += 1;
    }
    assert_eq!((n_replayed, n_live), (PAGE * 2, LIVE));
}
