import { browser } from "$app/environment";
import { resolve } from "$app/paths";

import { App } from "$lib/runes/App.svelte.js";

import { redirect } from "@sveltejs/kit";

/** @type {import('./$types').LayoutLoad} */
export function load({ depends }) {
  depends("app:connection");
  if (!browser || !App.initialized) return;
  if (!App.connection.client) redirect(307, `${resolve("/connect")}${location.hash}`);
}
