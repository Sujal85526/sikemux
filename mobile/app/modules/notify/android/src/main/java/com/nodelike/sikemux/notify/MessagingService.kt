package com.nodelike.sikemux.notify

import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/**
 * Takes the pushes hosts send, which carry only a sealed card, and shows them. Anything else, and new
 * tokens, go on to expo-notifications, whose own service this one replaces.
 */
class MessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val data = remoteMessage.data
    val blob = data["b"]
    val tag = data["c"]
    if (blob == null || tag == null) {
      super.onMessageReceived(remoteMessage)
      return
    }
    val notifier = Notifier(applicationContext)
    if (data["t"] == "clear") {
      notifier.cancel(tag)
      return
    }
    val keys = Keys(applicationContext)
    val phone = keys.phone ?: return
    when (val opened = Envelope.open(blob, phone, keys.all())) {
      is Opened.Read -> {
        val card = Card.parse(opened.plaintext, opened.host)
        when {
          card == null -> notifier.showGeneric(tag)
          card.kind == "clear" -> notifier.cancel(card.collapseId)
          else -> notifier.show(card)
        }
      }
      is Opened.Unreadable -> {
        keys.unreadable(opened.host)
        notifier.showGeneric(tag)
      }
      Opened.NoKey, Opened.Unknown -> notifier.showGeneric(tag)
    }
  }
}
