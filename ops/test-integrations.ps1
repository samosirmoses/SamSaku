param(
    [Parameter(Position = 0)]
    [ValidateSet("all", "seed-masters", "telegram-save", "telegram-draft", "bca-auto", "bca-review", "gopay-auto")]
    [string]$Scenario = "all"
)

$ErrorActionPreference = "Stop"
$ApiBase = "http://localhost:18000/v1"
$DevHeaders = @{ "X-Dev-Token" = "992970593fbd52e7ff63907364a3fbe22a8cbf8a84d14daa1b6a1421b3d32b2f" }
$TgHeaders = @{ "X-Telegram-Bot-Api-Secret-Token" = "tg-webhook-secret-2026" }
$BcaHeaders = @{ "Authorization" = "Bearer bca-local-token-2026" }
$GopayHeaders = @{ "Authorization" = "Bearer gopay-local-token-2026" }
$TodaySlash = (Get-Date).ToString("dd/MM/yyyy")
$UnixNow = [int][double]::Parse((Get-Date -UFormat %s))

function Ensure-Masters {
    Write-Host "`n[1] Memastikan Dompet (BCA, GOPAY, CASH) & Kategori tersedia di Server..." -ForegroundColor Cyan
    $existingAcc = Invoke-RestMethod -Uri "$ApiBase/accounts" -Headers $DevHeaders -Method Get
    $codes = @($existingAcc | ForEach-Object { $_.code })
    foreach ($w in @(
        @{ code = "BCA"; name = "myBCA"; kind = "bank"; opening_date = "2026-01-01"; opening_balance = 8000000 },
        @{ code = "GOPAY"; name = "GoPay"; kind = "ewallet"; opening_date = "2026-01-01"; opening_balance = 1000000 },
        @{ code = "CASH"; name = "Tunai"; kind = "cash"; opening_date = "2026-01-01"; opening_balance = 500000 }
    )) {
        if ($codes -notcontains $w.code) {
            Invoke-RestMethod -Uri "$ApiBase/accounts" -Headers $DevHeaders -Method Post -ContentType "application/json" -Body ($w | ConvertTo-Json) | Out-Null
            Write-Host "  + Dompet dibuat: $($w.name) ($($w.code))" -ForegroundColor Green
        }
    }

    $existingCat = Invoke-RestMethod -Uri "$ApiBase/categories" -Headers $DevHeaders -Method Get
    $catCodes = @($existingCat | ForEach-Object { $_.code })
    foreach ($c in @(
        @{ code = "FOOD"; name = "Makan & minum"; kind = "expense" },
        @{ code = "SHOP"; name = "Belanja"; kind = "expense" },
        @{ code = "TRANS"; name = "Transportasi"; kind = "expense" },
        @{ code = "BILLS"; name = "Tagihan"; kind = "expense" },
        @{ code = "SALARY"; name = "Gaji"; kind = "income" }
    )) {
        if ($catCodes -notcontains $c.code) {
            Invoke-RestMethod -Uri "$ApiBase/categories" -Headers $DevHeaders -Method Post -ContentType "application/json" -Body ($c | ConvertTo-Json) | Out-Null
            Write-Host "  + Kategori dibuat: $($c.name)" -ForegroundColor Green
        }
    }
}

function Test-TelegramSave {
    Write-Host "`n[2] Simulasi Telegram Webhook: Kirim pesan 'kopi kenangan 35k gopay' lalu klik tombol [Simpan]..." -ForegroundColor Cyan
    $updId = Get-Random -Minimum 10000 -Maximum 99999
    $msgBody = @{
        update_id = $updId
        message = @{
            date = $UnixNow
            from = @{ id = 123456789 }
            chat = @{ id = 123456789; type = "private" }
            text = "kopi kenangan 35k gopay"
        }
    } | ConvertTo-Json -Depth 6

    $reply = Invoke-RestMethod -Uri "$ApiBase/webhooks/telegram" -Headers $TgHeaders -Method Post -ContentType "application/json" -Body $msgBody
    Write-Host "  Balasan Bot Telegram: $($reply.text)" -ForegroundColor Yellow
    $btn = $reply.reply_markup.inline_keyboard[0][0]
    Write-Host "  Tombol Inline muncul: [$($btn.text)] (callback: $($btn.callback_data))" -ForegroundColor Green

    $cbBody = @{
        callback_query = @{
            id = "cb-$updId"
            from = @{ id = 123456789 }
            message = @{ message_id = 501; chat = @{ id = 123456789; type = "private" } }
            data = $btn.callback_data
        }
    } | ConvertTo-Json -Depth 6

    $cbReply = Invoke-RestMethod -Uri "$ApiBase/webhooks/telegram" -Headers $TgHeaders -Method Post -ContentType "application/json" -Body $cbBody
    Write-Host "  Hasil klik [Simpan]: $($cbReply.text)" -ForegroundColor Green
}

