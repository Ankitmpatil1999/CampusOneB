/**
 * Uploads and downloads (PLT-010, PLT-011; CR-07; golden rule "uploads"):
 * - 2 MB per file (limits register), type decided from the bytes against the purpose's list;
 * - virus scan before the file is usable; an infected file is deleted and refused;
 * - private storage; downloads only through short-lived signed links;
 * - a tenant session sees only its institution's files (another tenant's id answers 404).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import type { Kysely } from 'kysely';
import type { Readable } from 'node:stream';
import { FILE_PURPOSES, MIME, type FilePurposeKey } from '../config/file-purposes';
import type { Loggers } from '../controllers/logger';
import type { AntivirusScanner } from '../integrations/antivirus.provider';
import type { StorageProvider } from '../integrations/storage.provider';
import type { Database } from '../models/ringpe_models';
import { fileRepository, institutionLookup } from '../repositories/file.repository';
import { CustomAPIError, NotFoundError } from '../utils/CustomAPIError';
import type { FieldCipher } from '../utils/fieldEncryption';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';

export interface UploadInput {
  readonly principal: Principal;
  readonly purpose: FilePurposeKey;
  readonly originalName: string;
  readonly data: Buffer;
}

export interface StoredFile {
  readonly fileId: string;
  readonly purpose: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly scanStatus: 'CLEAN' | 'PENDING' | 'INFECTED' | 'ERROR';
  readonly createdAt: string;
}

export interface FileServiceDeps {
  readonly db: Kysely<Database>;
  readonly storage: StorageProvider;
  readonly scanner: AntivirusScanner;
  readonly cipher: FieldCipher;
  readonly loggers: Loggers;
  readonly urlTtlSeconds: number;
  readonly now?: () => Date;
}

export interface GeneratedFileInput {
  /** None: an operator's export. */
  readonly institutionId: string | null;
  /** export: a data export; statement: a settlement statement (STL-007). */
  readonly purpose: 'export' | 'statement';
  readonly name: string;
  readonly mimeType: string;
  readonly data: Buffer;
  readonly createdBy: Buffer | null;
}

/**
 * Stores a file the platform wrote itself: no upload checks apply, it is private and reached only
 * through a signed link. Shared by the API and the worker (which has no field keys).
 */
export async function storeGeneratedFile(
  db: Kysely<Database>,
  storage: StorageProvider,
  input: GeneratedFileInput,
  now: Date,
): Promise<{ id: string; publicId: string }> {
  const file = newPublicIdPair();
  const objectKey = `generated/${input.purpose}/${now.toISOString().slice(0, 7)}/${file.id}`;
  await storage.put(objectKey, input.data);
  try {
    await fileRepository.insert(db, {
      publicId: file.bin,
      institutionId: input.institutionId,
      purpose: input.purpose,
      objectKey,
      originalName: safeName(input.name),
      mimeType: input.mimeType,
      sizeBytes: input.data.length,
      sha256: createHash('sha256').update(input.data).digest('hex'),
      scanStatus: 'CLEAN',
      createdBy: input.createdBy,
    });
  } catch (e) {
    await storage.remove(objectKey);
    throw e;
  }
  const row = await fileRepository.findByPublicId(db, file.bin);
  return { id: String(row!.id), publicId: file.id };
}

/** "2 MB" / "2.4 MB" / "900 KB" for messages. */
export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Decides the type from the bytes; CSV (plain text) is accepted only where the purpose allows it. */
async function sniff(data: Buffer, allowed: readonly string[]): Promise<string | undefined> {
  const detected = await fileTypeFromBuffer(data);
  if (detected) return allowed.includes(detected.mime) ? detected.mime : undefined;
  if (allowed.includes(MIME.csv) && isPlainText(data)) return MIME.csv;
  return undefined;
}

