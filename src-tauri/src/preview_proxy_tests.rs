use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[test]
fn system_proxy_probe() {
    let Ok(mode) = std::env::var("VPASTE_TEST_PREVIEW_PROXY_PROBE") else {
        return;
    };
    if mode == "live-system" {
        for url in ["https://github.com/", "https://vpaste.app/"] {
            let document =
                tauri::async_runtime::block_on(crate::fetch_link_preview_document(url.to_string()))
                    .unwrap_or_else(|code| panic!("live preview failed: {code}"));
            assert!(!document.html.trim().is_empty());
            println!(
                "live preview succeeded: host={} bytes={}",
                reqwest::Url::parse(&document.url)
                    .unwrap()
                    .host_str()
                    .unwrap(),
                document.html.len()
            );
        }
        return;
    }
    let result = tauri::async_runtime::block_on(crate::fetch_link_preview_document(
        "https://preview-fixture.example/article?token=private-test-value".to_string(),
    ));
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

fn proxy_fixture_request(host: &str, authentication: bool) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
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
                    sender
                        .send(String::from_utf8_lossy(&bytes).into_owned())
                        .unwrap();
                    stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
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
