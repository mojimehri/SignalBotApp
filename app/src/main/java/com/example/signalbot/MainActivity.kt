package com.example.signalbot

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
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * سرویس پیش‌زمینه: باعث می‌شود اپ وقتی از صفحه خارج می‌شود یا صفحه خاموش است
 * توسط اندروید کشته نشود و تحلیل سیگنال ادامه پیدا کند.
 */
class SignalService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    companion object {
        const val FG_CHANNEL_ID = "signal_bot_service"
        const val FG_NOTIF_ID = 2001
    }

    override fun onCreate() {
        super.onCreate()
        createServiceChannel()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SignalBot::ServiceWakeLock").apply {
            setReferenceCounted(false)
            acquire()   // بدون محدودیت زمانی؛ با توقف سرویس آزاد می‌شود
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notif: Notification = NotificationCompat.Builder(this, FG_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("ربات سیگنال فعال است")
            .setContentText("در حال پایش بازار برای سیگنال…")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openApp)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(FG_NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(FG_NOTIF_ID, notif)
        }
        return START_STICKY
    }

    private fun createServiceChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                FG_CHANNEL_ID,
                "وضعیت ربات",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "نمایش فعال بودن ربات در پس‌زمینه" }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
