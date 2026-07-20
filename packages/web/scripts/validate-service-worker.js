import { readFile, readdir } from "node:fs/promises";

const build = new URL("../build/", import.meta.url);
const version = String(
  JSON.parse(await readFile(new URL("_app/version.json", build), "utf8")).version ?? "",
);
const worker = await readFile(new URL("service-worker.js", build), "utf8");
const files = await readdir(build);

if (!version || !worker.includes(version))
  throw new Error("service-worker.js and version.json identify different web builds.");
if (!["nativeEpochs", "Desktop", "Android"].every((field) => worker.includes(field)))
  throw new Error("service-worker.js is missing native compatibility metadata.");
if (files.some((file) => /^service-worker-.+\.js$/.test(file)))
  throw new Error("The build contains a deprecated versioned service-worker copy.");

console.info(`Validated service-worker.js for web build ${version.slice(0, 12)}.`);
