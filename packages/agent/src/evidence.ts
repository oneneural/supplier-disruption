import { createHash } from "node:crypto";
import { canonicalJson, OPERATOR_EMAIL_SOURCE } from "@supplier-disruption/contracts";

/** One supplier email as stored: the envelope sender, subject, body and optional attachment text. */
export interface SupplierEmail {
  sender: string;
  subject: string;
  text: string;
  attachmentText?: string | undefined;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The exact stored bytes of an email: UTF-8 canonical JSON, so a replay hashes identically. */
export function emailBytes(email: SupplierEmail): Buffer {
  return Buffer.from(
    canonicalJson({
      kind: "supplier_email",
      sender: email.sender,
      subject: email.subject,
      text: email.text,
      ...(email.attachmentText === undefined ? {} : { attachmentText: email.attachmentText }),
    }),
    "utf8",
  );
}

/**
 * The message key of an email: derived from its bytes, so the same email
 * delivered twice is one message (SD-01) and a changed email is another.
 */
export function emailMessageKey(email: SupplierEmail) {
  const digest = sha256Hex(emailBytes(email));
  return {
    sourceSystem: OPERATOR_EMAIL_SOURCE,
    messageId: `EML-${digest.slice(0, 16)}`,
    inputVersion: 1,
    bytesSha256: digest,
  } as const;
}

/**
 * The evidence text the agent reads and every email locator indexes. Offsets
 * are UTF-16 code unit positions in this string, and its SHA-256 binds them.
 */
export function evidenceText(email: SupplierEmail): string {
  const parts = [`From: ${email.sender}`, `Subject: ${email.subject}`, "", email.text];
  if (email.attachmentText !== undefined && email.attachmentText.length > 0) {
    parts.push("", "--- Attachment ---", email.attachmentText);
  }
  return parts.join("\n");
}
