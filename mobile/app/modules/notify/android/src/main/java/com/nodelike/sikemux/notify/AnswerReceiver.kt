package com.nodelike.sikemux.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService

/** Allow and Reject on a card: shows that the answer is on its way and hands it to the app's JavaScript. */
class AnswerReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION) return
    val tag = intent.getStringExtra(TAG) ?: return
    val hostName = intent.getStringExtra(HOST_NAME) ?: "your computer"
    val allow = intent.getBooleanExtra(ALLOW, false)
    val notifier = Notifier(context)
    notifier.showAnswer(tag, if (allow) "Allowing…" else "Rejecting…", null, intent.getStringExtra(URL), Notifier.Answer.SENDING)
    AnswerService.waiting(tag, hostName, intent.getStringExtra(URL))
    val service = Intent(context, AnswerService::class.java).putExtras(intent)
    try {
      context.startService(service)
      HeadlessJsTaskService.acquireWakeLockNow(context)
    } catch (_: IllegalStateException) {
      AnswerService.settle(context, tag, AnswerService.FAILED)
    }
  }

  companion object {
    const val ACTION = "com.nodelike.sikemux.notify.ANSWER"
    const val TAG = "tag"
    const val HOST = "host"
    const val HOST_NAME = "hostName"
    const val AGENT = "agent"
    const val REQUEST = "request"
    const val OPTION = "option"
    const val ALLOW = "allow"
    const val URL = "url"
  }
}
