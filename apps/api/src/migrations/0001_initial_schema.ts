import { PoolClient } from "pg";

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'importer' CHECK (role IN ('importer', 'surety_admin')),
      locked_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS importers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      legal_name TEXT NOT NULL,
      ein TEXT,
      bond_id BIGINT UNIQUE NOT NULL,
      stellar_address TEXT NOT NULL,
      stellar_secret_encrypted TEXT,
      collateral_balance NUMERIC(20, 0) NOT NULL DEFAULT 0,
      registered_on_chain_tx TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tariff_uploads (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      filename TEXT,
      annual_duty_total NUMERIC(20, 2) NOT NULL,
      computed_required_collateral NUMERIC(20, 0) NOT NULL,
      applied_tx TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS contract_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID REFERENCES importers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount NUMERIC(20, 0),
      tx_hash TEXT NOT NULL,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_contract_events_importer ON contract_events(importer_id, created_at DESC);

    ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS ledger_sequence INTEGER;
    ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS event_index INTEGER;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_events_ledger_event
      ON contract_events(ledger_sequence, event_index)
      WHERE ledger_sequence IS NOT NULL AND event_index IS NOT NULL;

    CREATE TABLE IF NOT EXISTS oracle_alerts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      old_value NUMERIC(20, 0) NOT NULL,
      new_value NUMERIC(20, 0) NOT NULL,
      pct_change NUMERIC(5, 2) NOT NULL,
      tx_hash TEXT NOT NULL,
      alerted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      acknowledged_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS aml_screenings (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      wallet_address TEXT NOT NULL,
      screening_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
      risk_score TEXT NOT NULL,
      provider_response JSONB,
      resolution_action TEXT
    );

    CREATE TABLE IF NOT EXISTS indexer_state (
      id TEXT PRIMARY KEY,
      last_processed_ledger INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS security_incidents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      incident_id TEXT UNIQUE NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),
      detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      description TEXT NOT NULL,
      affected_scope TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'contained', 'resolved')),
      resolution_timeline TIMESTAMPTZ,
      notification_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_security_incidents_severity ON security_incidents(severity, detected_at DESC);

    -- #325: Automated DAST and security findings
    CREATE TABLE IF NOT EXISTS security_findings (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      severity TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
      affected_endpoint TEXT,
      discovery_date TIMESTAMPTZ NOT NULL DEFAULT now(),
      remediation_sla TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'accepted_risk')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_security_findings_status_severity ON security_findings(status, severity);

    CREATE TABLE IF NOT EXISTS data_erasure_requests (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      request_id TEXT UNIQUE NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      importer_id UUID REFERENCES importers(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processing_started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      sla_deadline TIMESTAMPTZ NOT NULL,
      affected_fields TEXT ARRAY,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_data_erasure_requests_status ON data_erasure_requests(status, sla_deadline);
    CREATE INDEX IF NOT EXISTS idx_data_erasure_requests_user ON data_erasure_requests(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bond_records (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      bond_id BIGINT NOT NULL,
      bond_type_code TEXT NOT NULL CHECK (bond_type_code IN ('01', '02', '03', '04')),
      principal_legal_name TEXT NOT NULL,
      principal_ein TEXT NOT NULL,
      surety_company_name TEXT NOT NULL,
      surety_fein TEXT NOT NULL,
      bond_amount NUMERIC(20, 0) NOT NULL,
      cbp_minimum_required NUMERIC(20, 0) NOT NULL,
      effective_date DATE NOT NULL,
      expiry_date DATE,
      template_version TEXT,
      cbp_regulation_revision_date DATE,
      requires_increase BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_bond_records_importer ON bond_records(importer_id);
    CREATE INDEX IF NOT EXISTS idx_bond_records_requires_increase ON bond_records(requires_increase, updated_at DESC);

    CREATE TABLE IF NOT EXISTS authentication_attempts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_authentication_attempts_email_time ON authentication_attempts(email, attempted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_authentication_attempts_user_id ON authentication_attempts(user_id, attempted_at DESC);

    -- #308: SAML 2.0 SSO columns on users table
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saml_subject_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS idp_entity_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS idp_provider TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_saml_subject ON users(saml_subject_id, idp_entity_id)
      WHERE saml_subject_id IS NOT NULL;

    -- #321: Terms of Service versioning and tracking
    CREATE TABLE IF NOT EXISTS tos_versions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      version_id TEXT UNIQUE NOT NULL,
      effective_date DATE NOT NULL,
      change_summary TEXT NOT NULL,
      requires_reacceptance BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tos_acceptances (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      tos_version TEXT NOT NULL REFERENCES tos_versions(version_id),
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ip_address TEXT,
      user_agent TEXT,
      acceptance_method TEXT NOT NULL CHECK (acceptance_method IN ('signup', 're-acceptance'))
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_reacceptance_required BOOLEAN NOT NULL DEFAULT FALSE;

    -- Insert an initial ToS version if it doesn't exist
    INSERT INTO tos_versions (version_id, effective_date, change_summary)
      VALUES ('v1.0.0', CURRENT_DATE, 'Initial Terms of Service')
      ON CONFLICT (version_id) DO NOTHING;

    -- #322: privacy policy versioning
    CREATE TABLE IF NOT EXISTS privacy_policy_versions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      version_id TEXT UNIQUE NOT NULL,
      effective_date DATE NOT NULL,
      policy_text TEXT,
      s3_key TEXT,
      change_summary TEXT NOT NULL,
      requires_reacceptance BOOLEAN NOT NULL DEFAULT FALSE,
      published_by UUID REFERENCES users(id),
      published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS privacy_policy_acceptances (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      policy_version_id TEXT NOT NULL REFERENCES privacy_policy_versions(version_id),
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ip_address TEXT,
      acceptance_channel TEXT NOT NULL DEFAULT 'signup'
        CHECK (acceptance_channel IN ('signup', 'in_app', 'api')),
      UNIQUE (user_id, policy_version_id)
    );

    CREATE INDEX IF NOT EXISTS idx_privacy_acceptances_user ON privacy_policy_acceptances(user_id, accepted_at DESC);

    -- Track whether re-acceptance is outstanding (cleared when user accepts latest)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_reacceptance_required BOOLEAN NOT NULL DEFAULT FALSE;

    -- #317: electronic bond signatures (DocuSign)
    CREATE TABLE IF NOT EXISTS bond_signatures (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      bond_record_id UUID NOT NULL REFERENCES bond_records(id) ON DELETE CASCADE,
      envelope_id TEXT UNIQUE NOT NULL,
      signing_url TEXT,
      status TEXT NOT NULL DEFAULT 'sent'
        CHECK (status IN ('sent', 'delivered', 'completed', 'declined', 'voided')),
      signed_document_hash TEXT,
      completed_at TIMESTAMPTZ,
      pdf_s3_key TEXT,
      last_reminder_sent_at TIMESTAMPTZ
    );

    -- #312: KYC document storage with retention schedule
    CREATE TABLE IF NOT EXISTS kyc_documents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL CHECK (document_type IN ('articles_of_incorporation', 'ein_confirmation', 'beneficial_ownership_fincen_102')),
      s3_key_encrypted TEXT NOT NULL,
      upload_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
      review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
      reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewer_note TEXT,
      reviewed_at TIMESTAMPTZ,
      scheduled_deletion_date TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_kyc_documents_importer ON kyc_documents(importer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_kyc_documents_deletion ON kyc_documents(scheduled_deletion_date) WHERE deleted_at IS NULL;

    -- KYC status column on importers (pending/approved/rejected)
    ALTER TABLE importers ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (kyc_status IN ('pending', 'approved', 'rejected'));

    -- #314: field encryption key version tracking
    CREATE TABLE IF NOT EXISTS field_encryption_key_versions (
      key_version INTEGER PRIMARY KEY,
      activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      superseded_at TIMESTAMPTZ,
      notes TEXT
    );
    INSERT INTO field_encryption_key_versions (key_version, notes)
      VALUES (1, 'initial key version')
      ON CONFLICT (key_version) DO NOTHING;

    -- EIN is now stored as AES-256-GCM JSON; migrate existing plain text at app layer
    ALTER TABLE importers ADD COLUMN IF NOT EXISTS ein_encrypted TEXT;
    ALTER TABLE importers ADD COLUMN IF NOT EXISTS ein_key_version INTEGER REFERENCES field_encryption_key_versions(key_version);

    -- #318: regulatory compliance flags
    CREATE TABLE IF NOT EXISTS compliance_flags (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      flag_type TEXT NOT NULL CHECK (flag_type IN ('aml_high_risk', 'bond_below_cbp_minimum', 'bond_unsigned', 'kyc_rejected', 'bond_renewal_due')),
      severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
      description TEXT,
      resolution_status TEXT NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open', 'resolved')),
      resolved_by UUID REFERENCES users(id),
      resolution_note TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_bond_signatures_bond ON bond_signatures(bond_record_id);
    CREATE INDEX IF NOT EXISTS idx_bond_signatures_status ON bond_signatures(status, created_at DESC);

    -- Track bond signature status on bond_records for fast lookup
    ALTER TABLE bond_records ADD COLUMN IF NOT EXISTS signature_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (signature_status IN ('pending', 'sent', 'completed'));
    CREATE INDEX IF NOT EXISTS idx_compliance_flags_surety ON compliance_flags(surety_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compliance_flags_importer ON compliance_flags(importer_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_flags_open ON compliance_flags(surety_id, resolution_status) WHERE resolution_status = 'open';

    -- #319: monthly compliance reports
    CREATE TABLE IF NOT EXISTS compliance_reports (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_month DATE NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      report_data JSONB NOT NULL,
      pdf_s3_key TEXT,
      superseded_at TIMESTAMPTZ,
      UNIQUE (surety_id, report_month)
    );

    CREATE INDEX IF NOT EXISTS idx_compliance_reports_surety ON compliance_reports(surety_id, report_month DESC);

    -- #324: insurance license verification for surety_admin accounts
    -- A surety_admin is created with status='pending'; operational routes are blocked
    -- until a platform admin sets status='verified' after checking NAIC / state DOI records.
    CREATE TABLE IF NOT EXISTS surety_license_verifications (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      naic_number TEXT,
      company_name TEXT NOT NULL DEFAULT '',
      state_of_domicile TEXT NOT NULL DEFAULT '',
      am_best_rating TEXT,
      license_status_detail TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'submitted', 'verified', 'rejected')),
      submitted_at TIMESTAMPTZ,
      reviewed_at TIMESTAMPTZ,
      reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
      rejection_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_surety_license_verifications_status
      ON surety_license_verifications(status, created_at DESC);

    -- #336: off-chain tracking of on-chain collateral disputes
    CREATE TABLE IF NOT EXISTS collateral_disputes (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      old_required NUMERIC(20, 0) NOT NULL,
      new_required NUMERIC(20, 0) NOT NULL,
      raise_tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'resolved_accepted', 'resolved_rejected')),
      raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolve_tx_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_collateral_disputes_importer
      ON collateral_disputes(importer_id, raised_at DESC);

    -- Oracle price feed: durable audit trail of every set_required_collateral event.
    CREATE TABLE IF NOT EXISTS oracle_price_feed (
      id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id          UUID          REFERENCES importers(id) ON DELETE SET NULL,
      importer_address     TEXT          NOT NULL,
      required_collateral  NUMERIC(20,7) NOT NULL,
      previous_collateral  NUMERIC(20,7) NOT NULL DEFAULT 0,
      pct_change           NUMERIC(7,4)  NOT NULL DEFAULT 0,
      tx_hash              VARCHAR(64)   NOT NULL,
      ledger_sequence      INTEGER       NOT NULL,
      set_by               VARCHAR(64)   NOT NULL DEFAULT '',
      emergency_override   BOOLEAN       NOT NULL DEFAULT FALSE,
      created_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_oracle_price_feed_importer
      ON oracle_price_feed(importer_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_oracle_price_feed_ledger
      ON oracle_price_feed(ledger_sequence);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_price_feed_tx_importer
      ON oracle_price_feed(tx_hash, importer_address);

    -- Checkpoint for the oracle event listener (resume after downtime).
    CREATE TABLE IF NOT EXISTS listener_state (
      id                   TEXT         PRIMARY KEY,
      last_ledger_sequence INTEGER      NOT NULL,
      updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
    );

    -- #306 SOC 2 CC6: server-side session table for 15-min inactivity timeout and
    -- concurrent session limits. Sessions are created on login and revoked on logout.
    CREATE TABLE IF NOT EXISTS user_sessions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_activity TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      ip_address TEXT,
      user_agent TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id
      ON user_sessions(user_id) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS surety_state_licenses (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state_code TEXT NOT NULL,
      license_number TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (surety_id, state_code)
    );

    CREATE TABLE IF NOT EXISTS regulatory_report_audit_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state_code TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      output_format TEXT NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_surety_state_licenses_surety ON surety_state_licenses(surety_id, state_code);
    CREATE INDEX IF NOT EXISTS idx_regulatory_report_audit_logs_surety ON regulatory_report_audit_logs(surety_id, generated_at DESC);

    ALTER TABLE bond_records ADD COLUMN IF NOT EXISTS state_code TEXT NOT NULL DEFAULT 'CA';
    ALTER TABLE importers ADD COLUMN IF NOT EXISTS business_state TEXT NOT NULL DEFAULT 'CA';

    -- #251: surety-dashboard aggregate statistics, pre-computed instead of a
    -- live GROUP BY over importers/bond_records/contract_events on every
    -- page load. See apps/api/migrations/002_importer_metrics_mv.sql for the
    -- full metric-definition rationale.
    CREATE MATERIALIZED VIEW IF NOT EXISTS importer_metrics_mv AS
    SELECT
      1 AS singleton_id,
      (SELECT COUNT(*) FROM importers) AS total_importers,
      (SELECT COALESCE(SUM(bond_amount), 0) FROM bond_records) AS total_bond_value,
      (SELECT ROUND(COALESCE(AVG(collateral_balance), 0)) FROM importers) AS avg_balance,
      (
        SELECT CASE WHEN COUNT(*) = 0 THEN 100.0
          ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE bond_amount >= cbp_minimum_required) / COUNT(*), 2)
        END
        FROM bond_records
      ) AS compliance_rate,
      (
        SELECT COUNT(*) FROM contract_events
        WHERE kind IN ('deposit_collateral', 'deposit_reserve', 'auto_top_up')
          AND created_at >= now() - INTERVAL '30 days'
      ) AS topup_count_30d,
      now() AS refreshed_at;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_importer_metrics_mv_singleton
      ON importer_metrics_mv (singleton_id);

    ALTER TABLE importers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE MATERIALIZED VIEW IF NOT EXISTS importer_metrics AS
    SELECT
      i.id AS importer_id,
      i.legal_name,
      i.stellar_address,
      COALESCE(t.latest_required_collateral, 0) AS required_collateral,
      COALESCE(
        SUM(CASE WHEN ce.kind IN ('deposit', 'deposit_collateral', 'deposit_reserve') THEN ce.amount ELSE 0 END) -
        SUM(CASE WHEN ce.kind IN ('withdrawal', 'withdraw') THEN ce.amount ELSE 0 END), 0
      ) AS current_balance,
      COALESCE(t.latest_annual_duty_total, 0) AS annual_duty_total,
      CASE WHEN COALESCE(t.latest_required_collateral, 0) > 0
        THEN ROUND(
          (SUM(CASE WHEN ce.kind IN ('deposit', 'deposit_collateral', 'deposit_reserve') THEN ce.amount ELSE 0 END) -
           SUM(CASE WHEN ce.kind IN ('withdrawal', 'withdraw') THEN ce.amount ELSE 0 END))::NUMERIC
          / t.latest_required_collateral, 4)
        ELSE NULL END AS coverage_ratio,
      now() AS refreshed_at
    FROM importers i
    LEFT JOIN LATERAL (
      SELECT annual_duty_total AS latest_annual_duty_total,
             computed_required_collateral AS latest_required_collateral
      FROM tariff_uploads WHERE importer_id = i.id ORDER BY created_at DESC LIMIT 1
    ) t ON true
    LEFT JOIN contract_events ce ON ce.importer_id = i.id
    WHERE i.deleted_at IS NULL
    GROUP BY i.id, i.legal_name, i.stellar_address,
             t.latest_annual_duty_total, t.latest_required_collateral;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_importer_metrics_importer_id
      ON importer_metrics (importer_id);
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DROP MATERIALIZED VIEW IF EXISTS importer_metrics CASCADE;
    DROP MATERIALIZED VIEW IF EXISTS importer_metrics_mv CASCADE;
    DROP TABLE IF EXISTS regulatory_report_audit_logs CASCADE;
    DROP TABLE IF EXISTS surety_state_licenses CASCADE;
    DROP TABLE IF EXISTS user_sessions CASCADE;
    DROP TABLE IF EXISTS listener_state CASCADE;
    DROP TABLE IF EXISTS oracle_price_feed CASCADE;
    DROP TABLE IF EXISTS collateral_disputes CASCADE;
    DROP TABLE IF EXISTS surety_license_verifications CASCADE;
    DROP TABLE IF EXISTS compliance_reports CASCADE;
    DROP TABLE IF EXISTS compliance_flags CASCADE;
    DROP TABLE IF EXISTS kyc_documents CASCADE;
    DROP TABLE IF EXISTS bond_signatures CASCADE;
    DROP TABLE IF EXISTS privacy_policy_acceptances CASCADE;
    DROP TABLE IF EXISTS privacy_policy_versions CASCADE;
    DROP TABLE IF EXISTS tos_acceptances CASCADE;
    DROP TABLE IF EXISTS tos_versions CASCADE;
    DROP TABLE IF EXISTS authentication_attempts CASCADE;
    DROP TABLE IF EXISTS bond_records CASCADE;
    DROP TABLE IF EXISTS data_erasure_requests CASCADE;
    DROP TABLE IF EXISTS security_findings CASCADE;
    DROP TABLE IF EXISTS security_incidents CASCADE;
    DROP TABLE IF EXISTS indexer_state CASCADE;
    DROP TABLE IF EXISTS aml_screenings CASCADE;
    DROP TABLE IF EXISTS oracle_alerts CASCADE;
    DROP TABLE IF EXISTS contract_events CASCADE;
    DROP TABLE IF EXISTS tariff_uploads CASCADE;
    DROP TABLE IF EXISTS importers CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS field_encryption_key_versions CASCADE;
  `);
}