const isPlainText = (data: Buffer) => {
  if (data.length === 0 || data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
};

const safeName = (name: string) =>
  name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .slice(-150) || 'file';

export class FileService {
  private readonly now: () => Date;

  constructor(private readonly deps: FileServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async tenantId(p: Principal): Promise<string | null> {
    if (!p.institutionId) return null;
    const id = await institutionLookup.idByPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!id) throw new NotFoundError();
    return id;
  }

  async upload(input: UploadInput): Promise<StoredFile> {
    const purpose = FILE_PURPOSES[input.purpose];
    const mime = await sniff(input.data, purpose.types);
    if (!mime) {
      throw new CustomAPIError(415, 'FILE.TYPE_NOT_ALLOWED');
    }
    const verdict = await this.deps.scanner.scan(input.data);
    if (verdict === 'INFECTED') {
      this.deps.loggers.security.warn('file.infected', { purpose: input.purpose });
      throw new CustomAPIError(422, 'FILE.INFECTED');
    }
    if (verdict === 'ERROR') throw new CustomAPIError(503, 'GEN.UNAVAILABLE');

    const institutionId = await this.tenantId(input.principal);
    const file = newPublicIdPair();
    const now = this.now();
    const scope = input.principal.institutionId ?? `account-${input.principal.subject}`;
    const objectKey = `${scope}/${input.purpose}/${now.toISOString().slice(0, 7)}/${file.id}`;
    await this.deps.storage.put(objectKey, input.data);
    try {
      await fileRepository.insert(this.deps.db, {
        publicId: file.bin,
        institutionId,
        purpose: input.purpose,
        objectKey,
        originalName: safeName(input.originalName),
        mimeType: mime,
        sizeBytes: input.data.length,
        sha256: createHash('sha256').update(input.data).digest('hex'),
        scanStatus: 'CLEAN',
        createdBy: isUuid(input.principal.subject) ? uuidToBin(input.principal.subject) : null,
      });
    } catch (e) {
      await this.deps.storage.remove(objectKey);
      throw e;
    }
    return {
      fileId: file.id,
      purpose: input.purpose,
      mimeType: mime,
      sizeBytes: input.data.length,
      scanStatus: 'CLEAN',
      createdAt: now.toISOString(),
    };
  }

  private signature(fileId: string, exp: number): string {
    return createHmac('sha256', this.deps.cipher.secret('file_url'))
      .update(`${fileId}.${exp}`)
      .digest('base64url');
  }

  /**
   * A short-lived download link (PLT-011) for a file the caller may read: their institution's
   * files, or files they uploaded themselves outside any institution.
   */
  async signedUrl(p: Principal, fileId: string): Promise<{ url: string; expiresAt: string }> {
    if (!isUuid(fileId)) throw new NotFoundError();
    const f = await fileRepository.findByPublicId(this.deps.db, uuidToBin(fileId));
    if (!f || f.scan_status !== 'CLEAN') throw new NotFoundError();
    const tenant = await this.tenantId(p);
    const own = f.created_by !== null && binToUuid(f.created_by) === p.subject;
    const allowed =
      f.institution_id === null ? own : tenant !== null && String(f.institution_id) === tenant;
    if (!allowed) throw new NotFoundError();
    const exp = Math.floor(this.now().getTime() / 1000) + this.deps.urlTtlSeconds;
    const sig = this.signature(fileId, exp);
    return {
      url: `/api/v1/files/${fileId}/content?exp=${exp}&sig=${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /**
   * Stores a file the platform wrote itself (a data export): no upload checks apply, it is private
   * and reached only through `linkFor`. Returns the file's ids.
   */
  async storeGenerated(input: GeneratedFileInput): Promise<{ id: string; publicId: string }> {
    return storeGeneratedFile(this.deps.db, this.deps.storage, input, this.now());
  }

  /**
   * A signed link for a file the calling service has already checked (the institution logo on the
   * public branding read, INS-035). Never exposed with a caller-chosen id.
   */
  linkFor(fileId: string): { url: string; expiresAt: string } {
    const exp = Math.floor(this.now().getTime() / 1000) + this.deps.urlTtlSeconds;
    return {
      url: `/api/v1/files/${fileId}/content?exp=${exp}&sig=${this.signature(fileId, exp)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** Opens a file behind a signed link; an expired or altered link answers 404. */
  async open(
    fileId: string,
    exp: string | undefined,
    sig: string | undefined,
  ): Promise<{ stream: Readable; mimeType: string; name: string; size: number }> {
    if (!isUuid(fileId) || !exp || !sig || !/^\d{1,12}$/.test(exp)) throw new NotFoundError();
    const expires = Number(exp);
    if (expires < Math.floor(this.now().getTime() / 1000)) throw new NotFoundError();
    const expected = Buffer.from(this.signature(fileId, expires));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new NotFoundError();
    }
    const f = await fileRepository.findByPublicId(this.deps.db, uuidToBin(fileId));
    if (!f || f.scan_status !== 'CLEAN') throw new NotFoundError();
    return {
      stream: this.deps.storage.read(f.object_key),
      mimeType: f.mime_type,
      name: f.original_name,
      size: f.size_bytes,
    };
  }
}
