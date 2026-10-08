package com.nodelike.sikemux.notify

import org.json.JSONException
import org.json.JSONObject

/** What a host asked the phone to show, as it sealed it. */
class Card(
  val kind: String,
  val channel: String?,
  val collapseId: String,
  val thread: String,
  val host: String,
  val hostName: String,
  val agentId: String,
  val title: String,
  val body: String,
  val detail: String?,
  val url: String,
  val requestId: String?,
  val allowOptionId: String?,
  val rejectOptionId: String?,
  val at: Long,
  val expiresAt: Long,
) {
  val answerable: Boolean
    get() = kind == "permission" && requestId != null && allowOptionId != null && rejectOptionId != null

  /** How long the card has left to show at `now`, or null once its life is over. */
  fun timeLeft(now: Long): Long? = (expiresAt - now).takeIf { it > 0 }

  companion object {
    const val VERSION = 1

    /** Null when the host sealed a version this app does not know, or something that is not a card from `host`. */
    fun parse(plaintext: String, host: String): Card? {
      val json = try {
        JSONObject(plaintext)
      } catch (_: JSONException) {
        return null
      }
      if (json.optInt("v") != VERSION || json.optString("hostKey") != host) return null
      fun text(name: String): String? = if (json.isNull(name)) null else json.getString(name)
      return try {
        Card(
          kind = json.getString("kind"),
          channel = text("channel"),
          collapseId = json.getString("collapseId"),
          thread = json.getString("thread"),
          host = host,
          hostName = json.getString("hostName"),
          agentId = json.getString("agentId"),
          title = json.getString("title"),
          body = json.getString("body"),
          detail = text("detail"),
          url = json.getString("url"),
          requestId = text("requestId"),
          allowOptionId = text("allowOptionId"),
          rejectOptionId = text("rejectOptionId"),
          at = json.getLong("at"),
          expiresAt = json.getLong("expiresAt"),
        )
      } catch (_: JSONException) {
        null
      }
    }
  }
}
