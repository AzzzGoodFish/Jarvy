import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./src/web/", import.meta.url));
const webPort = Number(process.env.JARVY_WEB_PORT || 5173);
const apiPort = Number(process.env.JARVY_API_PORT || 8080);
export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src/web/", import.meta.url)) } },
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    host: process.env.JARVY_WEB_HOST || "127.0.0.1", port: webPort, strictPort: true,
    // Match the API path segment, not frontend modules such as /api.ts.
    proxy: { "/api/": {
      target: `http://127.0.0.1:${apiPort}`,
      configure(proxy) {
        // Preserve the browser-facing Host so the backend's Origin guard accepts
        // requests arriving through the dev server's LAN address.
        proxy.on("proxyReq", (forwarded, request) => {
          if (request.headers.host) forwarded.setHeader("Host", request.headers.host);
        });
      },
    } },
  },
});
