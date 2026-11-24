Write-Host "Membuka HTTPS Tunnel publik ke SamSaku API (port 18000) menggunakan Cloudflare Quick Tunnel via Docker..." -ForegroundColor Cyan
Write-Host "Salin URL 'https://xxxx.trycloudflare.com' yang muncul di bawah ini:" -ForegroundColor Yellow
docker run --rm --network samsaku_default cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://api:8000
