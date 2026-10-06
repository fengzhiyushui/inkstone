import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Local encryption protects accidental disclosure; the user account remains the trust boundary. */
export class OAuthCredentialStore {
  constructor(root) {
    this.root = resolve(root || join(process.env.DEEPSEEK_CODE_HOME || homedir(), ".deepseek-code", "credentials", "mcp-oauth"));
  }

  _prepare() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) throw new Error("Unsafe OAuth credential directory");
    try { chmodSync(this.root, 0o700); } catch { /* Windows uses the account ACL. */ }
  }

  _key() {
    this._prepare();
    const file = join(this.root, "key.bin");
    try { writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe OAuth encryption key");
    try { chmodSync(file, 0o600); } catch { /* Windows uses the account ACL. */ }
    const key = readFileSync(file);
    if (key.length !== 32) throw new Error("Invalid OAuth encryption key");
    return key;
  }

  _file(binding) {
    return join(this.root, `${this._prefix(binding[1], binding[3])}${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}.json`);
  }

  _prefix(serverId, resource) {
    return `${createHash("sha256").update(JSON.stringify([serverId, resource])).digest("hex").slice(0, 16)}-`;
  }

  load(binding) {
    try {
      const file = this._file(binding);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null;
      const doc = JSON.parse(readFileSync(file, "utf8"));
      if (doc.version !== 1) return null;
      const decipher = createDecipheriv("aes-256-gcm", this._key(), Buffer.from(doc.iv, "base64"));
      decipher.setAAD(Buffer.from(JSON.stringify(binding)));
      decipher.setAuthTag(Buffer.from(doc.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(doc.data, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8"));
    } catch { return null; }
  }

  save(binding, value) {
    const key = this._key();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(binding)));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const file = this._file(binding);
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { flag: "wx", mode: 0o600 });
      renameSync(temp, file);
      try { chmodSync(file, 0o600); } catch { /* Windows uses the account ACL. */ }
    } finally {
      try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  delete(binding) {
    try { unlinkSync(this._file(binding)); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("Unable to remove OAuth credentials"); }
  }

  // Remove obsolete issuers for this resource while preserving same-named servers in other projects.
  deleteServer(serverId, resource) {
    let files;
    try { files = readdirSync(this.root); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const file of files) {
      if (file.startsWith(this._prefix(serverId, resource)) && /^[a-f0-9]{16}-[a-f0-9]{64}\.json$/.test(file)) {
        unlinkSync(join(this.root, file));
      }
    }
  }
}
