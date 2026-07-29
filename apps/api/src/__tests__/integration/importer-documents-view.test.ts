/**
 * Integration tests for importer_documents_view and getImporterReview (#244)
 * against a real PostgreSQL instance.
 *
 * Run via:  npm run test:integration --workspace=apps/api
 *
 * Prerequisites: DATABASE_URL must point to a migrated test database.
 * The CI workflow runs `npm run db:migrate` before invoking this suite.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { getImporterReview } from '../../db.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/tariffshield_test';

const pool = new Pool({ connectionString: DATABASE_URL });

const testTag = randomUUID().slice(0, 8);

describe('importer_documents_view integration (#244)', () => {
  let userIdNoDocs: string;
  let importerIdNoDocs: string;
  const bondIdNoDocs = Math.floor(Math.random() * 9_000_000) + 1_000_000;

  let userIdWithDocs: string;
  let importerIdWithDocs: string;
  const bondIdWithDocs = Math.floor(Math.random() * 9_000_000) + 1_000_000;
  let documentId: string;

  before(async () => {
    const noDocsUser = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`no-docs-${testTag}@example.com`, 'test-hash-not-real', 'importer']
    );
    userIdNoDocs = noDocsUser.rows[0]!.id;

    const noDocsImporter = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        userIdNoDocs,
        'No Docs Corp',
        bondIdNoDocs,
        'GNODOCS0000000000000000000000000000000000000000000000000',
      ]
    );
    importerIdNoDocs = noDocsImporter.rows[0]!.id;

    const withDocsUser = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`with-docs-${testTag}@example.com`, 'test-hash-not-real', 'importer']
    );
    userIdWithDocs = withDocsUser.rows[0]!.id;

    const withDocsImporter = await pool.query<{ id: string }>(
      `INSERT INTO importers (user_id, legal_name, bond_id, stellar_address)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        userIdWithDocs,
        'With Docs Corp',
        bondIdWithDocs,
        'GWITHDOCS000000000000000000000000000000000000000000000000',
      ]
    );
    importerIdWithDocs = withDocsImporter.rows[0]!.id;

    const doc = await pool.query<{ id: string }>(
      `INSERT INTO kyc_documents
         (importer_id, document_type, s3_key_encrypted, scheduled_deletion_date)
       VALUES ($1, $2, $3, now() + interval '7 years')
       RETURNING id`,
      [importerIdWithDocs, 'ein_confirmation', 'encrypted-key-not-real']
    );
    documentId = doc.rows[0]!.id;
  });

  after(async () => {
    if (documentId) {
      await pool.query('DELETE FROM kyc_documents WHERE id = $1', [documentId]);
    }
    if (importerIdNoDocs) {
      await pool.query('DELETE FROM importers WHERE id = $1', [importerIdNoDocs]);
    }
    if (importerIdWithDocs) {
      await pool.query('DELETE FROM importers WHERE id = $1', [importerIdWithDocs]);
    }
    if (userIdNoDocs) {
      await pool.query('DELETE FROM users WHERE id = $1', [userIdNoDocs]);
    }
    if (userIdWithDocs) {
      await pool.query('DELETE FROM users WHERE id = $1', [userIdWithDocs]);
    }
    await pool.end();
  });

  it('returns the importer with an empty documents array when they have zero documents', async () => {
    const review = await getImporterReview(importerIdNoDocs);

    assert.ok(review, 'expected a review result, got null');
    assert.equal(review!.importerId, importerIdNoDocs);
    assert.equal(review!.legalName, 'No Docs Corp');
    // The view's LEFT JOIN produces one row with all document_* fields NULL
    // for an importer with no kyc_documents rows — getImporterReview must
    // filter that out rather than returning a single garbage document entry.
    assert.deepEqual(review!.documents, []);
  });

  it('returns the importer with its attached documents', async () => {
    const review = await getImporterReview(importerIdWithDocs);

    assert.ok(review, 'expected a review result, got null');
    assert.equal(review!.importerId, importerIdWithDocs);
    assert.equal(review!.documents.length, 1);
    assert.equal(review!.documents[0]!.documentId, documentId);
    assert.equal(review!.documents[0]!.documentType, 'ein_confirmation');
    assert.equal(review!.documents[0]!.reviewStatus, 'pending');
  });

  it('returns null for an importer id that does not exist', async () => {
    const review = await getImporterReview(randomUUID());
    assert.equal(review, null);
  });
});
