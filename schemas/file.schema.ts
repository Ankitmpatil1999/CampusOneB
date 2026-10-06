import { z } from 'zod';
import { FILE_PURPOSES } from '../config/file-purposes';

export const purposeSchema = z.enum(
  Object.keys(FILE_PURPOSES) as [keyof typeof FILE_PURPOSES, ...(keyof typeof FILE_PURPOSES)[]],
  { message: 'VALIDATION.FORMAT' },
);

export const uploadFormSchema = z
  .object({
    purpose: purposeSchema,
    file: z.string().describe('The file (multipart field "file"), 2 MB at most'),
  })
  .meta({ id: 'FileUpload' });

export const storedFileSchema = z
  .object({
    fileId: z.uuid(),
    purpose: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int(),
    scanStatus: z.enum(['CLEAN', 'PENDING', 'INFECTED', 'ERROR']),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'StoredFile' });

export const signedUrlSchema = z
  .object({ url: z.string(), expiresAt: z.iso.datetime() })
  .meta({ id: 'SignedFileUrl' });
