# ⚽ 321 BAĞLA!

İki kişilik online futbol bilgi oyunu: Her oyuncu gizlice bir takım seçer, takımlar açıklanınca **iki takımda da oynamış bir futbolcuyu ilk bilen** raundu kazanır.

## Özellikler

- 🔗 Link paylaşarak online eşleşme (WebSocket oda sistemi)
- 🕵️ Gizli takım seçimi — rakip, sen "Başlat" diyene kadar seçimini göremez
- ✅ Cevaplar Wikipedia'dan otomatik doğrulanır (oyuncunun kariyer kulüpleri üzerinden)
- 🎤 Sesli cevap (Web Speech API, Türkçe)
- ⚖️ API doğrulayamazsa karar rakibe sorulur; yanlış kararına itiraz hakkı vardır

## Çalıştırma

```bash
npm install
npm start
# http://localhost:3001
```

Evde aynı Wi-Fi'daki ikinci oyuncu için LAN linki, sesli giriş gerekiyorsa
kendinden imzalı sertifikalı `https://<ip>:3443` linki konsola yazılır.

Barındırma platformlarında (Render vb.) `PORT` ortam değişkeni otomatik
kullanılır, yerel HTTPS devre dışı kalır.
