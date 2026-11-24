package id.samsaku.capture

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.security.MessageDigest
import java.util.concurrent.Executors

class CaptureService : NotificationListenerService() {
    private val writes = Executors.newSingleThreadExecutor()
    private val sensitive = Regex("""(?i)\b(otp|pin|password|verification code|kode verifikasi|kode keamanan)\b""")
    private val transaction = Regex("""(?i)(\bRp\.?\s*\d|\bIDR\s*\d|pembayaran|transaksi|transfer|top[ -]?up|pengembalian dana)""")
    private val promotion = Regex("""(?i)\b(promo|voucher|diskon hingga|kode kupon)\b""")

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val allowed = Connection(this).prefs.getStringSet("packages", emptySet()).orEmpty()
        if (sbn.packageName !in allowed || sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val extras = sbn.notification.extras
        val body = listOfNotNull(extras.getCharSequence(Notification.EXTRA_TITLE),
            extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))
            .joinToString("\n").take(2000).trim()
        if (body.isEmpty() || sensitive.containsMatchIn(body) || promotion.containsMatchIn(body) || !transaction.containsMatchIn(body)) return
        val key = listOf(sbn.key, sbn.postTime.toString(), body).joinToString("|")
        val id = MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }
        writes.execute {
            CaptureDatabase.get(applicationContext).outbox().put(PendingEvent(id, sbn.postTime, body, sbn.packageName))
            SendWorker.enqueue(applicationContext)
        }
    }
    override fun onListenerConnected() {
        super.onListenerConnected()
        SendWorker.enqueue(applicationContext)
    }
    override fun onDestroy() {
        writes.shutdown()
        super.onDestroy()
    }
}
