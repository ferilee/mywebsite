## **🏗️ Alur Arsitektur Aplikasi**

Alur aplikasi ini dirancang untuk kecepatan pengembangan dan performa runtime yang ringan:

1. **Frontend & Routing (Hono \+ React/JSX):** Hono bertindak sebagai server-side router. Anda bisa menggunakan middleware Hono untuk melayani file statis atau merender komponen React/JSX secara langsung dari sisi server (*Server-Side Rendering*).  
2. **Styling (Tailwind CSS \+ ShadcnUI):** Antarmuka dibangun menggunakan komponen ShadcnUI yang berbasis Tailwind. Komponen ini memberikan kontrol penuh atas desain tanpa membebani ukuran bundle.  
3. **Data Layer (Drizzle ORM \+ SQLite):** Drizzle akan mengelola skema database dan query dengan pendekatan *type-safe*. SQLite digunakan sebagai database file yang sangat ringan dan cocok untuk blog personal.  
4. **Deployment (Docker \+ Bun):** Seluruh aplikasi dibungkus ke dalam Docker container. Bun akan menjalankan server Hono dengan efisiensi memori yang lebih baik dibanding Node.js.

## ---

**✨ Fitur-Fitur Utama**

### **1\. Portofolio Showcase**

* **Project Gallery:** Menampilkan daftar proyek dengan kartu visual, deskripsi singkat, dan *tech stack* yang digunakan.  
* **Skill Badges:** Visualisasi keahlian teknis menggunakan komponen *Badge* dari ShadcnUI.  
* **Experience Timeline:** Riwayat karir atau pendidikan yang disusun secara kronologis.

### **2\. Blog Engine**

* **Markdown/MDX Support:** Menulis artikel blog menggunakan Markdown agar mudah diformat.  
* **Dynamic Routing:** Halaman blog yang dibuat secara dinamis berdasarkan slug artikel di database.  
* **Search & Filter:** Fitur untuk mencari judul artikel atau memfilter berdasarkan kategori/tag.

### **3\. Admin Dashboard (CMS Internal)**

* **Content Management:** Antarmuka khusus (terproteksi auth sederhana) untuk menambah, mengedit, atau menghapus artikel blog dan item portofolio tanpa menyentuh database secara manual.  
* **Draft System:** Kemampuan untuk menyimpan tulisan sebagai draf sebelum dipublikasikan.

### **4\. Kontak & Sosial**

* **Contact Form:** Formulir kontak yang terintegrasi dengan validasi input (menggunakan Zod).  
* **Social Link Integration:** Tautan cepat ke GitHub, LinkedIn, atau platform lainnya.

## ---

**🛠️ Ringkasan Struktur Folder (Dockerized)**

Dalam container Docker Anda, strukturnya akan terlihat kurang lebih seperti ini:

| Folder/File | Fungsi |
| :---- | :---- |
| src/db/ | Skema Drizzle dan konfigurasi koneksi SQLite. |
| src/routes/ | Endpoint API dan routing halaman menggunakan Hono. |
| src/components/ | Komponen UI dari ShadcnUI dan komponen kustom. |
| public/ | Aset statis seperti gambar dan file CSS hasil build Tailwind. |
| Dockerfile | Instruksi untuk build image menggunakan oven/bun sebagai base image. |
| docker-compose.yml | Mengatur volume untuk persistensi file SQLite (.db). |

---

Apakah Anda ingin saya buatkan draf kode awal untuk Dockerfile atau konfigurasi drizzle.config.ts agar bisa langsung dieksekusi di Bun?