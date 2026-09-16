# Keamanan RustFS untuk Media Website

Dokumen ini menjelaskan konfigurasi bucket `ferilee-media` agar:

- gambar dapat dibaca publik oleh browser;
- upload dan delete dilakukan melalui kredensial khusus aplikasi;
- Console RustFS tidak terbuka bebas ke internet;
- kredensial root RustFS tidak digunakan oleh aplikasi.

## Arsitektur akses

```text
Pengunjung
   │ GET gambar
   ▼
rustfs.ferilee.gurumuda.eu.org ── NPM ── rustfs:9000
                                      │
                                      ▼
                              bucket ferilee-media

mywebsite ── http://rustfs:9000 ──► RustFS S3 API
   │
   └── menggunakan access key khusus ferilee-web

Administrator ── HTTPS + Access List NPM ──► rustfs-console... ──► rustfs:9001
```

RustFS menggunakan port `9000` untuk S3 API dan port `9001` untuk Console.

## 1. Pastikan network Docker sama

RustFS dan `mywebsite` harus berada pada external network yang sama, yaitu
`ferileenet`.

Compose RustFS:

```yaml
services:
  rustfs:
    image: rustfs/rustfs:latest
    container_name: rustfs
    restart: unless-stopped
    command: /data
    environment:
      RUSTFS_ACCESS_KEY: ${RUSTFS_ACCESS_KEY}
      RUSTFS_SECRET_KEY: ${RUSTFS_SECRET_KEY}
      RUSTFS_CONSOLE_ENABLE: "true"
    volumes:
      - /srv/data/rustfs/data:/data
    networks:
      - ferileenet

networks:
  ferileenet:
    external: true
```

Compose aplikasi juga harus menggunakan network yang sama:

```yaml
services:
  mywebsite:
    networks:
      - ferileenet

networks:
  ferileenet:
    external: true
```

Verifikasi:

```bash
docker exec mywebsite getent hosts rustfs

docker exec mywebsite bun -e '
fetch("http://rustfs:9000/health/ready")
  .then(async r => console.log(r.status, await r.text()))
'
```

Hasil yang diharapkan adalah hostname `rustfs` berhasil di-resolve dan status
health `200`.

## 2. Buat bucket media

Di RustFS Console:

1. Buka menu **Browser** atau **Buckets**.
2. Buat bucket bernama `ferilee-media`.
3. Atur **Access Policy** menjadi **Public**.

Status `Public` digunakan agar browser dapat melakukan `GET` atau download
gambar tanpa mengirim access key. Public tidak berarti pengunjung boleh upload
atau delete, selama tidak ada policy anonymous yang memberikan izin tersebut.

Bucket ini hanya boleh berisi media publik website, seperti:

- cover kegiatan;
- foto dokumentasi kegiatan;
- thumbnail publik.

> Jangan menyimpan sertifikat pribadi, backup database, atau file rahasia pada
> bucket publik.

## 3. Buat policy khusus aplikasi

Buka menu **Policies → Create Policy**.

Nama policy:

```text
ferilee-media-app
```

