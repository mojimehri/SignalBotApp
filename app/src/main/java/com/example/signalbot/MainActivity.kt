package com.example.signalbot

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.view.WindowManager
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val executor = Executors.newCachedThreadPool()
    private var reqId = 0
    private var wakeLock: PowerManager.WakeLock? = null

    companion object {
        const val CHANNEL_ID = "signal_bot_channel"
        const val NOTIF_ID = 1001
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // صفحه روشن بماند
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // WakeLock برای اجرا در پس‌زمینه
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK, "SignalBot::WakeLock"
        ).also { it.acquire(4 * 60 * 60 * 1000L) }  // 4 ساعت

        createNotificationChannel()
        setupWebView()
        setContentView(webView)
    }

    private fun setupWebView() {
        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccessFromFileURLs = true
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            addJavascriptInterface(Bridge(), "Android")
            webChromeClient = WebChromeClient()
            webViewClient = WebViewClient()
            loadUrl("file:///android_asset/index.html")
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            val audioAttr = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            val channel = NotificationChannel(
                CHANNEL_ID,
                "سیگنال‌های معاملاتی",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "اعلان سیگنال CALL / PUT"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 400, 200, 400, 200, 400)
                setSound(sound, audioAttr)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    /** ارسال اعلان سیگنال با صدا و لرزش */
    fun showSignalNotification(pair: String, direction: String, score: Int) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pi = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val emoji = if (direction == "CALL") "🟢" else "🔴"
        val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)

        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("$emoji سیگنال $direction — $pair")
            .setContentText("قدرت: $score | همین الان وارد شوید")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVibrate(longArrayOf(0, 400, 200, 400, 200, 400))
            .setSound(sound)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()

        try {
            NotificationManagerCompat.from(this).notify(NOTIF_ID, notif)
        } catch (_: SecurityException) { }
    }

    inner class Bridge {

        /** درخواست HTTP به Yahoo Finance — فقط دامنه مجاز */
        @JavascriptInterface
        fun get(urlStr: String, id: String) {
            if (!urlStr.startsWith("https://query1.finance.yahoo.com/")) {
                reply(id, false, "\"blocked\"")
                return
            }
            executor.execute {
                try {
                    val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                        setRequestProperty("User-Agent", "Mozilla/5.0")
                        connectTimeout = 10_000
                        readTimeout = 15_000
                    }
                    val code = conn.responseCode
                    if (code == 200) {
                        val body = BufferedReader(InputStreamReader(conn.inputStream))
                            .use { it.readText() }
                        reply(id, true, JSONString.quote(body))
                    } else {
                        reply(id, false, "\"HTTP $code\"")
                    }
                    conn.disconnect()
                } catch (e: Exception) {
                    reply(id, false, "\"${e.message?.replace("\"","'")}\"")
                }
            }
        }

        /** لرزش + اعلان سیگنال */
        @JavascriptInterface
        fun signal(pair: String, direction: String, score: Int) {
            runOnUiThread {
                showSignalNotification(pair, direction, score)
            }
        }

        /** لرزش ساده (بدون اعلان) */
        @JavascriptInterface
        fun vibrate() {
            val vib = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = getSystemService(Context.VIBRATOR_MANAGER_SERVICE)
                        as android.os.VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as android.os.Vibrator
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vib.vibrate(android.os.VibrationEffect.createWaveform(
                    longArrayOf(0, 300, 150, 300), -1))
            } else {
                @Suppress("DEPRECATION")
                vib.vibrate(longArrayOf(0, 300, 150, 300), -1)
            }
        }

        private fun reply(id: String, ok: Boolean, json: String) {
            val js = "window.__onGet(${JSONString.quote(id)},${if (ok) "true" else "false"},$json)"
            webView.post { webView.evaluateJavascript(js, null) }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        wakeLock?.release()
        executor.shutdownNow()
    }
}

/** کمکی برای escape کردن JSON string */
object JSONString {
    fun quote(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> sb.append(c)
        }
        sb.append('"')
        return sb.toString()
    }
}
