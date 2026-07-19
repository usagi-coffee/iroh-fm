import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

const base = /** @type {'' | `/${string}`} */ (process.env.BASE_PATH ?? "");
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const commitHash = (process.env.GITHUB_SHA ?? "development").slice(0, 12);
const buildVersion = process.env.GITHUB_SHA ?? String(Date.now());

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(commitHash),
    __BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  plugins: [
    sveltekit({
      vitePlugin: {
        inspector: {
          toggleKeyCombo: "control-shift",
          holdMode: true,
        },
      },
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
    tailwindcss(),
    icons({ compiler: "svelte" }),
  ],
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
});
