import { copyFile, readFile } from "node:fs/promises";

const build = new URL("../build/", import.meta.url);
const metadata = JSON.parse(await readFile(new URL("_app/version.json", build), "utf8"));
const version = String(metadata.version ?? "");

if (!/^[a-zA-Z0-9._-]+$/.test(version)) {
  throw new Error("The generated web version cannot be used in a service-worker filename.");
}

await copyFile(new URL("service-worker.js", build), new URL(`service-worker-${version}.js`, build));
