# Sign in with Apple

Apple requires an app that offers Sign in with Apple to revoke the person's Apple tokens when
they delete their account. Clerk signs people in but does not revoke anything with Apple when
a user is deleted, so `DELETE /v1/account` does it itself.

## What happens at deletion

On an iPhone, a person whose account has an Apple sign-in sees Apple's sheet once more before
the deletion. The phone sends the authorization code Apple gives it as
`appleAuthorizationCode`. The API trades the code for a refresh token at
`https://appleid.apple.com/auth/token`, as the phone app's bundle id, and revokes it at
`/auth/revoke`. Without a code, as when deleting at app.sikemux.com, the API asks Clerk for the
Apple access token it holds from a web sign-in and revokes that as the Services ID
`com.nodelike.sikemux.signin`. Both happen before the API deletes the user in Clerk, since
Clerk's copy goes with the user.

The account is deleted whatever Apple answers. Each attempt writes `account.apple_revoked` or
`account.apple_revoke_failed` to the audit table, with `via` `phone` or `clerk`. A failure logs
`could not revoke Sign in with Apple for a deleted account` with the user id and Apple's error
code, never the code or a token. Nothing retries it: Apple's codes last five minutes and work
once.

| Piece                     | Where                                   |
| ------------------------- | --------------------------------------- |
| Client secret and revokes | `server/api/src/account/apple.ts`       |
| Clerk's Apple tokens      | `server/api/src/account/clerk.ts`       |
| Route                     | `server/api/src/account/routes.ts`      |
| Phone                     | `mobile/app/src/app/delete-account.tsx` |

## Settings

In `/etc/sikemux/api.env`:

```sh
# The Sign in with Apple key (.p8), its key id and the team it belongs to. Without them the API
# starts and deletes accounts, but cannot revoke Sign in with Apple.
APPLE_SIGNIN_KEY_FILE=/etc/sikemux/signin-with-apple.p8
APPLE_SIGNIN_KEY_ID=75DSC62NQZ
APPLE_SIGNIN_TEAM_ID=D577WD6Z5U
```

The phone's codes are revoked as `com.nodelike.sikemux.mobile`, or
`com.nodelike.sikemux.mobile.dev` when `PUSH_APP=dev`. A dev API never revokes Clerk's web
tokens, as only production has the Services ID.

The key is a secret: keep it `root:sikemux`, mode `640`, beside `api.env`. It never goes in
GitHub or CI. On start the API logs `revoking Sign in with Apple when accounts are deleted`
with the key id, or warns that `APPLE_SIGNIN_KEY_FILE` is not set.

## Setting up the key

1. In the Apple Developer portal, under Keys, create a key with **Sign in with Apple** enabled
   and the phone app as its primary App ID. Download the `.p8` (Apple offers it once) and
   note its key id.
2. Put it on citadel as `/etc/sikemux/signin-with-apple.p8` (`chown root:sikemux`,
   `chmod 640`), add the three settings to `api.env`, and restart `sikemux-api`.

To rotate the key, create a new one, replace the file and `APPLE_SIGNIN_KEY_ID`, restart the
API, then revoke the old key.
