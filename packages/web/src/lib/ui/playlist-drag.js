export const PLAYLIST_TRACKS_DRAG_TYPE = "application/x-iroh-fm-track-ids";

/**
 * @param {DragEvent} event
 * @param {Array<{id: string}>} tracks
 * @param {{label?: string, detail?: string}} [preview]
 */
export function setPlaylistTracksDrag(event, tracks, preview = {}) {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(
    PLAYLIST_TRACKS_DRAG_TYPE,
    JSON.stringify([...new Set(tracks.map((track) => track.id))]),
  );
  event.dataTransfer.setData(
    "text/plain",
    tracks.length === 1 ? tracks[0]?.id ?? "" : `${tracks.length} tracks`,
  );
  const dragImage = createDragImage(
    preview.label ?? (tracks.length === 1 ? "Track" : `${tracks.length} tracks`),
    preview.detail ?? `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`,
  );
  document.body.append(dragImage);
  event.dataTransfer.setDragImage(dragImage, 22, 22);
  requestAnimationFrame(() => dragImage.remove());
}

/** @param {string} label @param {string} detail */
function createDragImage(label, detail) {
  const preview = document.createElement("div");
  preview.dataset.playlistDragPreview = "";
  Object.assign(preview.style, {
    position: "fixed",
    left: "-1000px",
    top: "-1000px",
    zIndex: "2147483647",
    display: "grid",
    gridTemplateColumns: "2.25rem minmax(0, 1fr)",
    alignItems: "center",
    width: "16rem",
    padding: "0.55rem",
    border: "1px solid rgba(203, 166, 247, 0.8)",
    borderRadius: "0.25rem",
    color: "#cdd6f4",
    background: "#181825",
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.45)",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    pointerEvents: "none",
  });

  const icon = document.createElement("div");
  icon.textContent = "♫";
  Object.assign(icon.style, {
    display: "grid",
    placeItems: "center",
    width: "1.75rem",
    height: "1.75rem",
    borderRadius: "0.2rem",
    color: "#11111b",
    background: "#cba6f7",
    fontSize: "1rem",
    fontWeight: "700",
  });

  const text = document.createElement("div");
  text.style.minWidth = "0";
  const title = document.createElement("div");
  title.textContent = label;
  Object.assign(title.style, {
    overflow: "hidden",
    color: "#cdd6f4",
    fontSize: "0.75rem",
    fontWeight: "700",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  const subtitle = document.createElement("div");
  subtitle.textContent = detail;
  Object.assign(subtitle.style, {
    overflow: "hidden",
    marginTop: "0.15rem",
    color: "#a6adc8",
    fontSize: "0.625rem",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  text.append(title, subtitle);
  preview.append(icon, text);
  return preview;
}

/** @param {DataTransfer | null} transfer */
export function hasPlaylistTracksDrag(transfer) {
  return Boolean(transfer && [...transfer.types].includes(PLAYLIST_TRACKS_DRAG_TYPE));
}

/** @param {DataTransfer | null} transfer */
export function readPlaylistTrackIds(transfer) {
  if (!transfer) return [];
  try {
    const ids = JSON.parse(transfer.getData(PLAYLIST_TRACKS_DRAG_TYPE));
    return Array.isArray(ids) ? [...new Set(ids.map(String).filter(Boolean))] : [];
  } catch {
    return [];
  }
}
