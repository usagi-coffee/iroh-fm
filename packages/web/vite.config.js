import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const base = /** @type {'' | `/${string}`} */ (process.env.BASE_PATH ?? "");
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
        experimental: {
          async: true,
        },
      },

      adapter: adapter({ fallback: "index.html" }),
      paths: {
        base,
      },
    }),
  ],
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
});
