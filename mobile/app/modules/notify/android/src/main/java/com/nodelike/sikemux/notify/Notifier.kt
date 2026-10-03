package com.nodelike.sikemux.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.TypefaceSpan
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Posts and removes the cards hosts send, each tagged by its collapse id so a later push can replace or clear it. */
class Notifier(private val context: Context) {
  private val manager = NotificationManagerCompat.from(context)

  fun ensureChannels() {
    val system = context.getSystemService(NotificationManager::class.java) ?: return
    system.createNotificationChannels(
      listOf(
        NotificationChannel(NEEDS_YOU, "Agents that need you", NotificationManager.IMPORTANCE_HIGH),
        NotificationChannel(FINISHED, "Finished work", NotificationManager.IMPORTANCE_DEFAULT),
        NotificationChannel(PROBLEMS, "Problems", NotificationManager.IMPORTANCE_DEFAULT),
      ),
    )
  }

  fun show(card: Card) {
    val builder = base(card.channel ?: NEEDS_YOU)
      .setContentTitle(card.title)
      .setContentText(card.detail ?: card.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text(card)))
      .setWhen(card.at)
      .setShowWhen(true)
      .setGroup(card.thread)
      .setContentIntent(open(card.collapseId, card.url))
      .setExtras(extras(card))
    val left = card.expiresAt - System.currentTimeMillis()
    if (left > 0) builder.setTimeoutAfter(left)
    if (card.answerable) {
      builder.addAction(answer(card, card.rejectOptionId!!, "Reject", authenticated = false))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        builder.addAction(answer(card, card.allowOptionId!!, "Allow", authenticated = true))
      } else {
        builder.addAction(NotificationCompat.Action.Builder(0, "Allow", open(card.collapseId, card.url)).build())
      }
    }
    post(card.collapseId, builder)
  }

  /** What shows when a push cannot be read: it says only that something needs the person, and opens the app. */
  fun showGeneric(tag: String) {
    post(
      tag,
      base(NEEDS_YOU)
        .setContentTitle("Sikemux")
        .setContentText("An agent on your computer needs you")
        .setContentIntent(open(tag, null)),
    )
  }

  /** Replaces a card while its answer is on the way, or with how it went. */
  fun showAnswer(tag: String, title: String, text: String?, url: String?, state: Answer) {
    val builder = base(NEEDS_YOU)
      .setContentTitle(title)
      .setSilent(true)
      .setOngoing(state == Answer.SENDING)
      .setContentIntent(open(tag, url))
    text?.let { builder.setContentText(it) }
    if (state == Answer.DONE) builder.setTimeoutAfter(SETTLED_MS)
    post(tag, builder)
  }

  enum class Answer { SENDING, DONE, FAILED }

  fun cancel(tag: String) {
    manager.cancel(tag, ID)
  }

  fun cancelAll() {
    manager.cancelAll()
  }

  /** The cards showing now that came from a host, as the app reconciles them with what hosts still ask. */
  fun shown(): List<Map<String, String>> {
    val system = context.getSystemService(NotificationManager::class.java) ?: return emptyList()
    return system.activeNotifications.mapNotNull { active ->
      val extras = active.notification.extras
      val host = extras.getString(EXTRA_HOST)
      if (active.id != ID || host == null) return@mapNotNull null
      buildMap {
        put("tag", active.tag)
        put("host", host)
        extras.getString(EXTRA_AGENT)?.let { put("agent", it) }
        extras.getString(EXTRA_KIND)?.let { put("kind", it) }
        extras.getString(EXTRA_REQUEST)?.let { put("request", it) }
      }
    }
  }

  private fun base(channel: String): NotificationCompat.Builder {
    val builder = NotificationCompat.Builder(context, channel)
      .setSmallIcon(smallIcon())
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setOnlyAlertOnce(true)
    color()?.let { builder.setColor(it) }
    return builder
  }

  private fun post(tag: String, builder: NotificationCompat.Builder) {
    ensureChannels()
    if (!manager.areNotificationsEnabled()) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    manager.notify(tag, ID, builder.build())
  }

  private fun text(card: Card): CharSequence {
    val detail = card.detail ?: return card.body
    return SpannableStringBuilder(detail).apply {
      setSpan(monospace(), 0, detail.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      append('\n')
      append(card.body)
    }
  }

  private fun monospace(): TypefaceSpan =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) TypefaceSpan(Typeface.MONOSPACE) else TypefaceSpan("monospace")

  private fun extras(card: Card) = Bundle().apply {
    putString(EXTRA_HOST, card.host)
    putString(EXTRA_AGENT, card.agentId)
    putString(EXTRA_KIND, card.kind)
    card.requestId?.let { putString(EXTRA_REQUEST, it) }
  }

  /** Opens the app at `url`, rewritten to this build's own scheme; without one, opens the app where it was. */
  private fun open(tag: String, url: String?): PendingIntent {
    val link = url?.let { ownLink(it) }
    val intent = if (link != null) {
      Intent(Intent.ACTION_VIEW, link).setPackage(context.packageName)
    } else {
      context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(
      context,
      tag.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun ownLink(url: String): Uri? {
    val path = url.removePrefix(HOST_SCHEME).takeIf { it != url && it.startsWith("device/") } ?: return null
    return Uri.parse("${scheme()}://$path")
  }

  private fun scheme(): String =
    context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      .metaData?.getString(SCHEME_META) ?: "sikemux"

  private fun answer(card: Card, option: String, title: String, authenticated: Boolean): NotificationCompat.Action {
    val intent = Intent(context, AnswerReceiver::class.java).apply {
      action = AnswerReceiver.ACTION
      putExtra(AnswerReceiver.TAG, card.collapseId)
      putExtra(AnswerReceiver.HOST, card.host)
      putExtra(AnswerReceiver.HOST_NAME, card.hostName)
      putExtra(AnswerReceiver.AGENT, card.agentId)
      putExtra(AnswerReceiver.REQUEST, card.requestId)
      putExtra(AnswerReceiver.OPTION, option)
      putExtra(AnswerReceiver.ALLOW, authenticated)
      putExtra(AnswerReceiver.URL, card.url)
    }
    val pending = PendingIntent.getBroadcast(
      context,
      (card.collapseId + option).hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Action.Builder(0, title, pending)
      .setAuthenticationRequired(authenticated)
      .setShowsUserInterface(false)
      .build()
  }

  private fun smallIcon(): Int {
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (icon != 0) icon else context.applicationInfo.icon
  }

  private fun color(): Int? {
    val color = context.resources.getIdentifier("notification_icon_color", "color", context.packageName)
    return if (color != 0) ContextCompat.getColor(context, color) else null
  }

  companion object {
    const val NEEDS_YOU = "needs-you"
    const val FINISHED = "finished"
    const val PROBLEMS = "problems"
    const val ID = 7
    const val SETTLED_MS = 4_000L
    const val SCHEME_META = "com.nodelike.sikemux.scheme"
    private const val HOST_SCHEME = "sikemux://"
    private const val EXTRA_HOST = "sikemux.host"
    private const val EXTRA_AGENT = "sikemux.agent"
    private const val EXTRA_KIND = "sikemux.kind"
    private const val EXTRA_REQUEST = "sikemux.request"
  }
}
