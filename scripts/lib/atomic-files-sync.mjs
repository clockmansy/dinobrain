import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeAll(fd, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}

function renameWithRetry(source, destination) {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!["EACCES", "EBUSY", "EPERM"].includes(error?.code)) throw error;
      sleep(Math.min(250, 20 + attempt * 15));
    }
  }
  throw lastError ?? new Error(`Could not replace ${destination}`);
}

export function atomicWriteBytesSync(filePath, value, validate = null) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd = null;
  try {
    fd = openSync(tempPath, "wx");
    writeAll(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    validate?.(tempPath);
    renameWithRetry(tempPath, filePath);
    validate?.(filePath);
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

export function atomicWriteTextSync(filePath, value, validate = null) {
  atomicWriteBytesSync(filePath, Buffer.from(value, "utf8"), validate);
}

export function atomicWriteJsonSync(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(serialized);
  atomicWriteTextSync(filePath, serialized, (candidatePath) => JSON.parse(readFileSync(candidatePath, "utf8")));
}

function withFileLockSync(lockPath, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const staleMs = options.staleMs ?? 300_000;
  const owner = `${process.pid}-${randomUUID()}`;
  const startedAt = Date.now();
  mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeAll(fd, `${JSON.stringify({ owner, pid: process.pid, acquired_at: new Date().toISOString() })}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (!["EEXIST", "EACCES", "EPERM"].includes(error?.code)) throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        if (!["EACCES", "EPERM"].includes(statError?.code)) throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      sleep(20 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return operation();
  } finally {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      if (lock.owner === owner) unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export function appendFileWithLockSync(filePath, value) {
  return withFileLockSync(`${filePath}.append.lock`, () => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = openSync(filePath, "a");
    try {
      writeAll(fd, value);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
}
