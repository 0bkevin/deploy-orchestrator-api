import { ApiError } from "./errors.js";

/** Decode a dynamic path segment without leaking URI parsing failures as HTTP 500s. */
export function decodePathSegment(segment: string, parameterName: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ApiError(400, `'${parameterName}' contains invalid URL encoding`);
  }
}
