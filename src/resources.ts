import { mkdir, readFile, open, rename, rm } from "node:fs/promises";
import { Schema } from "effect";
import { join } from "node:path";
import { Fault, type Bounds, type Tree } from "./domain.js";
import { canonical, hash, relativePath, id } from "./util.js";
import { FileTreeSchema } from "./schemas.js";
import type { Journal } from "./journal.js";
export type FileTree = Record<string, { base64: string; executable: boolean }>;
export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}
export class DiskBlobs implements BlobStore {
  constructor(readonly root: string) {}
  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (hash(bytes) !== key) throw new Fault("INVALID_RESOURCE");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, id("upload"));
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.root, key));
      const directory = await open(this.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async get(key: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Fault("INVALID_RESOURCE");
    return readFile(join(this.root, key));
  }
}
export function validateTree(
  files: FileTree,
  bounds: Pick<Bounds, "treeBytes" | "treeFiles">,
): void {
  const paths = Object.keys(files);
  if (paths.length > bounds.treeFiles) throw new Fault("TREE_FILE_LIMIT");
  let bytes = 0;
  for (const [path, file] of Object.entries(files)) {
    relativePath(path);
    if (
      typeof file.base64 !== "string" ||
      typeof file.executable !== "boolean" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.base64,
      )
    )
      throw new Fault("INVALID_TREE");
    bytes += Buffer.byteLength(file.base64, "base64");
    if (bytes > bounds.treeBytes) throw new Fault("TREE_BYTE_LIMIT");
    if (paths.some((p) => p !== path && p.startsWith(`${path}/`)))
      throw new Fault("TREE_PATH_CONFLICT");
  }
}
export class Resources {
  constructor(
    readonly journal: Journal,
    readonly blobs: BlobStore,
  ) {}
  async publish(
    tenant: string,
    files: FileTree,
    bounds: Bounds,
  ): Promise<Tree> {
    validateTree(files, bounds);
    const bytes = Buffer.from(canonical(files));
    const digest = hash(bytes);
    // Bytes before manifest: failed uploads cannot publish a dangling success pointer.
    await this.blobs.put(digest, bytes);
    await this.journal.transaction(async (tx) => {
      await tx.sql.query(
        "INSERT INTO resource(id,tenant,manifest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          digest,
          tenant,
          JSON.stringify({
            kind: "file_tree",
            bytes: bytes.length,
            files: Object.keys(files),
          }),
        ],
      );
    });
    return { kind: "file_tree", id: digest };
  }
  async read(tenant: string, tree: Tree): Promise<FileTree> {
    const exists = await this.journal.transaction(
      async (tx) =>
        (
          await tx.sql.query(
            "SELECT id FROM resource WHERE tenant=$1 AND id=$2",
            [tenant, tree.id],
          )
        ).rows.length > 0,
    );
    if (!exists) throw new Fault("RESOURCE_NOT_FOUND");
    const bytes = await this.blobs.get(tree.id);
    if (hash(bytes) !== tree.id) throw new Fault("RESOURCE_CORRUPT");
    return Schema.decodeUnknownSync(FileTreeSchema)(
      JSON.parse(Buffer.from(bytes).toString()),
    );
  }
}
