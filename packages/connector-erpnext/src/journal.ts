import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  connectorOperationRecordSchema,
  type ConnectorOperationRecord,
} from "@supplier-disruption/contracts";

/**
 * The connector's own operation records. ERPNext offers no native
 * idempotency (two requests with one `Idempotency-Key` created two
 * reservations in the sandbox), so a record written before a request is what
 * stops a second request for the same operation, including after a restart.
 */
export interface OperationJournal {
  get(operationId: string): ConnectorOperationRecord | undefined;
  put(record: ConnectorOperationRecord): void;
  list(): ConnectorOperationRecord[];
}

export class MemoryJournal implements OperationJournal {
  readonly #records = new Map<string, ConnectorOperationRecord>();

  get(operationId: string) {
    const record = this.#records.get(operationId);
    return record && structuredClone(record);
  }

  put(record: ConnectorOperationRecord): void {
    this.#records.set(
      record.operationId,
      structuredClone(connectorOperationRecordSchema.parse(record)),
    );
  }

  list() {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}

const journalFileSchema = z.strictObject({ records: z.array(connectorOperationRecordSchema) });

/**
 * A journal kept in one JSON file and read again on every access, so a
 * restarted process, or another journal object on the same file in this
 * process, sees every stored record. Every write replaces the file through a
 * rename, so a crash leaves either the previous or the next complete state.
 * It is a single-process proof store, not a lock between processes.
 */
export class FileJournal implements OperationJournal {
  constructor(readonly path: string) {}

  #load(): MemoryJournal {
    const memory = new MemoryJournal();
    if (existsSync(this.path)) {
      const stored = journalFileSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      for (const record of stored.records) memory.put(record);
    }
    return memory;
  }

  get(operationId: string) {
    return this.#load().get(operationId);
  }

  put(record: ConnectorOperationRecord): void {
    const memory = this.#load();
    memory.put(record);
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ records: memory.list() }, null, 2)}\n`);
    renameSync(temporary, this.path);
  }

  list() {
    return this.#load().list();
  }
}
