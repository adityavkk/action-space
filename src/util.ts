import { createHash, randomUUID } from "node:crypto";
import { Fault, type Json } from "./domain.js";
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}
export function json(value: unknown, maxBytes: number): Json {
  const seen = new Set<unknown>();
  function check(v: unknown, depth: number): void {
    if (depth > 40) throw new Fault("JSON_DEPTH");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || seen.has(v)) throw new Fault("INVALID_JSON");
    seen.add(v);
    for (const item of Array.isArray(v) ? v : Object.values(v))
      check(item, depth + 1);
    seen.delete(v);
  }
  check(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes)
    throw new Fault("OUTPUT_LIMIT");
  return value as Json;
}
export function relativePath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((x) => !x || x === "." || x === "..") ||
    /[\x00-\x1f]/.test(path)
  )
    throw new Fault("INVALID_PATH");
  return path;
}
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export function errorCode(error: unknown): string {
  return error instanceof Fault ? error.code : "INTERNAL_ERROR";
}
