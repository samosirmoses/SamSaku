package id.samsaku.capture

import android.app.Activity
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.widget.*
import java.util.concurrent.Executors

class SettingsActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var status: TextView
    private lateinit var connection: Connection

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        connection = Connection(this)
        val pad = (24 * resources.displayMetrics.density).toInt()
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.rgb(248, 246, 240))
            addView(panel)
            setOnApplyWindowInsetsListener { v, insets ->
                v.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
                insets
            }
        }
        fun label(text: String, size: Float = 16f) = TextView(this).apply {
            this.text = text; textSize = size; setTextColor(Color.rgb(24, 61, 53))
            setPadding(0, pad / 2, 0, pad / 4); panel.addView(this)
        }
        fun button(text: String, action: () -> Unit) = Button(this).apply {
            this.text = text; isAllCaps = false; setOnClickListener { action() }; panel.addView(this)
        }
        label("SamSaku", 36f)
        label("Koneksi notifikasi", 23f)
        label("Pilih sumber transaksi yang boleh dikirim ke backend SamSaku milikmu.")
        fun source(name: String, pkg: String) = CheckBox(this).apply {
            text = name
            isChecked = pkg in connection.prefs.getStringSet("packages", emptySet()).orEmpty()
            panel.addView(this)
        }
        val gopay = source("GoPay", "com.gojek.gopay")
        val gojek = source("Gojek", "com.gojek.app")
        label("Alamat backend")
        val endpoint = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(); hint = "https://samsaku.onrender.com"
            setText(connection.prefs.getString("url", "")); panel.addView(this)
        }
        label("Token konektor GoPay")
        val secret = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine(); isSaveEnabled = false
            hint = if (connection.prefs.contains("token")) "Token tersimpan" else "Masukkan token"
            panel.addView(this)
        }
        button("Simpan koneksi") {
            try {
                val packages = mutableSetOf<String>()
                if (gopay.isChecked) packages.add("com.gojek.gopay")
                if (gojek.isChecked) packages.add("com.gojek.app")
                connection.save(endpoint.text.toString().trim(), secret.text.toString().trim(), packages)
                secret.text.clear(); secret.hint = "Token tersimpan"
                SendWorker.enqueue(this)
                refresh()
                Toast.makeText(this, "Koneksi tersimpan", Toast.LENGTH_SHORT).show()
            } catch (_: Exception) {
                Toast.makeText(this, "Periksa alamat HTTPS, token, dan pilihan aplikasi.", Toast.LENGTH_LONG).show()
            }
        }
        button("Kelola izin notifikasi") {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        status = label("")
        status.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        button("Coba kirim dan periksa antrean") { SendWorker.enqueue(this); refresh() }
        setContentView(scroll)
    }
    override fun onResume() { super.onResume(); refresh() }
    private fun refresh() {
        val allowed = getSystemService(NotificationManager::class.java)
            .isNotificationListenerAccessGranted(ComponentName(this, CaptureService::class.java))
        io.execute {
            val count = CaptureDatabase.get(applicationContext).outbox().count()
            val message = connection.prefs.getString("status", "Belum ada bukti terkirim")
            runOnUiThread { status.text = "Akses notifikasi " + (if (allowed) "aktif" else "belum aktif") +
                "\nAntrean: " + count + "\n" + message }
        }
    }
    override fun onDestroy() { io.shutdown(); super.onDestroy() }
}
