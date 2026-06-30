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
// Walk to the directory holding the final segment of `path`, returning [that dir, the leaf name].
// `create` makes the intermediate dirs as it goes (for writes); without it a missing dir throws.
async function resolvePath(root: FileSystemDirectoryHandle, path: string, create = false): Promise<[FileSystemDirectoryHandle, string]> {
  const parts = path.split('/'); let d = root;
  for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i], { create });
  return [d, parts[parts.length-1]];
}
// Create/overwrite a note at a relative path (intermediate dirs created).
export async function writeFile(root: FileSystemDirectoryHandle, path: string, data: string | Blob): Promise<void> {
  const [d, name] = await resolvePath(root, path, true);
  const h = await d.getFileHandle(name, { create:true });
  const w = await h.createWritable(); await w.write(data); await w.close();
}
// Delete a note (a missing file is fine).
export async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  try {
    const [d, name] = await resolvePath(root, path);
    await d.removeEntry(name);
  } catch { /* already gone — fine */ }
}
// Read a binary file (e.g. an image attachment) as a Blob, or null if it's gone.
export async function readFileBlob(root: FileSystemDirectoryHandle, path: string): Promise<Blob | null> {
  try {
    const [d, name] = await resolvePath(root, path);
    return await (await d.getFileHandle(name)).getFile();
  } catch { return null; }
}
