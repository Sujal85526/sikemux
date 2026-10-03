package com.nodelike.sikemux.notify

import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** A notification key the phone gave one host. */
class HostKey(val host: String, val keyId: Long, val key: ByteArray)

sealed interface Opened {
  class Read(val host: String, val plaintext: String) : Opened

  /** Sealed by a newer host than this app understands. */
  object Unknown : Opened

  object NoKey : Opened

  /** No key with the push's key id opened it: the host has a key this phone no longer does. */
  class Unreadable(val host: String) : Opened
}

/** Opens what a host sealed for this phone: base64(version, key id, nonce, AES-256-GCM ciphertext and tag). */
object Envelope {
  private const val VERSION = 1
  private const val NONCE_BYTES = 12
  private const val TAG_BITS = 128
  private const val HEADER = 1 + 4 + NONCE_BYTES

  fun aad(host: String, phone: String, keyId: Long): ByteArray =
    "sikemux-push|v1|$host|$phone|${"%08x".format(keyId)}".toByteArray(Charsets.UTF_8)

  fun keyId(blob: ByteArray): Long =
    ((blob[1].toLong() and 0xff) shl 24) or
      ((blob[2].toLong() and 0xff) shl 16) or
      ((blob[3].toLong() and 0xff) shl 8) or
      (blob[4].toLong() and 0xff)

  fun open(blob: String, phone: String, keys: List<HostKey>): Opened {
    val bytes = try {
      Base64.getDecoder().decode(blob)
    } catch (_: IllegalArgumentException) {
      return Opened.Unknown
    }
    if (bytes.size < HEADER + TAG_BITS / 8 || bytes[0].toInt() != VERSION) return Opened.Unknown
    val keyId = keyId(bytes)
    val candidates = keys.filter { it.keyId == keyId }
    if (candidates.isEmpty()) return Opened.NoKey
    val nonce = bytes.copyOfRange(1 + 4, HEADER)
    val sealed = bytes.copyOfRange(HEADER, bytes.size)
    for (candidate in candidates) {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(candidate.key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
      cipher.updateAAD(aad(candidate.host, phone, keyId))
      try {
        val plaintext = cipher.doFinal(sealed).toString(Charsets.UTF_8).trimEnd(' ')
        return Opened.Read(candidate.host, plaintext)
      } catch (_: AEADBadTagException) {
        continue
      }
    }
    return Opened.Unreadable(candidates.first().host)
  }
}
