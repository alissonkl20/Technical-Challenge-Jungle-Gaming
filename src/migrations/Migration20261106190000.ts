import { Migration } from "@mikro-orm/migrations";

export class Migration20261106190000 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE providers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(100) NOT NULL,
        name varchar(200) NOT NULL,
        status varchar(30) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_providers_code UNIQUE (code),
        CONSTRAINT ck_providers_code_non_empty CHECK (length(btrim(code)) > 0),
        CONSTRAINT ck_providers_name_non_empty CHECK (length(btrim(name)) > 0),
        CONSTRAINT ck_providers_status_non_empty CHECK (length(btrim(status)) > 0)
      );

      CREATE TABLE players (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id uuid NOT NULL,
        external_player_id varchar(200) NOT NULL,
        status varchar(30) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_players_provider_external_id
          UNIQUE (provider_id, external_player_id),
        CONSTRAINT uq_players_provider_id UNIQUE (provider_id, id),
        CONSTRAINT fk_players_provider
          FOREIGN KEY (provider_id) REFERENCES providers (id) ON DELETE RESTRICT,
        CONSTRAINT ck_players_external_id_non_empty
          CHECK (length(btrim(external_player_id)) > 0),
        CONSTRAINT ck_players_status_non_empty CHECK (length(btrim(status)) > 0)
      );

      CREATE TABLE wallets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id uuid NOT NULL,
        player_id uuid NOT NULL,
        currency varchar(3) NOT NULL,
        balance numeric(20, 2) NOT NULL DEFAULT 0.00,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT uq_wallets_provider_player_id
          UNIQUE (provider_id, player_id, id),
        CONSTRAINT uq_wallets_provider_player_id_currency
          UNIQUE (provider_id, player_id, id, currency),
        CONSTRAINT fk_wallets_player_provider
          FOREIGN KEY (provider_id, player_id)
          REFERENCES players (provider_id, id) ON DELETE RESTRICT,
        CONSTRAINT ck_wallets_currency CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT ck_wallets_version_positive CHECK (version >= 1)
      );

      CREATE TABLE financial_operations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id uuid NOT NULL,
        idempotency_key varchar(200) NOT NULL,
        external_transaction_id varchar(200) NOT NULL,
        payload_hash char(64) NOT NULL,
        response_snapshot jsonb NOT NULL,
        response_http_status integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz NULL,
        CONSTRAINT uq_financial_operations_provider_idempotency
          UNIQUE (provider_id, idempotency_key),
        CONSTRAINT uq_financial_operations_provider_external_id
          UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_financial_operations_provider_id UNIQUE (provider_id, id),
        CONSTRAINT fk_financial_operations_provider
          FOREIGN KEY (provider_id) REFERENCES providers (id) ON DELETE RESTRICT,
        CONSTRAINT ck_financial_operations_idempotency_non_empty
          CHECK (length(btrim(idempotency_key)) > 0),
        CONSTRAINT ck_financial_operations_external_id_non_empty
          CHECK (length(btrim(external_transaction_id)) > 0),
        CONSTRAINT ck_financial_operations_payload_hash
          CHECK (payload_hash ~ '^[0-9a-fA-F]{64}$'),
        CONSTRAINT ck_financial_operations_http_status
          CHECK (response_http_status BETWEEN 100 AND 599),
        CONSTRAINT ck_financial_operations_completion
          CHECK (completed_at IS NULL OR completed_at >= created_at)
      );

      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id uuid NOT NULL,
        player_id uuid NOT NULL,
        wallet_id uuid NOT NULL,
        financial_operation_id uuid NULL,
        external_transaction_id varchar(200) NULL,
        external_reference_transaction_id varchar(200) NULL,
        reference_transaction_id uuid NULL,
        round_id varchar(200) NULL,
        game_id varchar(200) NULL,
        kind varchar(20) NOT NULL,
        status varchar(30) NOT NULL,
        amount numeric(20, 2) NOT NULL,
        currency varchar(3) NOT NULL,
        failure_code varchar(100) NULL,
        reference_attempts integer NOT NULL DEFAULT 0,
        next_reference_attempt_at timestamptz NULL,
        reference_expires_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz NULL,
        completed_at timestamptz NULL,
        CONSTRAINT uq_wager_transactions_financial_operation
          UNIQUE (financial_operation_id),
        CONSTRAINT uq_wager_transactions_provider_player_wallet_id
          UNIQUE (provider_id, player_id, wallet_id, id),
        CONSTRAINT fk_wager_transactions_wallet
          FOREIGN KEY (provider_id, player_id, wallet_id, currency)
          REFERENCES wallets (provider_id, player_id, id, currency)
          ON DELETE RESTRICT,
        CONSTRAINT fk_wager_transactions_financial_operation
          FOREIGN KEY (provider_id, financial_operation_id)
          REFERENCES financial_operations (provider_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_wager_transactions_reference
          FOREIGN KEY (provider_id, player_id, wallet_id, reference_transaction_id)
          REFERENCES wager_transactions (provider_id, player_id, wallet_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT ck_wager_transactions_kind
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT ck_wager_transactions_status
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT ck_wager_transactions_amount CHECK (amount > 0),
        CONSTRAINT ck_wager_transactions_currency CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wager_transactions_reference_attempts
          CHECK (reference_attempts >= 0),
        CONSTRAINT ck_wager_transactions_opening_operation
          CHECK (
            (kind = 'OPENING'
              AND financial_operation_id IS NULL
              AND external_transaction_id IS NULL
              AND external_reference_transaction_id IS NULL
              AND reference_transaction_id IS NULL)
            OR
            (kind <> 'OPENING'
              AND financial_operation_id IS NOT NULL
              AND external_transaction_id IS NOT NULL
              AND length(btrim(external_transaction_id)) > 0)
          ),
        CONSTRAINT ck_wager_transactions_terminal_state
          CHECK (
            (status IN ('PROCESSED', 'REJECTED', 'FAILED')
              AND completed_at IS NOT NULL)
            OR
            (status IN ('PENDING', 'PENDING_REFERENCE')
              AND completed_at IS NULL)
          ),
        CONSTRAINT ck_wager_transactions_processed_at
          CHECK (
            (status = 'PROCESSED' AND processed_at IS NOT NULL)
            OR
            (status <> 'PROCESSED' AND processed_at IS NULL)
          ),
        CONSTRAINT ck_wager_transactions_failure_code
          CHECK (
            (status IN ('REJECTED', 'FAILED')
              AND failure_code IS NOT NULL
              AND length(btrim(failure_code)) > 0)
            OR
            (status NOT IN ('REJECTED', 'FAILED') AND failure_code IS NULL)
          ),
        CONSTRAINT ck_wager_transactions_opening_not_pending_reference
          CHECK (kind <> 'OPENING' OR status <> 'PENDING_REFERENCE')
      );

      CREATE UNIQUE INDEX uq_wallet_opening
        ON wager_transactions (wallet_id)
        WHERE kind = 'OPENING';
      CREATE UNIQUE INDEX uq_successful_reversal_per_target
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
      CREATE INDEX ix_wager_transactions_wallet_created
        ON wager_transactions (wallet_id, created_at);
      CREATE INDEX ix_wager_transactions_reference
        ON wager_transactions (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL;
      CREATE INDEX ix_wager_transactions_pending_reference
        ON wager_transactions (status, next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';

      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id uuid NOT NULL,
        player_id uuid NOT NULL,
        wallet_id uuid NOT NULL,
        wager_transaction_id uuid NOT NULL,
        amount numeric(20, 2) NOT NULL,
        entry_type varchar(10) NOT NULL,
        balance_before numeric(20, 2) NOT NULL,
        balance_after numeric(20, 2) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_wallet_ledger_transaction UNIQUE (wager_transaction_id),
        CONSTRAINT fk_wallet_ledger_wallet
          FOREIGN KEY (provider_id, player_id, wallet_id)
          REFERENCES wallets (provider_id, player_id, id) ON DELETE RESTRICT,
        CONSTRAINT fk_wallet_ledger_transaction
          FOREIGN KEY (provider_id, player_id, wallet_id, wager_transaction_id)
          REFERENCES wager_transactions (provider_id, player_id, wallet_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT ck_wallet_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ck_wallet_ledger_entry_type CHECK (entry_type IN ('CREDIT', 'DEBIT')),
        CONSTRAINT ck_wallet_ledger_balance_before CHECK (balance_before >= 0),
        CONSTRAINT ck_wallet_ledger_balance_after CHECK (balance_after >= 0),
        CONSTRAINT ck_wallet_ledger_balance_math
          CHECK (
            (entry_type = 'CREDIT' AND balance_after = balance_before + amount)
            OR
            (entry_type = 'DEBIT' AND balance_after = balance_before - amount)
          )
      );

      CREATE INDEX ix_wallet_ledger_wallet_created
        ON wallet_ledger_entries (wallet_id, created_at);

      CREATE FUNCTION reject_wallet_ledger_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is immutable'
          USING ERRCODE = '55000';
      END;
      $$;

      CREATE TRIGGER trg_wallet_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();

      CREATE TABLE inbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        consumer_name varchar(200) NOT NULL,
        message_id varchar(300) NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz NOT NULL,
        CONSTRAINT uq_inbox_consumer_message UNIQUE (consumer_name, message_id),
        CONSTRAINT ck_inbox_consumer_non_empty CHECK (length(btrim(consumer_name)) > 0),
        CONSTRAINT ck_inbox_message_non_empty CHECK (length(btrim(message_id)) > 0),
        CONSTRAINT ck_inbox_payload_hash CHECK (payload_hash ~ '^[0-9a-fA-F]{64}$'),
        CONSTRAINT ck_inbox_processed_after_received CHECK (processed_at >= received_at)
      );

      CREATE TABLE outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        aggregate_id uuid NOT NULL,
        event_type varchar(200) NOT NULL,
        payload jsonb NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'PENDING',
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        locked_by varchar(200) NULL,
        locked_until timestamptz NULL,
        last_error text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz NULL,
        CONSTRAINT ck_outbox_event_type_non_empty CHECK (length(btrim(event_type)) > 0),
        CONSTRAINT ck_outbox_status CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED')),
        CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0),
        CONSTRAINT ck_outbox_lock_state
          CHECK (
            (status = 'PROCESSING' AND locked_by IS NOT NULL
              AND length(btrim(locked_by)) > 0 AND locked_until IS NOT NULL)
            OR
            (status <> 'PROCESSING' AND locked_by IS NULL AND locked_until IS NULL)
          ),
        CONSTRAINT ck_outbox_published_state
          CHECK (
            (status = 'PUBLISHED' AND published_at IS NOT NULL)
            OR
            (status <> 'PUBLISHED' AND published_at IS NULL)
          )
      );

      CREATE INDEX ix_outbox_due
        ON outbox (status, next_attempt_at, created_at);
      CREATE INDEX ix_outbox_expired_lease
        ON outbox (locked_until)
        WHERE status = 'PROCESSING';
    `);
  }

  override down(): void {
    this.addSql(`
      DROP TABLE IF EXISTS outbox;
      DROP TABLE IF EXISTS inbox;
      DROP TABLE IF EXISTS wallet_ledger_entries;
      DROP FUNCTION IF EXISTS reject_wallet_ledger_mutation();
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS financial_operations;
      DROP TABLE IF EXISTS wallets;
      DROP TABLE IF EXISTS players;
      DROP TABLE IF EXISTS providers;
    `);
  }
}
