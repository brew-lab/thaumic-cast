//! HTTP response helper functions for consistent API responses.

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;
use serde_json::json;

/// Standard API success response with JSON data.
pub fn api_success<T: Serialize>(data: T) -> impl IntoResponse {
    (StatusCode::OK, Json(data))
}

/// Simple success response with `{ "success": true }`.
pub fn api_ok() -> impl IntoResponse {
    api_success(json!({ "success": true }))
}

/// Standard API error response with code and message.
pub fn api_error(
    status: StatusCode,
    code: &str,
    message: impl std::fmt::Display,
) -> impl IntoResponse {
    (
        status,
        Json(json!({
            "error": code,
            "message": message.to_string()
        })),
    )
}
