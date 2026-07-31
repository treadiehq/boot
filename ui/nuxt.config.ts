import { defineNuxtConfig } from "nuxt/config";
import tailwindcss from "@tailwindcss/vite";

/**
 * The `boot ui` launchpad — a static SPA served by the boot CLI itself
 * (`src/core/uiServer.ts`). `pnpm ui:build` generates `ui/.output/public`,
 * which `boot ui` serves from disk in a source checkout and release builds
 * embed into the binary.
 */
export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: false },
  telemetry: false,
  css: ["~/assets/css/main.css"],
  vite: {
    plugins: [tailwindcss()],
  },
  app: {
    head: {
      title: "Boot Launchpad",
      htmlAttrs: { lang: "en" },
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "color-scheme", content: "dark" },
        { name: "theme-color", content: "#09090b" },
      ],
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.ico" }],
    },
  },
  nitro: {
    // `pnpm ui:dev` proxies API calls to a locally running `boot ui` server.
    devProxy: {
      "/api": { target: "http://127.0.0.1:4400/api", changeOrigin: true },
    },
  },
  compatibilityDate: "2026-07-31",
});
