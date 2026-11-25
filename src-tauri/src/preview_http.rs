use std::collections::HashMap;
use std::error::Error as _;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use hyper_util::client::proxy::matcher::{Intercept, Matcher};
use reqwest::blocking::{Client, ClientBuilder, Response};
use reqwest::cookie::Jar;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, LOCATION, REFERER, RETRY_AFTER};
use reqwest::{StatusCode, Url};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const DEFAULT_RATE_LIMIT_DELAY: Duration = Duration::from_secs(60);
const RATE_LIMITED: &str = "link_preview_rate_limited";
static RATE_LIMITS: LazyLock<Mutex<HashMap<String, HostCooldown>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy)]
struct HostCooldown {
    started: Instant,
    delay: Duration,
}

impl HostCooldown {
    fn remaining(self, now: Instant) -> Duration {
        self.delay
            .saturating_sub(now.saturating_duration_since(self.started))
    }

    fn retry_at(self) -> Option<Instant> {
        self.started.checked_add(self.delay)
    }
}

#[derive(Debug)]
pub(crate) enum PreviewHttpError {
    RateLimited(Option<Instant>),
    Failed(String),
}

impl From<String> for PreviewHttpError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

impl From<&str> for PreviewHttpError {
    fn from(error: &str) -> Self {
        Self::Failed(error.into())
    }
}

impl From<PreviewHttpError> for String {
    fn from(error: PreviewHttpError) -> Self {
        match error {
            PreviewHttpError::RateLimited(_) => RATE_LIMITED.into(),
            PreviewHttpError::Failed(error) => error,
        }
    }
}

fn rate_limit_delay(header: Option<&HeaderValue>, now: chrono::DateTime<chrono::Utc>) -> Duration {
    header
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .and_then(|value| {
            if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
                value.parse::<u64>().ok().map(Duration::from_secs)
            } else {
                chrono::DateTime::parse_from_rfc2822(value)
                    .ok()
                    .and_then(|date| date.signed_duration_since(now).to_std().ok())
            }
        })
        .unwrap_or(DEFAULT_RATE_LIMIT_DELAY)
        .max(Duration::from_secs(1))
}

fn active_host_cooldown(host: &str, now: Instant) -> Option<HostCooldown> {
    let mut limits = RATE_LIMITS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let active = limits
        .get(host)
        .copied()
        .filter(|cooldown| !cooldown.remaining(now).is_zero());
    if active.is_none() {
        limits.remove(host);
    }
    active
}

fn defer_host(host: &str, delay: Duration, now: Instant) -> HostCooldown {
    let mut limits = RATE_LIMITS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    limits.retain(|_, cooldown| !cooldown.remaining(now).is_zero());
    let next = HostCooldown {
        started: now,
        delay,
    };
    let cooldown = limits.entry(host.to_owned()).or_insert(next);
    if cooldown
        .retry_at()
        .is_some_and(|previous| next.retry_at().is_none_or(|next| next > previous))
    {
        *cooldown = next;
    }
    *cooldown
}

pub(crate) fn is_previewable_domain_link(url: &str) -> bool {
    let parsed = match reqwest::Url::parse(url.trim()) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    if parsed.scheme() != "https" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    let host = host.trim_end_matches('.');
    if ["localhost", "local", "internal", "test", "invalid"]
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return false;
    }
    host.contains('.')
        && host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
}

pub(crate) struct PreviewHttpClient {
    direct: Client,
    proxies: Matcher,
    proxy_client: OnceLock<Result<Client, String>>,
    cookie_jar: Option<Arc<Jar>>,
    user_agent: String,
    max_redirects: usize,
}

pub(crate) fn preview_http_client(
    user_agent: &str,
    max_redirects: usize,
    cookie_store: bool,
) -> Result<PreviewHttpClient, String> {
    PreviewHttpClient::new(
        user_agent,
        max_redirects,
        cookie_store,
        Matcher::from_system(),
    )
}

impl PreviewHttpClient {
    fn new(
        user_agent: &str,
        max_redirects: usize,
        cookie_store: bool,
        proxies: Matcher,
    ) -> Result<Self, String> {
        let cookie_jar = cookie_store.then(|| Arc::new(Jar::default()));
        // Validate URL hosts, but leave DNS answers (including TUN/Fake-IP) to the network stack.
        let direct = Self::builder(user_agent, &cookie_jar)
            .build()
            .map_err(|_| "link_preview_network".to_string())?;
        Ok(Self {
            direct,
            proxies,
            proxy_client: OnceLock::new(),
            cookie_jar,
            user_agent: user_agent.to_string(),
            max_redirects,
        })
    }

