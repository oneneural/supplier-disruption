// Generated from evaluation/replays/smoke-2/D01.json, the recorded live run of
// the C-01 supplier email under the amended system prompt (ADR 0011). The
// demonstration mode replays it by request digest; a test keeps it equal to
// the committed recording.
import type { RecordedExchange } from "@supplier-disruption/agent";

const recording = {
  scenario: "D01",
  model: "claude-haiku-5-5",
  revision: "unpublished development revision",
  systemPromptSha256: "0f2fa624d9ae438b119729b66527e1db79098efd2960990cabb6c5f0da53ad8f",
  exchanges: [
    {
      requestDigest: "bd219cea07aae2b0ea7f4b0c5470b9282e9b52e05ff7124ee448550d06176f4b",
      response: {
        model: "claude-haiku-5-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_01JvgHBWkL5Yv9mPU7hNd8g5",
            name: "read_case_evidence",
            input: {},
            caller: {
              type: "direct",
            },
          },
        ],
        stopReason: "tool_use",
        usage: {
          inputTokens: 4,
          outputTokens: 30,
          cacheReadTokens: 3856,
          cacheWriteTokens: 0,
        },
        latencyMs: 1252,
      },
    },
    {
      requestDigest: "9688c571d55072b7744e367e6b2d82acc6703e02d5c55aa86cd7b7d956401c0e",
      response: {
        model: "claude-haiku-5-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_011EKBq5yGHg13DbXVVDDrKP",
            name: "read_purchase_order",
            input: {
              poNumber: "PO-120",
            },
            caller: {
              type: "direct",
            },
          },
        ],
        stopReason: "tool_use",
        usage: {
          inputTokens: 2,
          outputTokens: 57,
          cacheReadTokens: 4167,
          cacheWriteTokens: 0,
        },
        latencyMs: 1642,
      },
    },
    {
      requestDigest: "45aaa24e7e63af304611065a505e8da576eb0f51f5272d0eacb7dbc45515ed27",
      response: {
        model: "claude-haiku-5-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_01XfQbRWWkACVLBdSBXNWZUq",
            name: "propose_supplier_terms",
            input: {
              poNumber: {
                value: "PO-120",
                quote: "Regarding your purchase order PO-120 (revision 3), line 10",
                confidence: "high",
              },
              poLine: {
                value: "10",
                cite: {
                  source: "email",
                  quote: "line 10, our item KF-A-01",
                },
                confidence: "high",
              },
              baseRevision: {
                value: "3",
                cite: {
                  source: "email",
                  quote: "purchase order PO-120 (revision 3)",
                },
                confidence: "high",
              },
              vendorItem: {
                value: "KF-A-01",
                quote: "our item KF-A-01",
                confidence: "high",
              },
              uom: {
                value: "EA",
                quote: "We can deliver 40 EA to your warehouse",
                confidence: "high",
              },
              segments: [
                {
                  quantity: {
                    value: "40",
                    quote: "We can deliver 40 EA to your warehouse on 23 October 2026",
                    confidence: "high",
                  },
                  arrival: {
                    state: "dated",
                    date: "2026-10-23",
                    quote: "We can deliver 40 EA to your warehouse on 23 October 2026",
                    confidence: "high",
                  },
                },
                {
                  quantity: {
                    value: "80",
                    quote: "the remaining 80 EA will arrive on 26 October 2026",
                    confidence: "high",
                  },
                  arrival: {
                    state: "dated",
                    date: "2026-10-26",
                    quote: "the remaining 80 EA will arrive on 26 October 2026",
                    confidence: "high",
                  },
                },
              ],
              rationale:
                "Supplier proposes splitting PO-120 line 10 into 40 EA on 2026-10-23 and 80 EA on 2026-10-26 to the warehouse, stating revision 3 as the base. The email's revision matches the order's current revision 3.",
            },
            caller: {
              type: "direct",
            },
          },
        ],
        stopReason: "tool_use",
        usage: {
          inputTokens: 2,
          outputTokens: 699,
          cacheReadTokens: 4444,
          cacheWriteTokens: 0,
        },
        latencyMs: 3409,
      },
    },
  ],
};

/** The SDK's content block types are wider than this JSON literal's inferred type. */
export const C01_RECORDED_RUN = recording as unknown as {
  scenario: string;
  model: string;
  revision: string;
  systemPromptSha256: string;
  exchanges: RecordedExchange[];
};
