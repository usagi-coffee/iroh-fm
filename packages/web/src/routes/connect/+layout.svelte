<script>
  import UpdateNotice from "../UpdateNotice.svelte";

  /** @typedef {import('./$types').LayoutProps} Props */
  /** @type {Props} */
  const { children } = $props();
</script>

{@render children()}
<UpdateNotice overlay />
