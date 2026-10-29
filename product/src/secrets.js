import { rejectSecrets as rejectLegacySecrets } from "../../tools/agent-coordination/src/workspace.js";

const credentialField = /(?:password|passwd|token|api[_-]?key|secret)$/i;
const schemaKeys = new Set([
  "type",
  "title",
  "description",
  "format",
  "minLength",
  "maxLength",
  "pattern",
  "writeOnly",
  "readOnly",
  "nullable",
]);
function isTypeDefinition(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$ref")
    return typeof value.$ref === "string" && value.$ref.startsWith("#/");
  return (
    [
      "string",
      "number",
      "integer",
      "boolean",
      "object",
      "array",
      "null",
    ].includes(value.type) && keys.every((key) => schemaKeys.has(key))
  );
}
function screeningCopy(value, depth = 0) {
  if (depth > 30)
    throw new Error("Content nesting exceeds the screening limit");
  if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    return screeningCopy(parsed, depth + 1);
  }
  if (Array.isArray(value))
    return value.map((item) => screeningCopy(item, depth + 1));
  if (value && typeof value === "object") {
    const reserved = new Set(Object.keys(value));
    let index = 0;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        // Rename only type annotations in this disposable screening copy. Persisted
        // contracts remain byte-for-byte unchanged. Values are still screened.
        if (credentialField.test(key) && isTypeDefinition(item)) {
          do {
            key = "__schema_annotation_" + index++ + "__";
          } while (reserved.has(key));
          reserved.add(key);
        }
        return [key, screeningCopy(item, depth + 1)];
      }),
    );
  }
  return value;
}
export function rejectSecrets(value) {
  try {
    // Serializing also checks credential-named columns in structured legacy rows,
    // rather than only assignments embedded in prose strings.
    rejectLegacySecrets(JSON.stringify(screeningCopy(value)));
  } catch (error) {
    const failure = new Error(error.message);
    failure.statusCode = 400;
    throw failure;
  }
}
