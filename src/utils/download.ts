// Save a Blob to the user's disk via a programmatic <a download> click. Shared by the
// map-level .zip export (data/persistence.ts) and the card export button (features/clipboard.ts).
export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  // revoke only after the download has had a chance to start reading the blob URL
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