Gunakan policy berikut:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::ferilee-media"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::ferilee-media/*"
      ]
    }
  ]
}
```

Policy ini memberikan aplikasi kemampuan untuk:

- membaca objek;
- mengunggah objek;
- menghapus objek;
- melihat isi bucket.

Policy tidak memberikan akses administrasi RustFS atau akses ke bucket lain.

## 4. Buat user dan access key aplikasi

Di RustFS Console:

1. Buka **Users → Add User**.
2. Buat user:

   ```text
   ferilee-web
   ```

3. Pasang policy `ferilee-media-app`.
4. Buka **Access Keys → Create Access Key** untuk user tersebut.
5. Simpan access key dan secret key di password manager.

Gunakan access key khusus ini untuk `mywebsite`. Jangan gunakan nilai root
`RUSTFS_ACCESS_KEY` dan `RUSTFS_SECRET_KEY` untuk aplikasi.

## 5. Konfigurasi environment `mywebsite`

Masukkan pada environment project `mywebsite` di Arcane:

```env
S3_ENDPOINT=http://rustfs:9000
S3_REGION=us-east-1
S3_BUCKET=ferilee-media
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY=access_key_milik_ferilee_web
S3_SECRET_KEY=secret_key_milik_ferilee_web
S3_PUBLIC_BASE_URL=https://rustfs.ferilee.gurumuda.eu.org
```

Perbedaan endpoint:

```text
S3_ENDPOINT        koneksi internal antarkontainer
S3_PUBLIC_BASE_URL URL yang digunakan browser pengunjung
```

Jangan commit nilai access key atau secret key ke GitHub.

## 6. Proxy media melalui NPM

Buat Proxy Host untuk S3 API/media:

```text
Domain Names: rustfs.ferilee.gurumuda.eu.org
Scheme: http
Forward Hostname / IP: rustfs
Forward Port: 9000
Access List: Publicly Accessible
```

Pada tab SSL:

- Request a new SSL Certificate;
- Force SSL;
- HTTP/2 Support;
- Agree to Let’s Encrypt Terms.

Domain media harus diarahkan ke port `9000`, bukan `9001`.

Setelah upload, URL objek akan berbentuk seperti:

```text
https://rustfs.ferilee.gurumuda.eu.org/ferilee-media/activity-gallery/nama-file.webp
```

## 7. Lindungi Console RustFS melalui NPM

Jangan menggunakan domain media untuk Console. Buat domain terpisah, misalnya:

```text
rustfs-console.ferilee.gurumuda.eu.org
```

Di NPM, buat Proxy Host:

```text
Domain Names: rustfs-console.ferilee.gurumuda.eu.org
Scheme: http
Forward Hostname / IP: rustfs
Forward Port: 9001
```

Pada **Access List** NPM:

1. Buka **Access Lists → Add Access List**.
2. Buat access list, misalnya `RustFS Admin`.
3. Tambahkan username/password NPM atau batasi berdasarkan IP administrator.
4. Edit Proxy Host `rustfs-console...`.
5. Pilih Access List `RustFS Admin`, bukan `Publicly Accessible`.
6. Konfigurasikan SSL seperti domain lainnya.

Dengan demikian administrator melewati dua lapis perlindungan:

1. Access List NPM;
2. Login RustFS Console.

> Uji akses menggunakan browser kedua sebelum menutup sesi administrator agar
> tidak mengunci diri sendiri dari Console.

## 8. Verifikasi akhir

### Verifikasi API RustFS melalui domain publik

```bash
curl -i https://rustfs.ferilee.gurumuda.eu.org/health/ready
```

Expected status:

```text
HTTP/2 200
```

### Verifikasi environment aplikasi tanpa membocorkan secret

```bash
docker exec mywebsite sh -c '
printf "S3_ENDPOINT=%s\nS3_BUCKET=%s\nS3_PUBLIC_BASE_URL=%s\n" \
  "$S3_ENDPOINT" "$S3_BUCKET" "$S3_PUBLIC_BASE_URL"
printf "S3_ACCESS_KEY=%s\nS3_SECRET_KEY=%s\n" \
  "${S3_ACCESS_KEY:+set}" "${S3_SECRET_KEY:+set}"
'
```

### Verifikasi dari website

1. Buka `/admin/activities/new`.
2. Upload satu atau beberapa foto melalui **Upload Gallery Photos to RustFS**.
3. Isi **Google Photos Album URL** bila ingin menyertakan album eksternal.
4. Simpan kegiatan.
5. Buka halaman detail kegiatan publik.
6. Pastikan foto tampil dan tombol **Lihat Album Lengkap** tersedia.

## 9. Rotasi kredensial aplikasi

Jika access key aplikasi bocor:

1. Buat access key baru untuk user `ferilee-web`, atau buat user baru.
2. Perbarui `S3_ACCESS_KEY` dan `S3_SECRET_KEY` pada project `mywebsite`.
3. Redeploy atau restart `mywebsite`.
4. Uji upload baru.
5. Nonaktifkan atau hapus access key lama.

> Jangan mengganti kredensial root RustFS secara rutin tanpa memperbarui compose
> dan rencana pemulihan akses Console.

## Rujukan

- [RustFS Quick Start](https://docs.rustfs.com/en/installation/linux/quick-start)
- [RustFS Users, Groups, and Policies](https://docs.rustfs.com/en/security-compliance/iam/policies)
- [RustFS Status Check](https://docs.rustfs.com/en/operations/status-check)
