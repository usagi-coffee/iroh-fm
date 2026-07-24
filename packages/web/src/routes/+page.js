import { browser } from "$app/environment";
import { resolve } from "$app/paths";

import { App } from "$lib/runes/App.svelte.js";

import { redirect } from "@sveltejs/kit";

/** @type {import('./$types').PageLoad} */
export function load({ depends }) {
  depends("app:connection");
  if (!browser || !App.initialized) return;
  const path = resolve(App.connection.client ? "/tracks" : "/connect");
  redirect(307, `${path}${location.hash}`);
}
