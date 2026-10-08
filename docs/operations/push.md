# Push notifications

A host that wants to tell a phone something sends a `push` frame on its `/v1/live` socket.
The API checks the phone is a client on the host's own account and has a push token, then
hands the sealed blob to Firebase Cloud Messaging (Android) or Apple's push service (iOS). The blob is encrypted on the host with a key only the phone has; the API never reads
it, never stores it and never logs it. Logs carry key prefixes, the result and the time taken.

## What runs

| Piece                      | Where                                                                       |
| -------------------------- | --------------------------------------------------------------------------- |
| Token routes               | `PUT` and `DELETE /v1/devices/{key}/push` (`server/api/src/push/routes.ts`) |
| Sender, limits and retries | `server/api/src/push/send.ts`                                               |
| FCM HTTP v1                | `server/api/src/push/fcm.ts`                                                |
| APNs over HTTP/2           | `server/api/src/push/apns.ts`                                               |
| Tokens                     | the `push_tokens` table, one row per phone (`migrations/0004_push.sql`)     |

A token goes when its phone does: removing the phone, signing out, and deleting the account
all delete the device row, and the token with it. FCM saying a token is unregistered or
invalid deletes it too, as does APNs answering 410, `BadDeviceToken` or
`DeviceTokenNotForTopic`. A token that fails 20 times in a row, with no success in 30 days, is
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
# Apple's push key (.p8), its key id and the team it belongs to. Without them the API starts,
# and pushes to iPhones answer not_set_up. The topic is the app's bundle id:
# com.nodelike.sikemux.mobile, or com.nodelike.sikemux.mobile.dev when PUSH_APP=dev.
APNS_KEY_FILE=/etc/sikemux/apns.p8
APNS_KEY_ID=ABC123DEFG
APNS_TEAM_ID=D577WD6Z5U
```

Both key files are secrets: anyone holding one can push to every phone of ours on its
platform. Keep them `root:sikemux`, mode `640`, beside `api.env`. They never go in GitHub or
CI.

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

## Setting up APNs

1. In the Apple Developer portal, under Certificates, Identifiers & Profiles → Keys, create
   a key with **Apple Push Notifications service (APNs)** enabled, for both environments.
   Download the `.p8` (Apple offers it once) and note its key id. One key serves every app
   of the team, sandbox and production.
2. Put it on citadel as `/etc/sikemux/apns.p8` (`chown root:sikemux`, `chmod 640`), add
   `APNS_KEY_FILE`, `APNS_KEY_ID` and `APNS_TEAM_ID` to `api.env`, and restart
   `sikemux-api`. The log line `pushing to iOS through APNs` names the key and topic.
3. For a local dev API, set the same three in `server/api/.env` with `PUSH_APP=dev`.

Each token says which of Apple's servers issued it: `sandbox` for a Debug build run from
Xcode, `production` for TestFlight, the App Store and Release builds. The API sends each
push to the server its token came from, and a production API takes sandbox tokens only with
`APNS_ALLOW_SANDBOX=1`.

An alert goes out with `mutable-content`, so the phone's notification extension opens the
sealed card and replaces the generic "An agent on your computer needs you" with it. A `clear`
goes as a background push at priority 5, which wakes the app to take the card away. iOS
limits how often it wakes an app, and never wakes one the person swiped away, so a clear can
be late or lost; the app tidies its cards when it next connects.

To rotate the key, create a new one, replace the file and `APNS_KEY_ID`, restart the API,
then revoke the old key.

## Limits

- 30 pushes a minute from one host to one phone, and 120 a minute to one phone in total.
  Past either, the host hears `throttled`.
- 32 pushes from one host may wait on FCM or APNs at once.
- 429 and 5xx answers from FCM or APNs are retried three times (after 1, 2 and 4 seconds,
  or the service's Retry-After up to 30 seconds), within a minute and before the push's own
  `expiresAt`. Then the host hears `failed`.

## Reading the logs

Every push logs one line, `pushed`, with `from` and `to` (key prefixes), `kind`, `bytes`,
`result`, `platform`, `attempts`, `ms`, and `why` when FCM or APNs refused it. In SigNoz:
`service = sikemux-api AND body = pushed`. A burst of `failed` with `why` `401` or
`PERMISSION_DENIED` means the service account lost its role or its key was deleted; `403
InvalidProviderToken` means the APNs key was revoked or its ids are wrong.
