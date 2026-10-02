//! What the core shares with the accounts server at api.sikemux.com. The types
//! in [`protocol`] are generated from `server/protocol/schema`.

pub mod protocol;

/// What a device signs to register with an account. It binds the server's
/// one-time challenge, the account and the key, so the signature proves
/// nothing else. The server checks exactly this text.
pub fn registration_message(nonce: &str, user_id: &str, key: &str) -> String {
    format!("sikemux-register|{nonce}|{user_id}|{key}")
}

/// Accepts only a challenge and a Clerk user id, so a request to sign a
/// registration cannot make the core sign any other text.
pub fn check_registration(nonce: &str, user_id: &str) -> Result<(), &'static str> {
    let is_challenge = nonce.len() == 64
        && nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !is_challenge {
        return Err("the challenge is 64 lowercase hex characters");
    }
    check_user_id(user_id)
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

    #[test]
    fn unknown_enum_values_still_read() -> serde_json::Result<()> {
        let code: super::protocol::ErrorCode = serde_json::from_str("\"added_later\"")?;
        assert_eq!(code, super::protocol::ErrorCode::Unknown);
        Ok(())
    }
}