    fn builder(user_agent: &str, cookie_jar: &Option<Arc<Jar>>) -> ClientBuilder {
        let builder = Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .user_agent(user_agent);
        match cookie_jar {
            Some(jar) => builder.cookie_provider(jar.clone()),
            None => builder,
        }
    }

    fn proxy_for(&self, url: &Url) -> Option<Intercept> {
        self.proxies.intercept(&url.as_str().parse().ok()?)
    }

    fn client_for(&self, proxy: Option<Intercept>) -> Result<&Client, String> {
        let Some(proxy) = proxy else {
            return Ok(&self.direct);
        };
        if !matches!(proxy.uri().scheme_str(), Some("http" | "https")) {
            log::info!("link preview proxy unavailable: cause=unsupported proxy transport");
            return Err("link_preview_proxy_unavailable".to_string());
        }
        // The system matcher has one fixed HTTPS proxy; bypass rules only select direct.
        self.proxy_client
            .get_or_init(|| {
                let mut proxy_config = reqwest::Proxy::all(proxy.uri().to_string())
                    .map_err(|_| "link_preview_proxy_unavailable".to_string())?;
                if let Some(auth) = proxy.basic_auth() {
                    proxy_config = proxy_config.custom_http_auth(auth.clone());
                }
                // Only the explicitly configured proxy resolves the destination. Its own
                // endpoint may legitimately resolve to loopback or a private address.
                Self::builder(&self.user_agent, &self.cookie_jar)
                    .proxy(proxy_config)
                    .build()
                    .map_err(|_| "link_preview_proxy_unavailable".to_string())
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    pub(crate) fn get(
        &self,
        mut url: Url,
        headers: &[(HeaderName, &str)],
    ) -> Result<Response, PreviewHttpError> {
        let mut headers: HeaderMap = headers
            .iter()
            .map(|(name, value)| HeaderValue::from_str(value).map(|value| (name.clone(), value)))
            .collect::<Result<_, _>>()
            .map_err(|_| "link_preview_network".to_string())?;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        for previous_urls in 1..=self.max_redirects.max(1) {
            if !is_previewable_domain_link(url.as_str()) {
                return Err("link_preview_blocked".into());
            }
            let host = url.host_str().unwrap_or_default().trim_end_matches('.');
            if let Some(cooldown) = active_host_cooldown(host, Instant::now()) {
                return Err(PreviewHttpError::RateLimited(cooldown.retry_at()));
            }
            let proxy = self.proxy_for(&url);
            let via_proxy = proxy.is_some();
            let client = self.client_for(proxy)?;
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| "link_preview_timeout".to_string())?;
            let response = client
                .get(url.clone())
                .headers(headers.clone())
                .timeout(remaining)
                .send()
                .map_err(|error| request_error(&url, "request", via_proxy, error))?;
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                let delay =
                    rate_limit_delay(response.headers().get(RETRY_AFTER), chrono::Utc::now());
                let cooldown = defer_host(host, delay, Instant::now());
                log::info!(
                    "link preview failed: host={host} stage=request route={} kind={RATE_LIMITED} status=Some(429) retry_after_secs={}",
                    if via_proxy { "proxy" } else { "direct" },
                    delay.as_secs()
                );
                return Err(PreviewHttpError::RateLimited(cooldown.retry_at()));
            }
            let response = response
                .error_for_status()
                .map_err(|error| request_error(&url, "request", via_proxy, error))?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            let Some(location) = response.headers().get(LOCATION) else {
                return Ok(response);
            };
            if previous_urls >= self.max_redirects {
                return Err("link_preview_redirect_limit".into());
            }
            let next = next_destination(
                &url,
                location
                    .to_str()
                    .map_err(|_| "link_preview_blocked".to_string())?,
            )?;
            if url.origin() != next.origin() {
                headers.remove(reqwest::header::AUTHORIZATION);
                headers.remove(reqwest::header::COOKIE);
            }
            let mut referer = url.clone();
            let _ = referer.set_username("");
            let _ = referer.set_password(None);
            referer.set_fragment(None);
            if let Ok(value) = HeaderValue::from_str(referer.as_str()) {
                headers.insert(REFERER, value);
            }
            url = next;
        }
        Err("link_preview_redirect_limit".into())
    }

    pub(crate) fn text(&self, response: Response) -> Result<String, String> {
        let url = response.url().clone();
        let via_proxy = self.proxy_for(&url).is_some();
        response
            .text()
            .map_err(|error| request_error(&url, "body", via_proxy, error))
    }
}

fn next_destination(url: &Url, location: &str) -> Result<Url, String> {
    url.join(location)
        .ok()
        .filter(|next| is_previewable_domain_link(next.as_str()))
        .ok_or_else(|| "link_preview_blocked".to_string())
}

fn request_error(url: &Url, stage: &str, via_proxy: bool, error: reqwest::Error) -> String {
    let code = if error.is_timeout() {
        "link_preview_timeout"
    } else if error.status().is_some() {
        "link_preview_http_status"
    } else if via_proxy {
        "link_preview_proxy_unavailable"
    } else {
        "link_preview_network"
    };
    let status = error.status();
    let error = error.without_url();
    let mut details = vec![diagnostic_detail(&error.to_string())];
    let mut source = error.source();
    for _ in 0..5 {
        let Some(cause) = source else { break };
        details.push(diagnostic_detail(&cause.to_string()));
        source = cause.source();
    }
    // Do not log the requested URL, credentials, query parameters, or response body.
    log::info!(
        "link preview failed: host={} stage={} route={} kind={} status={:?} cause={}",
        url.host_str().unwrap_or(""),
        stage,
        if via_proxy { "proxy" } else { "direct" },
        code,
        status,
        details.join(" -> ")
    );
    code.to_string()
}

fn diagnostic_detail(detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    if detail.contains("://")
        || [
            "authorization",
            "basic ",
            "bearer ",
            "password",
            "credential",
        ]
        .iter()
        .any(|value| lower.contains(value))
    {
        return "[redacted network detail]".to_string();
    }
    detail
        .chars()
        .filter(|ch| !ch.is_control())
        .take(256)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_retry_after_accepts_seconds_and_http_date() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .to_utc();
        for (value, seconds) in [
            ("17", 17),
            ("Thu, 01 Jan 2026 00:01:30 GMT", 90),
            ("Wed, 31 Dec 2025 23:59:59 GMT", 60),
            ("0", 1),
            ("not a date", 60),
        ] {
            assert_eq!(
                rate_limit_delay(Some(&HeaderValue::from_static(value)), now),
                Duration::from_secs(seconds)
            );
        }
        assert_eq!(rate_limit_delay(None, now), DEFAULT_RATE_LIMIT_DELAY);
    }

