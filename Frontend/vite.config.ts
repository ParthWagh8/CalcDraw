import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "VITE_")
  const port = Number(env.VITE_PORT || 5173)
  return {
    plugins: [react()],
    server: {
      host: true,
      port,
      strictPort: true,
    },
    preview: {
      host: true,
      port,
      strictPort: true,
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  }
})
