package id.samsaku.capture

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.URI
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class Connection(context: Context) {
    val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    private val alias = "samsaku-connector"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    fun save(url: String, token: String, packages: Set<String>) {
        val uri = URI(url)
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null)
        require(packages.isNotEmpty())
        val update = prefs.edit().putString("url", url.trimEnd('/')).putStringSet("packages", packages)
        if (token.isNotBlank()) {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
            update.putString("token", Base64.encodeToString(cipher.doFinal(token.toByteArray()), Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        } else {
            require(prefs.contains("token") && prefs.getString("url", "") == url.trimEnd('/'))
        }
        update.apply()
    }
    fun token(): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val iv = Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(Base64.decode(prefs.getString("token", ""), Base64.NO_WRAP)), Charsets.UTF_8)
    }
}
