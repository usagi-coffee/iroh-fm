import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

const base = /** @type {'' | `/${string}`} */ (process.env.BASE_PATH ?? "");
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const buildVersion = process.env.GITHUB_SHA ?? localCommit();
const commitHash = buildVersion.slice(0, 12);
const desktopEpochCommit =
  process.env.DESKTOP_EPOCH_COMMIT ??
  git(["log", "--format=%H", "--grep=^desktop:", "-1"]) ??
  commitHash;
const desktopEpoch = Number(
  process.env.DESKTOP_EPOCH ?? git(["rev-list", "--count", desktopEpochCommit]) ?? 0,
);
const androidEpochCommit =
  process.env.ANDROID_EPOCH_COMMIT ??
  git(["log", "--format=%H", "--grep=^android:", "-1"]) ??
  commitHash;
const androidEpoch = Number(
  process.env.ANDROID_EPOCH ?? git(["rev-list", "--count", androidEpochCommit]) ?? 0,
);

if (!Number.isSafeInteger(desktopEpoch) || desktopEpoch <= 0)
  throw new Error("The desktop epoch is invalid.");
if (!Number.isSafeInteger(androidEpoch) || androidEpoch <= 0)
  throw new Error("The Android epoch is invalid.");

/** @param {string[]} args */
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function localCommit() {
  return git(["rev-parse", "HEAD"]) ?? "development";
}

export default defineConfig(({ mode }) => ({
  resolve: e2eAliases(mode),
  define: {
    __BUILD_COMMIT__: JSON.stringify(commitHash),
    __BUILD_VERSION__: JSON.stringify(buildVersion),
    __DESKTOP_EPOCH__: JSON.stringify(desktopEpoch),
    __DESKTOP_EPOCH_COMMIT__: JSON.stringify(desktopEpochCommit),
    __ANDROID_EPOCH__: JSON.stringify(androidEpoch),
    __ANDROID_EPOCH_COMMIT__: JSON.stringify(androidEpochCommit),
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
      serviceWorker: {
        register: false,
      },
      version: {
        name: buildVersion,
      },
    }),
    tailwindcss(),
    icons({ compiler: "svelte" }),
  ],
  server: {
    fs: {
      allow: [workspaceRoot],
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));

/** @param {string} mode */
function e2eAliases(mode) {
  const target = /^e2e-(web|desktop|android)$/.exec(mode)?.[1];
  if (!target) return undefined;
  return {
    alias: {
      "@iroh-fm/client/core": fileURLToPath(
        new URL(`./e2e/${target}/client-core.js`, import.meta.url),
      ),
    },
  };
}
