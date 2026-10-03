//! What the core shares with the accounts server at api.sikemux.com. The types
//! in [`protocol`] are generated from `server/protocol/schema`.

#[cfg(unix)]
pub mod live;
pub mod protocol;

/// Where the accounts API is. Dev builds talk to a server on this computer,
/// or to `SIKEMUX_API_URL`.
pub fn api_base() -> String {
    if cfg!(debug_assertions) {
        std::env::var("SIKEMUX_API_URL").unwrap_or_else(|_| "http://127.0.0.1:4000".into())
    } else {
        "https://api.sikemux.com".into()
    }
}

/// What a device signs to register with an account. It binds the server's
/// one-time challenge, the account and the key, so the signature proves
/// nothing else. The server checks exactly this text.
pub fn registration_message(nonce: &str, user_id: &str, key: &str) -> String {
    format!("sikemux-register|{nonce}|{user_id}|{key}")
}

/// Accepts only a challenge and a Clerk user id, so a request to sign a
/// registration cannot make the core sign any other text.
pub fn check_registration(nonce: &str, user_id: &str) -> Result<(), &'static str> {
    check_live(nonce)?;
    check_user_id(user_id)
}

/// What a device signs to open its live connection to the account. The prefix
/// differs from registration's, so neither signature stands in for the other.
pub fn live_message(nonce: &str, key: &str) -> String {
    format!("sikemux-live|{nonce}|{key}")
}

/// Accepts only a server challenge: 64 lowercase hex characters.
pub fn check_live(nonce: &str) -> Result<(), &'static str> {
    let is_challenge = nonce.len() == 64
        && nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if is_challenge {
        Ok(())
    } else {
        Err("the challenge is 64 lowercase hex characters")
    }
}

/// Clerk user ids look like `user_2abcXYZ`.
pub fn check_user_id(user_id: &str) -> Result<(), &'static str> {
    let valid = user_id.strip_prefix("user_").is_some_and(|rest| {
        !rest.is_empty() && rest.len() <= 64 && rest.bytes().all(|b| b.is_ascii_alphanumeric())
    });
    if valid {
        Ok(())
    } else {
        Err("the account is a Clerk user id like user_2abc")
    }
}

#[cfg(test)]
type RoundTrip = serde_json::Result<serde_json::Value>;

#[cfg(test)]
fn through<T: serde::de::DeserializeOwned + serde::Serialize>(json: &str) -> RoundTrip {
    serde_json::to_value(serde_json::from_str::<T>(json)?)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// Every example in `server/protocol/fixtures` reads as its Rust type and
    /// writes back unchanged, so the server and the core agree on the wire.
    #[test]
    fn fixtures_round_trip() -> Result<(), Box<dyn std::error::Error>> {
        let fixtures =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../server/protocol/fixtures");
        let mut checked = 0;
        for kind in std::fs::read_dir(&fixtures)? {
            let kind = kind?;
            let name = kind.file_name().to_string_lossy().into_owned();
            for example in std::fs::read_dir(kind.path())? {
                let path = example?.path();
                let json = std::fs::read_to_string(&path)?;
                let written = super::protocol::round_trip(&name, &json)
                    .ok_or_else(|| format!("{name} has fixtures but no Rust type"))?
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                let read: serde_json::Value = serde_json::from_str(&json)?;
                assert_eq!(
                    written,
                    read,
                    "{} changed on the way through Rust",
                    path.display()
                );
                checked += 1;
            }
        }
        assert!(checked > 0, "no fixtures under {}", fixtures.display());
        Ok(())
    }

    #[test]
    fn registration_text_is_only_ever_a_challenge_and_an_account() {
        let nonce = "a".repeat(64);
        assert!(super::check_registration(&nonce, "user_2abc").is_ok());
        assert!(super::check_registration("short", "user_2abc").is_err());
        assert!(super::check_registration(&"A".repeat(64), "user_2abc").is_err());
        assert!(super::check_registration(&nonce, "user_").is_err());
        assert!(super::check_registration(&nonce, "org_2abc").is_err());
        assert!(super::check_registration(&nonce, "user_2abc|anything").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn live_hellos_sign_the_text_the_server_checks() -> Result<(), Box<dyn std::error::Error>> {
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../server/protocol/vectors/live.json"
        ))?;
        let text = |name: &str| vector[name].as_str().unwrap_or_default().to_owned();
        let bytes: [u8; 32] = hex::decode(text("secretKey"))?
            .try_into()
            .map_err(|_| "the secret is 32 bytes")?;
        let key = iroh::SecretKey::from_bytes(&bytes);
        assert_eq!(key.public().to_string(), text("key"));
        let message = super::live_message(&text("nonce"), &text("key"));
        assert_eq!(message, text("message"));
        assert_eq!(
            hex::encode(key.sign(message.as_bytes()).to_bytes()),
            text("signature")
        );
        Ok(())
    }

    #[test]
    fn live_text_is_only_ever_a_challenge() {
        assert!(super::check_live(&"a".repeat(64)).is_ok());
        assert!(super::check_live("short").is_err());
        assert!(super::check_live(&"A".repeat(64)).is_err());
        assert!(super::check_live(&format!("{}|x", "a".repeat(62))).is_err());
    }

    #[test]
    fn unknown_enum_values_still_read() -> serde_json::Result<()> {
        let code: super::protocol::ErrorCode = serde_json::from_str("\"added_later\"")?;
        assert_eq!(code, super::protocol::ErrorCode::Unknown);
        Ok(())
    }
}
