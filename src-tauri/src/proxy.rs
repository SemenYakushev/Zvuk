use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

/* Локальный прокси для Web Audio.
   CDN отдаёт подписанные ссылки на треки без Access-Control-Allow-Origin,
   поэтому MediaElementSource замолкает. Прокси на 127.0.0.1 добавляет CORS
   и пробрасывает Range, чтобы работала перемотка. */

#[derive(Clone)]
struct ProxyState {
    token: String,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct MediaQuery {
    t: String,
    u: String,
}

const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

pub fn spawn() -> (u16, String) {
    let token = random_token();
    let client = match reqwest::Client::builder().user_agent(UA).build() {
        Ok(client) => client,
        Err(_) => return (0, token),
    };
    let state = Arc::new(ProxyState {
        token: token.clone(),
        client,
    });
    let app = Router::new()
        .route("/media", get(media))
        .route("/ping", get(|| async { "ok" }))
        .with_state(state);

    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => {
                let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
                let _ = tx.send(port);
                let _ = axum::serve(listener, app).await;
            }
            Err(_) => {
                let _ = tx.send(0);
            }
        }
    });
    let port = rx.recv_timeout(Duration::from_secs(5)).unwrap_or(0);
    (port, token)
}

async fn media(
    State(state): State<Arc<ProxyState>>,
    Query(q): Query<MediaQuery>,
    headers: HeaderMap,
) -> Response {
    if q.t != state.token {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let target = match reqwest::Url::parse(&q.u) {
        Ok(url) => url,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad url").into_response(),
    };
    let host = target.host_str().unwrap_or("");
    if !(host == "zvuk.com" || host.ends_with(".zvuk.com")) {
        return (StatusCode::FORBIDDEN, "bad host").into_response();
    }

    let mut request = state.client.get(target);
    if let Some(range) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        request = request.header(header::RANGE, range);
    }
    let upstream = match request.send().await {
        Ok(response) => response,
        Err(_) => return (StatusCode::BAD_GATEWAY, "upstream").into_response(),
    };

    let status = upstream.status().as_u16();
    let mut builder = Response::builder().status(status);
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::CACHE_CONTROL,
        header::LAST_MODIFIED,
        header::ETAG,
    ] {
        if let Some(value) = upstream.headers().get(&name) {
            builder = builder.header(name, value);
        }
    }
    builder
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "*")
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "build").into_response())
}

fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", nanos, std::process::id())
}