    #[test]
    fn preview_rate_limit_is_shared_by_hostname_and_expires() {
        let now = Instant::now();
        let host = "paused-preview.example";
        defer_host(host, Duration::from_secs(30), now);
        defer_host(host, Duration::from_secs(2), now + Duration::from_secs(5));
        assert_eq!(
            active_host_cooldown(host, now + Duration::from_secs(29))
                .map(|cooldown| cooldown.remaining(now + Duration::from_secs(29))),
            Some(Duration::from_secs(1))
        );
        assert!(active_host_cooldown("another-preview.example", now).is_none());

        // Unsupported proxy scheme fails locally if the cooldown fails to stop this request.
        let transport = client(Matcher::builder().https("socks5://127.0.0.1:1").build());
        assert!(matches!(
            transport.get(
                Url::parse("https://paused-preview.example./favicon.ico").unwrap(),
                &[]
            ),
            Err(PreviewHttpError::RateLimited(Some(retry_at)))
                if retry_at == now + Duration::from_secs(30)
        ));
        assert!(active_host_cooldown(host, now + Duration::from_secs(30)).is_none());
    }

    #[test]
    fn direct_requests_delegate_dns_to_the_http_clients_default_resolver() {
        let production = include_str!("preview_http.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(
            !production.contains(".dns_resolver("),
            "the shared preview client must not install a destination-IP filtering resolver"
        );
    }

    fn client(proxies: Matcher) -> PreviewHttpClient {
        PreviewHttpClient::new("vPaste-preview-test", 2, true, proxies).unwrap()
    }

    #[test]
    fn transport_diagnostics_keep_causes_but_remove_urls_credentials_and_log_injection() {
        for detail in [
            "request to https://user:secret@example.com/path?token=secret failed",
            "Proxy-Authorization: Basic fixture-secret",
            "Bearer fixture-secret",
            "invalid proxy password: fixture-secret",
        ] {
            assert_eq!(diagnostic_detail(detail), "[redacted network detail]");
        }
        assert_eq!(
            diagnostic_detail("dns error\r\nlink_preview_fake_ip"),
            "dns errorlink_preview_fake_ip"
        );
        assert_eq!(diagnostic_detail(&"x".repeat(1024)).len(), 256);
    }

    #[test]
    fn system_rules_choose_proxy_or_direct_for_each_destination() {
        let client = client(
            Matcher::builder()
                .https("http://127.0.0.1:12345")
                .no("direct.example")
                .build(),
        );
        let proxy_url = Url::parse("https://proxied.example/page").unwrap();
        let direct_url = Url::parse("https://direct.example/page").unwrap();
        assert_eq!(
            client.proxy_for(&proxy_url).unwrap().uri().host(),
            Some("127.0.0.1")
        );
        assert!(client.proxy_for(&direct_url).is_none());
        assert!(client
            .proxy_for(&Url::parse("https://sub.direct.example/page").unwrap())
            .is_none());
        let redirected = next_destination(&direct_url, proxy_url.as_str()).unwrap();
        assert!(client.proxy_for(&redirected).is_some());
        let redirected = next_destination(&proxy_url, direct_url.as_str()).unwrap();
        assert!(client.proxy_for(&redirected).is_none());
    }

