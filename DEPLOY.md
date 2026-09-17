# Deploy PILKETOS ke Vercel + Supabase

Project ini sudah disiapkan untuk arsitektur berikut:

- **Frontend statis:** folder `public/`, dilayani CDN Vercel
- **Backend:** Express (`server.js`) sebagai Vercel Function
- **Database:** Supabase PostgreSQL
- **Upload gambar:** Supabase Storage bucket `pilketos-assets`
- **Vote token:** signed HMAC token, tidak bergantung pada RAM instance

## 1. Setup Supabase

### Buat project

Buat project baru di Supabase. Untuk latency yang lebih rendah, pilih region yang dekat dengan pengguna aplikasi jika tersedia.

### Jalankan schema

Buka **SQL Editor** di Supabase lalu jalankan seluruh isi:

```text
supabase_schema.sql
```

Schema ini akan membuat tabel, index, fungsi transaksi voting, RLS, serta public Storage bucket `pilketos-assets`.

### Ambil server key

Dari Supabase Dashboard, ambil:

```text
SUPABASE_URL
SUPABASE_SECRET_KEY
```

Gunakan **Secret key** (`sb_secret_...`) untuk backend. Jangan memakai publishable key untuk server admin ini. Legacy `service_role` masih didukung kode untuk kompatibilitas, tetapi Secret key adalah konfigurasi utama.

## 2. Buat environment variables

Untuk local development:

```powershell
Copy-Item .env.example .env
```

Lalu isi `.env`:

```env
ADMIN_PASSWORD=...
VOTE_TOKEN_SECRET=...
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_STORAGE_BUCKET=pilketos-assets
```

Generate `VOTE_TOKEN_SECRET` acak:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Jangan commit `.env`.

## 3. Jika ingin membawa data SQLite lama

Langkah ini **opsional**. Jalankan dari project lokal yang masih memiliki:

```text
database/pilketos.db
```

Generate SQL migrasi privat:

```powershell
npm run migrate:sqlite
```

Output:

```text
migration/private_supabase_data.sql
```

File tersebut berisi data privat dan otomatis diabaikan Git/Vercel. Buka file itu secara lokal, lalu jalankan isinya di Supabase SQL Editor **setelah `supabase_schema.sql`**.

Catatan: URL gambar lama `/uploads/...` sengaja tidak dimigrasikan karena file lokal tidak tersedia di Vercel. Upload ulang hero/foto paslon dari halaman admin setelah deploy.

## 4. Test local

Install dependency:

```powershell
npm ci
```

Cek syntax:

```powershell
npm run check
```

Jalankan server:

```powershell
npm start
```

Buka:

```text
http://localhost:3000
http://localhost:3000/admin.html
```

Tes minimal sebelum deploy:

- halaman utama terbuka
- admin login berhasil
- tambah/edit paslon berhasil
- upload hero/foto menghasilkan URL Supabase Storage
- generate kode pemilih berhasil
- verify kode berhasil saat status `OPEN`
- voting satu kali berhasil dan kode yang sama ditolak pada percobaan kedua
- hasil admin terbaca

## 5. Deploy ke Vercel

Push source code ke GitHub. Folder/file privat berikut sudah diabaikan:

```text
.env
node_modules/
database/
backup/
migration/private_supabase_data.sql
```

Di Vercel:

1. **Add New → Project**
2. Import repository PILKETOS
3. Framework dapat dibiarkan terdeteksi sebagai Express/Other
4. Root Directory: root repository
5. Tambahkan Environment Variables berikut untuk **Production** dan, bila diperlukan, **Preview**:

```text
ADMIN_PASSWORD
VOTE_TOKEN_SECRET
SUPABASE_URL
SUPABASE_SECRET_KEY
SUPABASE_STORAGE_BUCKET
```

`SUPABASE_STORAGE_BUCKET` isi dengan:

```text
pilketos-assets
```

6. Deploy.

Vercel dapat mendeteksi `server.js` sebagai Express app karena file tersebut mengekspor `app`. File pada `public/` disajikan sebagai static assets.

## 6. Verifikasi production

Setelah deploy, cek:

```text
https://DOMAIN/
https://DOMAIN/admin.html
https://DOMAIN/vote.html
https://DOMAIN/results.html
```

Kemudian lakukan smoke test:

1. Login admin.
2. Upload satu gambar test.
3. Pastikan URL gambar mengarah ke `/storage/v1/object/public/pilketos-assets/...` di domain Supabase.
4. Buat kode voter test.
5. Ubah election ke `READY`, lalu `OPEN`.
6. Vote menggunakan kode test.
7. Coba vote ulang memakai kode yang sama dan pastikan ditolak.
8. Tutup election dan cek hasil.

## Perubahan penting dari versi SQLite/local

- `better-sqlite3` sudah dihapus, sehingga tidak ada lagi proses compile `node-gyp`.
- Semua data runtime berada di Supabase PostgreSQL.
- Hero image/foto kandidat tidak ditulis ke filesystem Vercel, tetapi ke Supabase Storage.
- Vote token tidak disimpan dalam `Map` RAM, sehingga tetap valid saat request berpindah instance serverless.
- `cast_vote`, archive/clear, dan restore menggunakan fungsi PostgreSQL untuk operasi yang perlu atomik.

## Catatan rate limiting

Rate limiter login/verify yang ada saat ini masih bersifat **best effort per instance**. Validasi password, signed vote token, dan proteksi satu-kode-satu-suara tetap berjalan di database, tetapi jika aplikasi nanti digunakan dengan traffic besar, pindahkan rate limit ke layanan/shared store atau gunakan proteksi Vercel Firewall.
