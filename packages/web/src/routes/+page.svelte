<script>
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";

  function openTracks() {
    void goto(`${resolve("/tracks")}${location.hash}`, { replaceState: true });
  }
</script>

<div {@attach openTracks}></div>
