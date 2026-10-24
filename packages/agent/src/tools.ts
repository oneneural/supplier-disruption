import type Anthropic from "@anthropic-ai/sdk";

/**
 * The registered investigation tools. The list is fixed in code and sent
 * unchanged on every request, so nothing in supplier text can add, remove or
 * redirect a tool (SD-15). There is no tool that approves, writes a source
 * record, selects a substitute or sends a message.
 */
export const TOOL_NAMES = {
  readEvidence: "read_case_evidence",
  readPurchaseOrder: "read_purchase_order",
  inspectDemand: "inspect_demand_and_stock",
  propose: "propose_supplier_terms",
  escalate: "escalate",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

const object = (properties: Record<string, unknown>) => ({
  type: "object" as const,
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const text = (description: string) => ({ type: "string", description });
const confidence = {
  type: "string",
  enum: ["high", "low"],
  description: "low when the email is ambiguous about this value",
};
const quoted = (description: string) =>
  object({
    value: text(description),
    quote: text("Exact text copied from the email that states the value"),
    confidence,
  });

const recordOrEmailCite = {
  anyOf: [
    object({
      source: { type: "string", enum: ["email"] },
      quote: text("Exact text copied from the email that states the value"),
    }),
    object({
      source: { type: "string", enum: ["purchase_order"] },
      field: { type: "string", enum: ["revision", "lineNumber"] },
    }),
  ],
};

export const TOOLS: Anthropic.Tool[] = [
  {
    name: TOOL_NAMES.readEvidence,
    description:
      "Read this case's stored supplier email (untrusted text). Takes no input; returns the exact evidence text that quotes must be copied from.",
    input_schema: object({}),
    strict: true,
  },
  {
    name: TOOL_NAMES.readPurchaseOrder,
    description:
      "Read the current revision of one purchase order of the vendor registered for this email's sender, with its lines and accepted schedule. Returns not_found or not_permitted otherwise.",
    input_schema: object({ poNumber: text("Purchase order number, such as PO-120") }),
    strict: true,
  },
  {
    name: TOOL_NAMES.inspectDemand,
    description:
      "Inspect the customer demand linked to one PO line and the eligible stock at its destination. Read-only context; not needed to extract the proposal.",
    input_schema: object({ poNumber: text("Purchase order number"), poLine: text("Line number") }),
    strict: true,
  },
  {
    name: TOOL_NAMES.propose,
    description:
      "Submit the supplier's proposed schedule exactly as the email states it. Every value cites an exact quote from the email (a line or revision may instead cite the purchase order record you read). Deterministic code validates every citation; a rejected proposal returns the reasons.",
    input_schema: object({
      poNumber: quoted("PO number as stated, such as PO-120"),
      poLine: object({ value: text("PO line number"), cite: recordOrEmailCite, confidence }),
      baseRevision: object({
        value: text("PO revision the proposal refers to, digits only"),
        cite: recordOrEmailCite,
        confidence,
      }),
      vendorItem: quoted("The supplier's item code as stated"),
      uom: quoted("Unit as stated: EA for each/pieces/units, CTN for cartons, BOX for boxes"),
      segments: {
        type: "array",
        description: "Each delivery the supplier proposes, in the email's order",
        items: object({
          quantity: quoted("Quantity as stated, digits only, in the stated unit"),
          arrival: {
            anyOf: [
              object({
                state: { type: "string", enum: ["dated"] },
                date: text("Arrival date at the customer's warehouse, YYYY-MM-DD"),
                quote: text("Exact text stating the arrival date"),
                confidence,
              }),
              object({
                state: { type: "string", enum: ["undated"] },
                quote: text("Exact text showing no arrival date is given"),
                confidence,
              }),
            ],
          },
        }),
      },
      rationale: text("One or two sentences on how the email supports the proposal"),
    }),
    strict: true,
  },
  {
    name: TOOL_NAMES.escalate,
    description:
      "Stop and hand the case to the buyer with a question when the email is ambiguous, contradictory, incomplete or asks for something outside extraction.",
    input_schema: object({
      reason: {
        type: "string",
        enum: [
          "ambiguous_or_missing_information",
          "contradictory_evidence",
          "unsupported_request",
          "unknown_order_or_line",
        ],
      },
      question: text("The specific question the buyer should resolve"),
    }),
    strict: true,
  },
];

/**
 * Case-scoped reads the host supplies. The host binds the organization, the
 * case and the registered vendor; the model chooses only PO numbers and lines,
 * and every result is data.
 */
export interface ToolHost {
  readPurchaseOrder(poNumber: string): Promise<ToolReadResult>;
  inspectDemandAndStock(poNumber: string, poLine: string): Promise<ToolReadResult>;
}

export type ToolReadResult =
  | { status: "ok"; data: unknown }
  | { status: "not_found" | "not_permitted" | "unavailable"; detail: string };