function Test-TelegramDraft {
    Write-Host "`n[3] Simulasi Telegram Webhook (Tanpa Nama Dompet): 'makan siang nasi padang 48k' -> Masuk menu Perlu Ditinjau..." -ForegroundColor Cyan
    $updId = Get-Random -Minimum 100000 -Maximum 999999
    $msgBody = @{
        update_id = $updId
        message = @{
            date = $UnixNow
            from = @{ id = 123456789 }
            chat = @{ id = 123456789; type = "private" }
            text = "makan siang nasi padang 48k"
        }
    } | ConvertTo-Json -Depth 6

    $reply = Invoke-RestMethod -Uri "$ApiBase/webhooks/telegram" -Headers $TgHeaders -Method Post -ContentType "application/json" -Body $msgBody
    Write-Host "  Balasan Bot Telegram:`n$($reply.text)" -ForegroundColor Yellow
}

function Test-BcaAuto {
    Write-Host "`n[4] Simulasi Konektor Email myBCA Asli (QRIS Mie ayam Risky/anggun IDR 32,000.00 -> Otomatis Tercatat ke myBCA)..." -ForegroundColor Cyan
    $ref = "9527120261124200842751QRS" + (Get-Random -Minimum 100000 -Maximum 999999)
    $emailText = @"
Hai MOSES MARZUKI SAMOSIR,
Anda baru saja melakukan transaksi dengan menggunakan fasilitas myBCA.
Berikut ini adalah detail transaksi Anda :

Status	:	Berhasil
Tanggal Transaksi	:	24 Nov 2026 20:08:45
Jenis Transaksi	:	Pembayaran QRIS
Pembayaran Ke	:	Mie ayam Risky/anggun
Lokasi Merchant	:	0204, 21258, ID
Pengakuisisi	:	DANA
Merchant PAN	:	9360091530004799172
Terminal ID	:	000479917
Sumber Dana	:	TAHAPAN XPRESI - 8832****73
Customer PAN	:	9360001410282260446
Total Bayar	:	IDR 32,000.00
RRN	:	174928638
Nomor Referensi	:	$ref
Mohon simpan email ini sebagai referensi transaksi Anda.
"@
    $payload = @{
        external_id = "gmail-msg-$ref"
        text = $emailText
        occurred_at = (Get-Date).ToString("o")
        metadata = @{ subject = "Internet Transaction Journal" }
    } | ConvertTo-Json -Depth 4

    $res = Invoke-RestMethod -Uri "$ApiBase/events/bca" -Headers $BcaHeaders -Method Post -ContentType "application/json" -Body $payload
    Write-Host "  Status Event myBCA: $($res.status) | Transaction ID: $($res.transaction_id) | Merchant: $($res.parsed.description) | Nominal: Rp$($res.parsed.amount)" -ForegroundColor Green
}

function Test-BcaReview {
    Write-Host "`n[5] Simulasi Konektor Email myBCA (Format Baru/Ambigu -> Masuk ke Menu 'Perlu Ditinjau')..." -ForegroundColor Cyan
    $id = Get-Random -Minimum 100000 -Maximum 999999
    $emailText = "Informasi Transaksi myBCA: Anda telah melakukan pembayaran sebesar Rp 145.000 di Gramedia Grand Indonesia pada $TodaySlash."
    $payload = @{
        external_id = "gmail-review-$id"
        text = $emailText
        occurred_at = (Get-Date).ToString("o")
    } | ConvertTo-Json -Depth 4

    $res = Invoke-RestMethod -Uri "$ApiBase/events/bca" -Headers $BcaHeaders -Method Post -ContentType "application/json" -Body $payload
    Write-Host "  Status Event myBCA: $($res.status) | Event ID: $($res.id) (Silakan cek di menu 'Perlu ditinjau')" -ForegroundColor Yellow
}

function Test-GopayAuto {
    Write-Host "`n[6] Simulasi Konektor Android GoPay Notification -> Otomatis Tercatat..." -ForegroundColor Cyan
    $ref = "GP" + (Get-Random -Minimum 100000 -Maximum 999999)
    $payload = @{
        external_id = "gopay-$ref"
        text = "Pembayaran Rp28.000 di GoRide Transport berhasil. ID: $ref"
        occurred_at = (Get-Date).ToString("o")
    } | ConvertTo-Json -Depth 4

    $res = Invoke-RestMethod -Uri "$ApiBase/events/gopay" -Headers $GopayHeaders -Method Post -ContentType "application/json" -Body $payload
    Write-Host "  Status Event GoPay: $($res.status) | Transaction ID: $($res.transaction_id)" -ForegroundColor Green
}

Ensure-Masters
switch ($Scenario) {
    "seed-masters" { }
    "telegram-save" { Test-TelegramSave }
    "telegram-draft" { Test-TelegramDraft }
    "bca-auto" { Test-BcaAuto }
    "bca-review" { Test-BcaReview }
    "gopay-auto" { Test-GopayAuto }
    "all" {
        Test-TelegramSave
        Test-TelegramDraft
        Test-BcaAuto
        Test-BcaReview
        Test-GopayAuto
    }
}
Write-Host "`nSelesai! Silakan segarkan dashboard http://localhost:3000 untuk melihat hasilnya." -ForegroundColor Cyan
