// Pure file operations over a FileSystemDirectoryHandle. The OPFS and FSA adapters share
// the same handle-based API and differ ONLY in how they obtain the root handle, so the
// actual list/write/remove/read logic lives here once (DRY) and both adapters delegate.
import type { NoteFile } from './types.js';

export async function listMd(root: FileSystemDirectoryHandle): Promise<NoteFile[]> {
  const out: NoteFile[] = [];
  const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, h] of handle.entries()){
      if (h.kind === 'directory'){ await walk(h as FileSystemDirectoryHandle, prefix + name + '/'); continue; }
      if (!name.endsWith('.md')) continue;
      out.push({ path: prefix + name, text: await (await (h as FileSystemFileHandle).getFile()).text() });
    }
  };
  await walk(root, '');
  return out;
}
// Create/overwrite a note at a relative path (intermediate dirs created).
export async function writeFile(root: FileSystemDirectoryHandle, path: string, data: string | Blob): Promise<void> {
  let d = root;
  const parts = path.split('/');
  for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i], { create:true });
  const h = await d.getFileHandle(parts[parts.length-1], { create:true });
  const w = await h.createWritable(); await w.write(data); await w.close();
}
// Delete a note (a missing file is fine).
export async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  try {
    const parts = path.split('/'); let d = root;
    for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i]);
    await d.removeEntry(parts[parts.length-1]);
  } catch { /* already gone — fine */ }
}
// Read a binary file (e.g. an image attachment) as a Blob, or null if it's gone.
export async function readFileBlob(root: FileSystemDirectoryHandle, path: string): Promise<Blob | null> {
  try {
    const parts = path.split('/'); let d = root;
    for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i]);
    return await (await d.getFileHandle(parts[parts.length-1])).getFile();
  } catch { return null; }
}
