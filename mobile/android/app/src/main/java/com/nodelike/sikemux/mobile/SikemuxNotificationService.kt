package com.nodelike.sikemux.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class SikemuxNotificationService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }

        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Sikemux live"
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Connected to desktop"
        val connected = intent?.getBooleanExtra(EXTRA_CONNECTED, false) ?: false
        val ptyId = intent?.getIntExtra(EXTRA_PTY_ID, -1)?.takeIf { it > 0 }

        ensureChannel()
        val notification = buildNotification(title = title, text = text, connected = connected, ptyId = ptyId)
        startForegroundCompat(notification)
        return START_STICKY
    }

    private fun buildNotification(title: String, text: String, connected: Boolean, ptyId: Int?): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            this,
            1,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val stopIntent = Intent(this, SikemuxNotificationService::class.java).apply { action = ACTION_STOP }
        val stopPending = PendingIntent.getService(
            this,
            2,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val bigText = buildString {
            append(text)
            if (ptyId != null) append("\nPTY #").append(ptyId).append(" is live. Open Sikemux to type/control.")
            append("\nForeground service keeps the OS live activity/notification surface active.")
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_sikemux)
            .setContentTitle(title)
            .setContentText(text)
            .setSubText("Sikemux")
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
            .setContentIntent(openPending)
            .setOngoing(connected)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(R.drawable.ic_stat_sikemux, "Open", openPending)
            .addAction(R.drawable.ic_stat_sikemux, "Stop", stopPending)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        val existing = manager.getNotificationChannel(CHANNEL_ID)
        if (existing != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Sikemux live sessions",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Live Sikemux project, terminal, and agent status"
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        manager.createNotificationChannel(channel)
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    companion object {
        private const val CHANNEL_ID = "sikemux_live"
        private const val NOTIFICATION_ID = 48731
        private const val ACTION_STOP = "com.nodelike.sikemux.mobile.STOP_NOTIFICATION"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_CONNECTED = "connected"
        private const val EXTRA_PTY_ID = "ptyId"

        fun update(context: Context, state: UiState) {
            if (!state.connected && !state.connecting) {
                context.stopService(Intent(context, SikemuxNotificationService::class.java))
                return
            }

            val title = when {
                state.activePtyId != null -> "Sikemux terminal live"
                state.selectedProject != null -> state.selectedProject?.name ?: "Sikemux connected"
                else -> "Sikemux connected"
            }
            val text = when {
                state.connecting -> "Connecting to desktop..."
                state.activePtyId != null -> "PTY #${state.activePtyId} · tap to open controls"
                state.selectedProject != null -> "${state.ptys.count { it.cwd == state.selectedProject?.cwd }} terminals · ${state.snapshot.agentsBySession[state.selectedProjectId].orEmpty().size} agents"
                else -> "${state.projects.size} projects synced · ${state.ptys.size} terminals"
            }
            val intent = Intent(context, SikemuxNotificationService::class.java).apply {
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_TEXT, text)
                putExtra(EXTRA_CONNECTED, state.connected)
                putExtra(EXTRA_PTY_ID, state.activePtyId ?: -1)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
