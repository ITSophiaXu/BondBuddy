/** Existing Word consumer limits, shared with model-side preparation. */
export const HISTORICAL_REVIEW_NOTE_MAX_LENGTH = 512;
export const HISTORICAL_REVIEW_NOTE_MAX_COUNT = 1000;

/** Preserve all text as ordered, same-anchor comments. Never truncate a missing-evidence reason. */
export function splitHistoricalReviewNotes(notes: readonly { recordId: string; message: string }[]) {
  return notes.flatMap(note => {
    if (note.message.length <= HISTORICAL_REVIEW_NOTE_MAX_LENGTH) return [{ ...note }];
    const parts: string[] = [];
    let part = '';
    // Reserve room for the continuation label, and do not cut a UTF-16 surrogate pair.
    for (const character of note.message) {
      if (part.length + character.length > 480) { parts.push(part); part = ''; }
      part += character;
    }
    if (part) parts.push(part);
    return parts.map((message, index) => ({ recordId: note.recordId,
      message: `待人工确认（${index + 1}/${parts.length}）：${message}` }));
  });
}
