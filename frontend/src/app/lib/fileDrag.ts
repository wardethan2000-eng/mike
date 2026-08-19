/**
 * Telling a drag of real files apart from everything else that can be dragged.
 *
 * The app used to test only for the "Files" entry Chrome adds on a plain
 * file drag. That misses two common cases and both look to the user like
 * drag-and-drop is simply broken:
 *
 *  - Some Linux file managers and some apps offer a dragged file as
 *    "text/uri-list" or "application/x-moz-file" and nothing else.
 *  - Dragging a picture or link out of another web page offers a URL, not
 *    a file, so there is nothing to upload and the drop did nothing at all.
 *
 * Reading the wider set means the page always claims the drop, which also
 * stops the browser doing its own thing with it — its default is to leave
 * the app and open the file, losing whatever the user was in the middle of.
 */

/** Dragging a document or folder around inside the app, not a file from outside. */
const INTERNAL_DRAG_TYPES = ["application/mike-doc", "application/mike-folder"];

const FILE_DRAG_TYPES = ["Files", "application/x-moz-file", "text/uri-list"];

export function isExternalFileDrag(
    dataTransfer: DataTransfer | null | undefined,
): boolean {
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types);
    if (types.some((type) => INTERNAL_DRAG_TYPES.includes(type))) return false;
    return types.some((type) => FILE_DRAG_TYPES.includes(type));
}

export function filesFromDrag(
    dataTransfer: DataTransfer | null | undefined,
): File[] {
    return Array.from(dataTransfer?.files ?? []);
}

export const DRAGGED_WITHOUT_A_FILE_MESSAGE =
    "That came through as a link rather than a file, so there was nothing to add. Save it to your computer first, then drag the saved file in.";
