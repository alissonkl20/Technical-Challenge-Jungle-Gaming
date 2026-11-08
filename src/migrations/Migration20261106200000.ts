import { Migration } from "@mikro-orm/migrations";

export class Migration20261106200000 extends Migration {
  override up(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    const schema = `"${schemaName}"`;
    this.addSql(`
      ALTER TABLE wallets
        ADD COLUMN balance_transaction_id xid8 NOT NULL
          DEFAULT pg_current_xact_id();

      ALTER TABLE wallet_ledger_entries
        ADD COLUMN database_transaction_id xid8 NOT NULL
          DEFAULT pg_current_xact_id();

      CREATE FUNCTION validate_processed_wager_reversal() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        target ${schema}.wager_transactions%ROWTYPE;
        original_bet ${schema}.wager_transactions%ROWTYPE;
      BEGIN
        IF NEW.status <> 'PROCESSED'
          OR NEW.kind NOT IN ('REFUND', 'ROLLBACK') THEN
          RETURN NEW;
        END IF;

        IF NEW.reference_transaction_id IS NULL THEN
          RAISE EXCEPTION 'processed reversals require an internal reference'
            USING ERRCODE = '23514';
        END IF;

        SELECT * INTO target
          FROM ${schema}.wager_transactions
          WHERE id = NEW.reference_transaction_id
          FOR UPDATE;

        IF NOT FOUND
          OR target.status <> 'PROCESSED'
          OR target.provider_id <> NEW.provider_id
          OR target.player_id <> NEW.player_id
          OR target.wallet_id <> NEW.wallet_id
          OR target.currency <> NEW.currency
          OR target.amount <> NEW.amount
          OR target.round_id IS DISTINCT FROM NEW.round_id THEN
          RAISE EXCEPTION 'reversal target context, state, amount, or round is invalid'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.kind = 'REFUND' AND target.kind <> 'BET' THEN
          RAISE EXCEPTION 'REFUND must reference a processed BET'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.kind = 'ROLLBACK'
          AND target.kind NOT IN ('BET', 'WIN', 'REFUND') THEN
          RAISE EXCEPTION 'ROLLBACK target kind is not eligible'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.kind = 'ROLLBACK' AND target.kind = 'REFUND' THEN
          IF target.reference_transaction_id IS NULL THEN
            RAISE EXCEPTION 'ROLLBACK of REFUND requires a valid reversal chain'
              USING ERRCODE = '23514';
          END IF;

          SELECT * INTO original_bet
            FROM ${schema}.wager_transactions
            WHERE id = target.reference_transaction_id
            FOR UPDATE;

          IF NOT FOUND
            OR original_bet.kind <> 'BET'
            OR original_bet.status <> 'PROCESSED'
            OR original_bet.provider_id <> target.provider_id
            OR original_bet.player_id <> target.player_id
            OR original_bet.wallet_id <> target.wallet_id
            OR original_bet.currency <> target.currency
            OR original_bet.amount <> target.amount
            OR original_bet.round_id IS DISTINCT FROM target.round_id THEN
            RAISE EXCEPTION 'ROLLBACK of REFUND has an invalid original BET'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        IF EXISTS (
          SELECT 1
            FROM ${schema}.wager_transactions existing
            WHERE existing.reference_transaction_id = target.id
              AND existing.kind IN ('REFUND', 'ROLLBACK')
              AND existing.status = 'PROCESSED'
              AND existing.id <> NEW.id
        ) THEN
          RAISE EXCEPTION 'wager transaction already has a processed reversal'
            USING ERRCODE = '23505',
              CONSTRAINT = 'uq_successful_reversal_per_target';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_validate_processed_wager_reversal
        BEFORE INSERT OR UPDATE OF status, kind, amount, reference_transaction_id
        ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION validate_processed_wager_reversal();

      CREATE FUNCTION validate_wallet_ledger_entry() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        wager ${schema}.wager_transactions%ROWTYPE;
        target_entry ${schema}.wallet_ledger_entries%ROWTYPE;
        current_wallet ${schema}.wallets%ROWTYPE;
        expected_entry_type varchar(10);
      BEGIN
        IF NEW.database_transaction_id <> pg_current_xact_id() THEN
          RAISE EXCEPTION 'Ledger entries must be written in the current transaction'
            USING ERRCODE = '23514';
        END IF;

        SELECT * INTO wager
          FROM ${schema}.wager_transactions
          WHERE id = NEW.wager_transaction_id;

        IF NOT FOUND OR wager.status <> 'PROCESSED' THEN
          RAISE EXCEPTION 'Ledger entries require a processed wager transaction; got % for %',
            COALESCE(wager.status, '<missing>'), NEW.wager_transaction_id
            USING ERRCODE = '23514';
        END IF;

        CASE wager.kind
          WHEN 'OPENING', 'WIN', 'REFUND' THEN
            expected_entry_type := 'CREDIT';
          WHEN 'BET' THEN
            expected_entry_type := 'DEBIT';
          WHEN 'ROLLBACK' THEN
            IF wager.reference_transaction_id IS NULL THEN
              RAISE EXCEPTION 'ROLLBACK Ledger requires an internal reference'
                USING ERRCODE = '23514';
            END IF;
            SELECT * INTO target_entry
              FROM ${schema}.wallet_ledger_entries
              WHERE wager_transaction_id = wager.reference_transaction_id;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'ROLLBACK target has no Ledger entry'
                USING ERRCODE = '23514';
            END IF;
            expected_entry_type := CASE target_entry.entry_type
              WHEN 'CREDIT' THEN 'DEBIT'
              ELSE 'CREDIT'
            END;
          ELSE
            RAISE EXCEPTION 'transaction kind % must not have a Ledger entry', wager.kind
              USING ERRCODE = '23514';
        END CASE;

        IF wager.amount <> NEW.amount
          OR wager.provider_id <> NEW.provider_id
          OR wager.player_id <> NEW.player_id
          OR wager.wallet_id <> NEW.wallet_id
          OR expected_entry_type <> NEW.entry_type THEN
          RAISE EXCEPTION 'Ledger entry does not match its processed transaction'
            USING ERRCODE = '23514';
        END IF;

        SELECT * INTO current_wallet
          FROM ${schema}.wallets
          WHERE id = NEW.wallet_id;
        IF NOT FOUND
          OR current_wallet.balance_transaction_id <> NEW.database_transaction_id
          OR current_wallet.balance <> NEW.balance_after THEN
          RAISE EXCEPTION 'Ledger entry requires the matching wallet update in the same transaction'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_validate_wallet_ledger_entry
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION validate_wallet_ledger_entry();

      CREATE TRIGGER trg_wallet_ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_wallet_ledger_mutation();

      CREATE FUNCTION assert_wager_ledger_consistency(wager_id uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        wager ${schema}.wager_transactions%ROWTYPE;
        has_ledger boolean;
        requires_ledger boolean;
      BEGIN
        SELECT * INTO wager FROM ${schema}.wager_transactions WHERE id = wager_id;
        IF NOT FOUND THEN
          RETURN;
        END IF;

        requires_ledger :=
          wager.status = 'PROCESSED'
          AND wager.kind IN ('OPENING', 'BET', 'WIN', 'REFUND', 'ROLLBACK');
        SELECT EXISTS (
          SELECT 1 FROM ${schema}.wallet_ledger_entries
          WHERE wager_transaction_id = wager.id
        ) INTO has_ledger;

        IF has_ledger IS DISTINCT FROM requires_ledger THEN
          RAISE EXCEPTION 'Ledger presence does not match processed transaction movement'
            USING ERRCODE = '23514';
        END IF;
      END;
      $$;

      CREATE FUNCTION enforce_wager_ledger_consistency() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM ${schema}.assert_wager_ledger_consistency(NEW.id);
        RETURN NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER trg_wager_requires_matching_ledger
        AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION enforce_wager_ledger_consistency();

      CREATE FUNCTION enforce_ledger_transaction_consistency() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM ${schema}.assert_wager_ledger_consistency(
          NEW.wager_transaction_id
        );
        RETURN NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER trg_ledger_requires_matching_transaction
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION enforce_ledger_transaction_consistency();

      CREATE FUNCTION enforce_wallet_balance_ledger() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.balance IS DISTINCT FROM NEW.balance
          AND NOT EXISTS (
            SELECT 1
              FROM ${schema}.wallet_ledger_entries
              WHERE wallet_id = NEW.id
                AND database_transaction_id = pg_current_xact_id()
                AND database_transaction_id = NEW.balance_transaction_id
                AND balance_before = OLD.balance
                AND balance_after = NEW.balance
          ) THEN
          RAISE EXCEPTION 'wallet balance changes require a matching Ledger entry in the same transaction'
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER trg_wallet_balance_requires_ledger
        AFTER UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION enforce_wallet_balance_ledger();
    `);
  }

