import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";

import type { ProfileMarkerV1, ProfileStore } from "./types.ts";

const markerName = ".hunt-profile-v1.json";
const partialName = ".hunt-profile-v1.tmp";
const markerByteLimit = 4_096;

export class FileProfileStore implements ProfileStore {
  async read(profilePath: string): Promise<unknown> {
    assertProfilePath(profilePath);
    const markerPath = resolve(profilePath, markerName);
    try {
      await assertExistingProfileIsDirect(profilePath);
      const metadata = await stat(markerPath);
      if (!metadata.isFile() || metadata.size > markerByteLimit) return {};
      return JSON.parse(await readFile(markerPath, "utf8")) as unknown;
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await lstat(profilePath);
        return {};
      } catch (profileError) {
        if (isMissing(profileError)) return undefined;
        throw profileError;
      }
    }
  }

  async write(profilePath: string, marker: ProfileMarkerV1): Promise<void> {
    assertProfilePath(profilePath);
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await assertExistingProfileIsDirect(profilePath);
    const markerPath = resolve(profilePath, markerName);
    const partialPath = resolve(profilePath, partialName);
    const serialized = JSON.stringify(marker);
    if (Buffer.byteLength(serialized, "utf8") > markerByteLimit) {
      throw new RangeError("profile marker exceeds its bounded size");
    }
    await rm(partialPath, { force: true });
    await writeFile(partialPath, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(partialPath, markerPath);
  }

  async cleanup(profilePath: string, marker: ProfileMarkerV1): Promise<void> {
    const current = await this.read(profilePath);
    if (JSON.stringify(current) !== JSON.stringify(marker)) {
      throw new TypeError("profile marker mismatch");
    }
    await this.cleanupPartial(profilePath);
  }

  async cleanupPartial(profilePath: string): Promise<void> {
    assertProfilePath(profilePath);
    try {
      await assertExistingProfileIsDirect(profilePath);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await rm(profilePath, { recursive: true, force: true });
  }
}

function assertProfilePath(profilePath: string): void {
  const absolute = resolve(profilePath);
  if (!isAbsolute(profilePath) || absolute === parse(absolute).root) {
    throw new TypeError("profile path must be a bounded absolute directory");
  }
}

async function assertExistingProfileIsDirect(profilePath: string): Promise<void> {
  const metadata = await lstat(profilePath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError("profile path must be a direct directory");
  }
  const actual = await realpath(profilePath);
  if (actual.toLowerCase() !== resolve(profilePath).toLowerCase()) {
    throw new TypeError("profile path cannot traverse a reparse target");
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
