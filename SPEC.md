# Spesifikasi SamSaku

SamSaku mencatat keuangan satu pemilik dalam rupiah. Pemilik memakai PWA yang sama di HP, tablet, dan laptop. APK Android hanya bertugas meneruskan notifikasi transaksi dari sumber yang dipilih.

## Pembukuan

- Satu transaksi memiliki satu atau beberapa perubahan saldo dan rincian nominal per kategori. Pendapatan dan pengeluaran dapat memakai kategori buatan pengguna. Jumlah rincian harus sama dengan nominal transaksi.
- Transfer Rp100.000 dengan biaya Rp1.000 menghasilkan entri asal −Rp101.000 dan tujuan +Rp100.000. Pengeluaran dalam laporan bertambah Rp1.000. Refund terkait transaksi asal menurunkan pengeluaran pada periode pengembalian.
- Saldo pembuka berlaku pada awal tanggal acuan per dompet. Bukti sebelum tanggal tersebut tetap masuk laporan historis. Saldo berjalan menghitung perubahan pada dan setelah tanggal acuan.
- Waktu laporan menggunakan Asia/Jakarta. Nominal disimpan sebagai rupiah bulat dengan perhitungan eksak.

## Bukti, impor, dan alokasi

- Bukti dari Gmail, GoPay, Telegram, atau foto melewati parser. Pencatatan otomatis memerlukan aturan sukses yang teruji, identitas sumber dan referensi yang memadai. Bukti ambigu menunggu tinjauan. Kemiripan nominal dan tanggal menjadi saran pencocokan.
- Impor Excel menyediakan template dan pemetaan workbook sendiri, pratinjau perubahan, perlakuan duplikat, dan persetujuan sebelum publikasi. Satu batch yang disetujui dipublikasikan secara atomik. Transaksi, dompet, kategori, merchant/alias, dan definisi skema/pos menggunakan aturan yang sama dengan input aplikasi.
- Skema mengalokasikan pemasukan yang belum digunakan, dibatasi saldo bebas dompet terverifikasi. Aturan tetap berlaku per siklus, persentase dihitung dari basis yang terlihat, dan satu pos dapat menerima sisa. Persetujuan menyimpan snapshot aturan. Alokasi ke target mencadangkan uang satu kali dan tidak membuat pergerakan saldo bank.

## Antarmuka

Ringkasan menampilkan pengeluaran dan kategori terbesar dengan akses ke rincian. Transaksi memberi akses ke dompet, sumber dan kategori. Laporan menyediakan pratinjau serta unduhan PDF dan CSV untuk periode yang sama. Palet utama menggunakan gading dan hijau tua, dengan aksen kuningan. Contoh data untuk pengunjung ditandai sebagai demo; tindakan pencatatan memerlukan sesi pemilik.

API terautentikasi memiliki awalan `/v1`. Kontrak parameter dan respons tersedia melalui OpenAPI pada backend yang berjalan. Supabase mengelola identitas, FastAPI membatasi akses ke pemilik, PostgreSQL menyimpan buku kas, dan bucket privat menampung file sementara.

## Uji penerimaan dan pengembangan berikutnya

Periksa satu pembayaran BCA dari bukti sampai PDF, kirim ulang bukti yang sama, impor satu periode sebelum saldo acuan, alokasikan gaji yang sebagian sudah terpakai, serta uji satu struk dengan total dan kembalian. Uji perangkat nyata dan pemulihan database sebelum menjadikan buku kas ini catatan utama.

Tagihan berulang, cicilan, paylater, proyeksi arus kas, aset, investasi, dan kekayaan bersih merupakan pengembangan berikutnya. Modul tersebut harus menggunakan buku kas dan kepemilikan data yang sudah ada. Pisahkan peristiwa terjadwal dari transaksi terkonfirmasi, dan pisahkan perubahan harga aset dari belanja bulanan.