  override down(): void {
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_wallet_balance_requires_ledger ON wallets;
      DROP FUNCTION IF EXISTS enforce_wallet_balance_ledger();
      DROP TRIGGER IF EXISTS trg_ledger_requires_matching_transaction
        ON wallet_ledger_entries;
      DROP FUNCTION IF EXISTS enforce_ledger_transaction_consistency();
      DROP TRIGGER IF EXISTS trg_wager_requires_matching_ledger
        ON wager_transactions;
      DROP FUNCTION IF EXISTS enforce_wager_ledger_consistency();
      DROP FUNCTION IF EXISTS assert_wager_ledger_consistency(uuid);
      DROP TRIGGER IF EXISTS trg_wallet_ledger_no_truncate ON wallet_ledger_entries;
      DROP TRIGGER IF EXISTS trg_validate_wallet_ledger_entry
        ON wallet_ledger_entries;
      DROP FUNCTION IF EXISTS validate_wallet_ledger_entry();
      DROP TRIGGER IF EXISTS trg_validate_processed_wager_reversal
        ON wager_transactions;
      DROP FUNCTION IF EXISTS validate_processed_wager_reversal();
      ALTER TABLE wallet_ledger_entries
        DROP COLUMN IF EXISTS database_transaction_id;
      ALTER TABLE wallets
        DROP COLUMN IF EXISTS balance_transaction_id;
    `);
  }
}
