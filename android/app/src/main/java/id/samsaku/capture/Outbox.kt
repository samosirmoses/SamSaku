package id.samsaku.capture

import android.content.Context
import androidx.room.*

@Entity(tableName = "pending_events")
data class PendingEvent(@PrimaryKey val id: String, val postedAt: Long, val body: String, val sourcePackage: String)

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun put(event: PendingEvent)
    @Query("SELECT * FROM pending_events ORDER BY postedAt, id LIMIT 1")
    fun first(): PendingEvent?
    @Query("DELETE FROM pending_events WHERE id = :id")
    fun acknowledge(id: String)
    @Query("SELECT COUNT(*) FROM pending_events")
    fun count(): Int
}

@Database(entities = [PendingEvent::class], version = 1, exportSchema = false)
abstract class CaptureDatabase : RoomDatabase() {
    abstract fun outbox(): OutboxDao
    companion object {
        @Volatile private var instance: CaptureDatabase? = null
        fun get(context: Context): CaptureDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, CaptureDatabase::class.java, "capture.db").build()
                .also { instance = it }
        }
    }
}
