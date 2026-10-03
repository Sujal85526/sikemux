# Push notifications

A host that wants to tell a phone something sends a `push` frame on its `/v1/live` socket.
The API checks the phone is a client on the host's own account and has a push token, then
hands the sealed blob to Firebase Cloud Messaging (Android) or, later, Apple's push service
(iOS). The blob is encrypted on the host with a key only the phone has; the API never reads
it, never stores it and never logs it. Logs carry key prefixes, the result and the time taken.

## What runs

| Piece                      | Where                                                                       |
| -------------------------- | --------------------------------------------------------------------------- |
| Token routes               | `PUT` and `DELETE /v1/devices/{key}/push` (`server/api/src/push/routes.ts`) |
| Sender, limits and retries | `server/api/src/push/send.ts`                                               |
| FCM HTTP v1                | `server/api/src/push/fcm.ts`                                                |
| Tokens                     | the `push_tokens` table, one row per phone (`migrations/0004_push.sql`)     |

A token goes when its phone does: removing the phone, signing out, and deleting the account
all delete the device row, and the token with it. FCM saying a token is unregistered or
invalid deletes it too. A token that fails 20 times in a row, with no success in 30 days, is
deleted.

## Settings

In `/etc/sikemux/api.env`:

```sh
# The Firebase service account's JSON key. Without it the API starts, and pushes to Android
# phones answer not_set_up.
FCM_SERVICE_ACCOUNT_FILE=/etc/sikemux/fcm-production.json
# Which phone app this API serves: production (the default) or dev. Tokens from the other
# app are refused, because this API holds only its own app's credentials.
# PUSH_APP=production
# 1 lets a production API take iOS tokens from Apple's sandbox, for a build run from Xcode.
# APNS_ALLOW_SANDBOX=0
```

The key file is a secret: anyone holding it can push to every Android phone of ours. Keep it
`root:sikemux`, mode `640`, beside `api.env`. It never goes in GitHub or CI.

## Setting up Firebase

1. In the Firebase console, add a project `sikemux` (reuse the Google Cloud project the
   OAuth clients live in), and an Android app `com.nodelike.sikemux.mobile`. For the dev
   build, a second project `sikemux-dev` with `com.nodelike.sikemux.mobile.dev`.
2. Download each app's `google-services.json`. It is not secret; the phone app commits it.
3. In Google Cloud → IAM → Service accounts, create `sikemux-push` in the project, with only
   the role **Firebase Cloud Messaging API Admin**. Make sure the **Firebase Cloud
   Messaging API** (v1) is enabled. Create a JSON key for the account.
4. Put the production key on citadel as `/etc/sikemux/fcm-production.json`
   (`chown root:sikemux`, `chmod 640`), add `FCM_SERVICE_ACCOUNT_FILE` to `api.env`, and
   restart `sikemux-api`. The log line `pushing to Android through FCM` names the project.
5. For a local dev API, keep the `sikemux-dev` key outside the repository and set
   `FCM_SERVICE_ACCOUNT_FILE` and `PUSH_APP=dev` in `server/api/.env`.

To rotate the key, create a new one, replace the file, restart the API, then delete the old
key in Google Cloud.

## Limits

- 30 pushes a minute from one host to one phone, and 120 a minute to one phone in total.
  Past either, the host hears `throttled`.
- 32 pushes from one host may wait on FCM at once.
- FCM's 429 and 5xx answers are retried three times (after 1, 2 and 4 seconds, or FCM's
  Retry-After up to 30 seconds), within a minute and before the push's own `expiresAt`.
  Then the host hears `failed`.

## Reading the logs

Every push logs one line, `pushed`, with `from` and `to` (key prefixes), `kind`, `bytes`,
`result`, `platform`, `attempts`, `ms`, and `why` when FCM refused it. In SigNoz:
`service = sikemux-api AND body = pushed`. A burst of `failed` with `why` `401` or
`PERMISSION_DENIED` means the service account lost its role or its key was deleted.

## iOS

APNs is not built yet. iOS phones can already register their tokens, which are stored, and
pushes to them answer `not_set_up`. Adding it means an APNs provider beside `fcm.ts`, given
to the `Pusher` as `providers.apns`.
