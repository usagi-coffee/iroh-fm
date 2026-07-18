import { $ } from "bun";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const crate = resolve(root, "crates/web-wasm");
const input = resolve(root, "target/wasm32-unknown-unknown/wasm-release/iroh_fm_web_wasm.wasm");
const output = resolve(import.meta.dir, "src/wasm");
const optimized = resolve(output, "iroh_fm_web_wasm_bg.wasm");

await $`cargo build --target wasm32-unknown-unknown --profile wasm-release`.cwd(crate);
await $`wasm-bindgen ${input} --out-dir ${output} --target web --weak-refs`;
await $`wasm-opt --enable-sign-ext --enable-nontrapping-float-to-int --enable-bulk-memory -Os -o ${optimized} ${optimized}`;
