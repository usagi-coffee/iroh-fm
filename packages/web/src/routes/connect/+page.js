import { browser } from "$app/env";
import { resolve } from "$app/paths";

import { redirect } from "@sveltejs/kit";

import { App } from "#lib/runes/App.svelte.js";

/** @type {import('./$types').PageLoad} */
export function load({ depends }) {
  depends("app:connection");
  if (!browser || !App.initialized) return;
  if (App.connection.client) redirect(307, `${resolve("tracks")}${location.hash}`);
}
