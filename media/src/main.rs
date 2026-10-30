use clash_verge_media_unlock::{check_media_unlock, check_media_unlock_item, default_unlock_items};
use serde::Deserialize;
use std::io::{self, Read};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    action: String,
    proxy_port: Option<u16>,
    check: Option<String>,
}

fn validate(request: &Request) -> Result<(), String> {
    match request.action.as_str() {
        "list" if request.proxy_port.is_none() && request.check.is_none() => Ok(()),
        "check" if request.proxy_port.is_some_and(|p| p > 0) => {
            if request
                .check
                .as_ref()
                .is_some_and(|name| !default_unlock_items().iter().any(|item| &item.name == name))
            {
                return Err("Unknown check".into());
            }
            Ok(())
        }
        _ => Err("Explicit list/check action and valid loopback proxy port required".into()),
    }
}
fn client(port: u16) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?)
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(5))
        .cookie_store(true)
        .user_agent("Mozilla/5.0 Luma-Media/0.1")
        .build()
        .map_err(|e| e.to_string())
}
#[tokio::main]
async fn main() {
    let result = run().await;
    match result {
        Ok(value) => println!("{}", serde_json::json!({"ok":true,"items":value})),
        Err(error) => {
            println!("{}", serde_json::json!({"ok":false,"error":error}));
            std::process::exit(1);
        }
    }
}
async fn run() -> Result<serde_json::Value, String> {
    let mut input = Vec::new();
    io::stdin()
        .take(4097)
        .read_to_end(&mut input)
        .map_err(|_| "Cannot read request")?;
    if input.len() > 4096 {
        return Err("Request too large".into());
    }
    let request: Request = serde_json::from_slice(&input).map_err(|_| "Invalid request")?;
    validate(&request)?;
    if request.action == "list" {
        return serde_json::to_value(default_unlock_items()).map_err(|e| e.to_string());
    }
    let client = client(request.proxy_port.unwrap())?;
    let items = if let Some(name) = request.check {
        vec![check_media_unlock_item(&client, &name).await?]
    } else {
        check_media_unlock(&client, |_| {}).await
    };
    serde_json::to_value(items).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn list_matches_upstream_twelve_without_network() {
        let items = default_unlock_items();
        assert_eq!(items.len(), 12);
        assert!(
            items
                .iter()
                .all(|i| i.status == "Pending" && i.check_time.is_none())
        );
    }
    #[test]
    fn malformed_or_implicit_network_requests_fail() {
        for input in [
            r#"{}"#,
            r#"{"action":"check"}"#,
            r#"{"action":"check","proxyPort":0}"#,
            r#"{"action":"check","proxyPort":99999}"#,
            r#"{"action":"check","proxyPort":1234,"proxyHost":"example.com"}"#,
            r#"{"action":"list","proxyPort":1234}"#,
            r#"{"action":"check","proxyPort":1234,"check":"unknown"}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(input)
                    .map_err(|_| ())
                    .and_then(|r| validate(&r).map_err(|_| ()))
                    .is_err(),
                "{input}"
            );
        }
    }
    #[tokio::test]
    async fn external_check_only_contacts_explicit_local_proxy() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = proxy.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = proxy.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut b = [0u8; 4096];
            let n = s.read(&mut b).unwrap();
            let request = String::from_utf8_lossy(&b[..n]).into_owned();
            s.write_all(
                b"HTTP/1.1 502 Local fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            request
        });
        let item = check_media_unlock_item(&client(port).unwrap(), "ChatGPT Web")
            .await
            .unwrap();
        assert_eq!(item.status, "Failed");
        let request = server.join().unwrap();
        assert!(request.starts_with("CONNECT "), "{request}");
    }
    #[tokio::test]
    async fn all_twelve_checks_stay_on_loopback_fixture() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            sync::{
                Arc,
                atomic::{AtomicBool, Ordering},
            },
        };
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = proxy.local_addr().unwrap().port();
        proxy.set_nonblocking(true).unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let stop = done.clone();
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            while !stop.load(Ordering::Relaxed) {
                match proxy.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut b = [0u8; 8192];
                        if let Ok(n) = stream.read(&mut b) {
                            requests.push(String::from_utf8_lossy(&b[..n]).into_owned());
                            let _=stream.write_all(b"HTTP/1.1 502 Local fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
            requests
        });
        let result = check_media_unlock(&client(port).unwrap(), |_| {}).await;
        done.store(true, Ordering::Relaxed);
        let requests = server.join().unwrap();
        assert_eq!(result.len(), 12);
        assert!(result.iter().all(|item| item.status != "Pending"));
        assert!(requests.len() >= 12);
        assert!(
            requests.iter().all(
                |request| request.starts_with("CONNECT ") || request.starts_with("GET http://")
            ),
            "{requests:?}"
        );
    }
}
