// Save a Blob as a file through a temporary <a download>. The object URL is revoked a little later
// rather than right after click(): revoking at once can cancel a large download in some browsers.
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
