package id.samsaku.capture

import android.content.Context
import androidx.work.*
import org.json.JSONObject
import java.net.URL
import java.time.Instant
import javax.net.ssl.HttpsURLConnection

class SendWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val settings = Connection(applicationContext)
        val dao = CaptureDatabase.get(applicationContext).outbox()
        val base = settings.prefs.getString("url", null) ?: return Result.success()
        fun status(value: String) = settings.prefs.edit().putString("status", value).apply()
        return try {
            repeat(25) {
                val event = dao.first() ?: return Result.success()
                val packet = JSONObject().put("external_id", event.id).put("text", event.body)
                    .put("occurred_at", Instant.ofEpochMilli(event.postedAt).toString())
                    .put("metadata", JSONObject().put("package", event.sourcePackage))
                val con = URL(base + "/v1/events/gopay").openConnection() as HttpsURLConnection
                val code = try {
                    con.requestMethod = "POST"
                    con.instanceFollowRedirects = false
                    con.connectTimeout = 15000
                    con.readTimeout = 75000
                    con.doOutput = true
                    con.setRequestProperty("Content-Type", "application/json")
                    con.setRequestProperty("Authorization", "Bearer " + settings.token())
                    con.outputStream.use { it.write(packet.toString().toByteArray()) }
                    con.responseCode
                } finally { con.disconnect() }
                if (code !in 200..299) {
                    status("HTTP " + code + " · bukti masih di antrean")
                    return if (code == 429 || code >= 500) Result.retry() else Result.failure()
                }
                dao.acknowledge(event.id)
                status("Terkirim " + java.text.DateFormat.getDateTimeInstance().format(java.util.Date()))
            }
            if (dao.count() > 0) enqueue(applicationContext)
            Result.success()
        } catch (_: java.io.IOException) {
            status("Menunggu koneksi")
            Result.retry()
        } catch (_: java.security.GeneralSecurityException) {
            status("Masukkan kembali token konektor")
            Result.failure()
        }
    }
    companion object {
        fun enqueue(context: Context) {
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            val job = OneTimeWorkRequestBuilder<SendWorker>().setConstraints(constraints).build()
            WorkManager.getInstance(context).enqueueUniqueWork("send-events", ExistingWorkPolicy.APPEND_OR_REPLACE, job)
        }
    }
}
