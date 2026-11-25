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
  // Target ES2022+ (matching Tailwind v4 / CSS :has()) so esbuild does not lower ES2021 `||=`
  // inside @xterm/xterm@6.0.0's `requestMode`, which triggers an esbuild DCE bug (`ReferenceError`).
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  build: {
    target: "es2022",
    outDir: "../../dist/web",
    emptyOutDir: true,
    // Never inline fonts as `data:` URIs: Jarvy serves a strict `default-src 'self'` CSP with no `font-src data:`.
    assetsInlineLimit: filePath => (/\.(woff2?|ttf|otf)$/i.test(filePath) ? false : undefined),
  },
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