    #[test]
    fn no_configured_proxy_selects_the_direct_client() {
        let client = client(Matcher::builder().build());
        let url = Url::parse("https://example.com/page").unwrap();
        assert!(client.proxy_for(&url).is_none());
        assert!(std::ptr::eq(
            client.client_for(None).unwrap(),
            &client.direct
        ));
        assert!(client.proxy_client.get().is_none());
    }

    #[test]
    fn explicitly_configured_localhost_proxy_uses_a_separate_reusable_client() {
        let client = client(
            Matcher::builder()
                .https("http://user:fixture-password@localhost:12345")
                .build(),
        );
        let url = Url::parse("https://example.com/page").unwrap();
        let proxy = client.proxy_for(&url).unwrap();
        assert!(proxy.basic_auth().is_some());
        let first = client.client_for(Some(proxy)).unwrap();
        assert!(!std::ptr::eq(first, &client.direct));
        let second = client.client_for(client.proxy_for(&url)).unwrap();
        assert!(std::ptr::eq(first, second));
    }

    #[test]
    fn failed_selected_proxy_does_not_fall_back_to_direct() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let client = client(
            Matcher::builder()
                .https(format!("http://{address}"))
                .build(),
        );
        let error = client
            .get(
                Url::parse("https://preview-fixture.example/?token=fixture-secret").unwrap(),
                &[],
            )
            .unwrap_err();
        let error = String::from(error);
        assert_eq!(error, "link_preview_proxy_unavailable");
        assert!(!error.contains("fixture-secret"));
    }

    #[test]
    fn unsupported_socks_proxy_does_not_fall_back_to_direct() {
        let client = client(Matcher::builder().https("socks5://127.0.0.1:1").build());
        assert_eq!(
            String::from(
                client
                    .get(Url::parse("https://example.com").unwrap(), &[])
                    .unwrap_err()
            ),
            "link_preview_proxy_unavailable"
        );
        assert!(client.proxy_client.get().is_none());
    }

    #[test]
    fn destination_checks_still_apply_when_a_trusted_proxy_is_present() {
        let client = client(Matcher::builder().https("http://127.0.0.1:12345").build());
        for url in [
            "https://127.0.0.1/action",
            "https://192.168.1.1/action",
            "https://[::1]/action",
            "https://service.local/action",
            "https://service.internal/action",
            "http://example.com/page",
            "file:///C:/private.txt",
        ] {
            assert_eq!(
                String::from(client.get(Url::parse(url).unwrap(), &[]).unwrap_err()),
                "link_preview_blocked",
                "{url}"
            );
        }
        assert!(client.proxy_client.get().is_none());
    }

    #[test]
    fn redirect_validation_rejects_internal_or_downgraded_destinations() {
        let url = Url::parse("https://example.com/article").unwrap();
        for location in [
            "http://example.com/next",
            "https://127.0.0.1/action",
            "https://10.0.0.1/action",
            "https://[::1]/action",
            "https://printer.local/status",
            "https://api.internal/action",
            "file:///private",
            "javascript:alert(1)",
        ] {
            assert_eq!(
                next_destination(&url, location).unwrap_err(),
                "link_preview_blocked"
            );
        }
        assert_eq!(
            next_destination(&url, "/next").unwrap().as_str(),
            "https://example.com/next"
        );
    }

    #[test]
    fn malformed_headers_do_not_leak_values_in_errors() {
        let client = client(Matcher::builder().build());
        let error = client
            .get(
                Url::parse("https://example.com").unwrap(),
                &[(REFERER, "private-value\r\ninjected: header")],
            )
            .unwrap_err();
        assert_eq!(String::from(error), "link_preview_network");
    }

    #[test]
    fn card_fetch_cookie_scope_is_shared_but_document_scope_can_disable_cookies() {
        use reqwest::cookie::CookieStore;
        let client = client(Matcher::builder().build());
        let url = Url::parse("https://example.com/page").unwrap();
        let jar = client.cookie_jar.as_ref().unwrap();
        jar.add_cookie_str("session=fixture; Secure; Path=/", &url);
        assert!(jar
            .cookies(&url)
            .unwrap()
            .to_str()
            .unwrap()
            .contains("session=fixture"));
        let document_client =
            PreviewHttpClient::new("vPaste-preview-test", 6, false, Matcher::builder().build())
                .unwrap();
        assert!(document_client.cookie_jar.is_none());
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(8));
    }
}
