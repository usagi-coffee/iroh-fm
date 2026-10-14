/**
 * Inputs and marked regions keep their native keyboard behavior rather than
 * triggering the library's global playback, selection, and search shortcuts.
 * @param {EventTarget | null} target
 */
export function handlesOwnKeys(target) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox'], [data-native-keyboard]",
      ),
    )
  );
}
