-- EERMS PostgreSQL schema (target relational model; mirrors store.js)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE IF NOT EXISTS employee_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS ticket_seq START 1;

CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_code VARCHAR(10) UNIQUE NOT NULL DEFAULT ('EMP-' || lpad(nextval('employee_code_seq')::text, 4, '0')),
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(100),
  role VARCHAR(20) NOT NULL CHECK (role IN ('employee','finance','hr','admin')),
  phone VARCHAR(20),
  branch_location VARCHAR(50) CHECK (branch_location IN ('Corporate HQ','Branch A','Branch B')),
  joining_date DATE,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','frozen')),
  must_change_password BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_details (
  employee_id UUID PRIMARY KEY REFERENCES employees(id),
  account_holder VARCHAR(150) NOT NULL,
  bank_name VARCHAR(100) NOT NULL,
  account_number VARCHAR(18) NOT NULL CHECK (account_number ~ '^[0-9]{9,18}$'),
  ifsc_code VARCHAR(11) NOT NULL CHECK (ifsc_code ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_verification_status VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (bank_verification_status IN ('Pending','Verified','Rejected')),
  verification_checklist JSONB NOT NULL DEFAULT '[false,false,false]'::jsonb
    CHECK (jsonb_typeof(verification_checklist) = 'array' AND jsonb_array_length(verification_checklist) = 3),
  reject_reason TEXT,
  verified_at TIMESTAMPTZ
);

ALTER TABLE employees ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_status_check;
ALTER TABLE employees ADD CONSTRAINT employees_status_check CHECK (status IN ('active','pending','frozen'));
ALTER TABLE employees DROP COLUMN IF EXISTS designation;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS joining_date DATE;
ALTER TABLE employees DROP COLUMN IF EXISTS department;
ALTER TABLE employees DROP COLUMN IF EXISTS cost_center;
ALTER TABLE employees DROP COLUMN IF EXISTS reporting_manager;

ALTER TABLE bank_details DROP COLUMN IF EXISTS cheque_file_name;
ALTER TABLE bank_details DROP COLUMN IF EXISTS cheque_file_path;
ALTER TABLE bank_details DROP COLUMN IF EXISTS cheque_file_size;
ALTER TABLE bank_details DROP COLUMN IF EXISTS cts_audit_checks;
ALTER TABLE bank_details ADD COLUMN IF NOT EXISTS verification_checklist JSONB NOT NULL DEFAULT '[false,false,false]'::jsonb;

CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_ref VARCHAR(20) UNIQUE,
  employee_id UUID NOT NULL REFERENCES employees(id),
  title VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','INFO_REQUESTED','APPROVED','REJECTED','PAID')),
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  submitted_at TIMESTAMPTZ, approved_at TIMESTAMPTZ, paid_at TIMESTAMPTZ,
  locked_by UUID REFERENCES employees(id),
  lock_expires TIMESTAMPTZ, sla_escalated_at TIMESTAMPTZ,
  decision_note TEXT, utr VARCHAR(22), batch_id VARCHAR(30),
  created_at TIMESTAMPTZ DEFAULT now(),
  CHECK (locked_by IS DISTINCT FROM employee_id)  -- no self-audit (BRULE-05)
);
CREATE INDEX IF NOT EXISTS idx_claims_queue ON claims (status, submitted_at);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS sla_escalated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS claim_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  expense_date DATE NOT NULL,
  category VARCHAR(10) NOT NULL CHECK (category IN ('PLANE','TRAIN','ROAD','MEALS','HOTEL','SUPPLIES')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  ride_provider VARCHAR(10) CHECK (ride_provider IN ('Ola','Uber','Rapido')),
  booking_id VARCHAR(50),
  receipt_name VARCHAR(255), receipt_path VARCHAR(500), receipt_size INTEGER,
  receipt_sha256 CHAR(64),
  distance_km NUMERIC(8,2),
  possible_duplicate BOOLEAN DEFAULT FALSE,
  receipt_duplicate BOOLEAN DEFAULT FALSE,
  CHECK (category <> 'ROAD' OR (ride_provider IS NOT NULL AND booking_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_line_hash ON claim_lines (receipt_sha256);
ALTER TABLE claim_lines ADD COLUMN IF NOT EXISTS distance_km NUMERIC(8,2);
ALTER TABLE claim_lines ADD COLUMN IF NOT EXISTS receipt_duplicate BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS claim_history (
  id BIGSERIAL PRIMARY KEY, claim_id UUID REFERENCES claims(id) ON DELETE CASCADE,
  at TIMESTAMPTZ DEFAULT now(), status VARCHAR(20), by_name VARCHAR(150), note TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES employees(id),
  message TEXT NOT NULL, link TEXT, is_read BOOLEAN DEFAULT FALSE, at TIMESTAMPTZ DEFAULT now()
);

-- Hash-chained, append-only audit trail (7-year retention)
CREATE TABLE IF NOT EXISTS audit_log (
  seq BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ DEFAULT now(), actor VARCHAR(200), action VARCHAR(60),
  entity VARCHAR(80), detail TEXT, ip VARCHAR(60), prev_hash CHAR(64), hash CHAR(64)
);
CREATE RULE audit_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;

CREATE TABLE IF NOT EXISTS budget_config (
  category VARCHAR(10) PRIMARY KEY, monthly_budget NUMERIC(12,2) NOT NULL
);
