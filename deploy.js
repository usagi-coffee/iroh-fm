import { $ } from "bun";

const connection = process.env.IROH_FM_PODMAN_CONNECTION || "chiya";
const host = process.env.IROH_FM_DEPLOY_HOST || "chiya";
const podman = ["podman", "--remote", "--connection", connection];
const image = "localhost/iroh-fm:latest";

$.cwd(import.meta.dir);

// Both destinations must refer to the same rootful Podman host.
// The existing service owns music mounts, identity, and server arguments.
console.log(`Building ${image} on ${connection}...`);
await $`${podman} build --layers --tag ${image} --file Containerfile .`;
console.log(`Restarting iroh-fm.service on ${host}...`);
await $`ssh ${host} 'systemctl restart iroh-fm.service && systemctl is-active --quiet iroh-fm.service'`;

console.log(`Deployed ${image} on ${host}; iroh-fm.service is active.`);
