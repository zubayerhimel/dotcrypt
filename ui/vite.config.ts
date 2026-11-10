import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
// In dev, run `dotcrypt ui --port 4600 --no-open` in a project, then
// `VAULT_API_PORT=4600 npm run dev` and open http://localhost:5173/?token=<token>.
const apiPort = process.env.VAULT_API_PORT ?? "4600"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        // The API rejects foreign origins; the dev proxy is same-machine, so drop the browser's origin.
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => {
            req.removeHeader("origin")
            req.removeHeader("sec-fetch-site")
          })
        },
      },
    },
  },
})
