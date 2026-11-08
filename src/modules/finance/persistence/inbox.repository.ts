import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { PostgresRepository } from "./postgres.repository.js";
import type { InboxRepository, InboxRow } from "./repositories.js";

export class PostgresInboxRepository
  extends PostgresRepository
  implements InboxRepository
{
  constructor(em: PostgreSqlEntityManager) {
    super(em, "inbox");
  }

  findByConsumerAndMessage(
    consumerName: string,
    messageId: string,
  ): Promise<InboxRow | null> {
    return this.findOne<InboxRow>(
      `SELECT * FROM ${this.tableName}
       WHERE consumer_name = ? AND message_id = ?`,
      [consumerName, messageId],
    );
  }

  createIfAbsent(
    message: Pick<
      InboxRow,
      "id" | "consumer_name" | "message_id" | "payload_hash"
    >,
  ): Promise<InboxRow | null> {
    return this.findOne<InboxRow>(
      `INSERT INTO ${this.tableName} (id, consumer_name, message_id, payload_hash, processed_at)
       VALUES (?, ?, ?, ?, now())
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING *`,
      [
        message.id,
        message.consumer_name,
        message.message_id,
        message.payload_hash,
      ],
    );
  }
}
