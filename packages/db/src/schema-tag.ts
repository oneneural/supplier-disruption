/**
 * The schema this build expects: the tag of the last Drizzle migration. The
 * migration command records it in app.schema_tag after every step succeeds,
 * and the API reports ready only when the recorded tag equals this one.
 */
export const SCHEMA_TAG = "0010_model_spend_guards";
