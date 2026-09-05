/** @type {import('tailwindcss').Config} */
module.exports = {
  // Tailwind scan file-file ini buat cari class utility apa saja yang benar-benar
  // dipakai (termasuk yang ditulis di dalam template string script.js, misal
  // renderCatalog() yang generate HTML lewat JavaScript). Class yang tidak
  // ditemukan di sini TIDAK akan ikut masuk ke dist/tailwind.css (di-purge).
  content: [
    "./index.html",
    "./script.js"
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
