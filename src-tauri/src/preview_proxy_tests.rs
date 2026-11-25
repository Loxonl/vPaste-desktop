use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn fetch_transport_document(url: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(url).map_err(|_| "link_preview_blocked")?;
    let client = crate::clipboard::preview_http_client("vPaste-preview-test", 6, false)?;
    client.text(client.get(url, &[])?)
}

#[test]
fn system_proxy_probe() {
    let Ok(mode) = std::env::var("VPASTE_TEST_PREVIEW_PROXY_PROBE") else {
        return;
    };
    if mode == "live-system" {
        for url in ["https://github.com/", "https://vpaste.app/"] {
            let document = fetch_transport_document(url)
                .unwrap_or_else(|code| panic!("live preview failed: {code}"));
            assert!(!document.trim().is_empty());
            println!(
                "live preview succeeded: host={} bytes={}",
                reqwest::Url::parse(url).unwrap().host_str().unwrap(),
                document.len()
            );
        }
        return;
    }
    let result = fetch_transport_document(
        "https://preview-fixture.example/article?token=private-test-value",
    );
    assert!(
        result.is_err(),
        "fixture proxy must not return an HTML document"
    );
    assert_eq!(mode, "connect");
}

#[test]
fn link_preview_uses_configured_proxy_without_resolving_target_locally() {
    let request = proxy_fixture_request("127.0.0.1", false);
    assert!(request.starts_with("CONNECT preview-fixture.example:443 HTTP/1.1\r\n"));
    assert!(
        !request.contains("private-test-value"),
        "query parameters leaked into CONNECT"
    );
}

#[test]
fn link_preview_accepts_a_configured_localhost_proxy_and_its_authentication() {
    let request = proxy_fixture_request("localhost", true).to_ascii_lowercase();
    assert!(request.starts_with("connect preview-fixture.example:443 http/1.1\r\n"));
    assert!(request.contains("proxy-authorization: basic "));
    assert!(!request.contains("private-test-value"));
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn link_preview_offers_http2_and_http1_after_proxy_connect() {
    let hello = proxy_fixture_exchange("127.0.0.1", false, |stream, request| {
        assert!(request.starts_with(b"CONNECT preview-fixture.example:443 HTTP/1.1\r\n"));
        stream
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .unwrap();
        let mut header = [0; 5];
        stream.read_exact(&mut header).unwrap();
        assert_eq!(header[0], 22, "expected a TLS handshake record");
        let mut hello = vec![0; u16::from_be_bytes([header[3], header[4]]) as usize];
        stream.read_exact(&mut hello).unwrap();
        assert_eq!(hello.first(), Some(&1), "expected a TLS ClientHello");
        hello
    });

    // ALPN extension: two length-prefixed protocol IDs, preferred version first.
    let protocols = b"\x00\x10\x00\x0e\x00\x0c\x02h2\x08http/1.1";
    assert!(
        hello
            .windows(protocols.len())
            .any(|bytes| bytes == protocols),
        "link preview TLS must offer both HTTP/2 and HTTP/1.1 through CONNECT"
    );
}

fn read_proxy_headers(stream: &mut TcpStream) -> Vec<u8> {
    // Windows can inherit the listener's nonblocking mode on accepted sockets.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") && bytes.len() < 8192 {
        let mut chunk = [0; 1024];
        let length = stream.read(&mut chunk).unwrap();
        if length == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..length]);
    }
    bytes
}

#[test]
fn proxy_fixture_waits_for_delayed_and_fragmented_headers() {
    let request = b"CONNECT fixture.example:443 HTTP/1.1\r\nHost: fixture.example\r\n\r\n";
    for prefix_length in [0, 20] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_nonblocking(true).unwrap();
        client.write_all(&request[..prefix_length]).unwrap();
        let (started, ready) = mpsc::channel();
        let (sender, receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            started.send(()).unwrap();
            sender.send(read_proxy_headers(&mut stream)).unwrap();
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            matches!(
                receiver.recv_timeout(Duration::from_millis(100)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "fixture must wait for the complete request headers"
        );
        client.write_all(&request[prefix_length..]).unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
            request
        );
        server.join().unwrap();
    }
}

fn proxy_fixture_request(host: &str, authentication: bool) -> String {
    let bytes = proxy_fixture_exchange(host, authentication, |stream, request| {
        stream
            .write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        request
    });
    String::from_utf8_lossy(&bytes).into_owned()
}

fn proxy_fixture_exchange(
    host: &str,
    authentication: bool,
    respond: impl FnOnce(&mut TcpStream, Vec<u8>) -> Vec<u8> + Send + 'static,
) -> Vec<u8> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let bytes = read_proxy_headers(&mut stream);
                    sender.send(respond(&mut stream, bytes)).unwrap();
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("proxy fixture failed: {error}"),
            }
        }
    });
    let mut child = Command::new(std::env::current_exe().unwrap());
    child.args([
        "--exact",
        "preview_proxy_tests::system_proxy_probe",
        "--nocapture",
    ]);
    for name in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        let credentials = if authentication {
            "user:fixture-password@"
        } else {
            ""
        };
        child.env(
            name,
            format!("http://{credentials}{host}:{}", address.port()),
        );
    }
    child.env("NO_PROXY", "").env("no_proxy", "");
    child.env("VPASTE_TEST_PREVIEW_PROXY_PROBE", "connect");
    let output = child.output().unwrap();
    server.join().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    receiver
        .try_recv()
        .expect("link preview ignored the configured proxy: no CONNECT request received")
}
