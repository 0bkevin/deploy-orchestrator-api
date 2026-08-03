import { ApiError } from "./errors.js";

export function decodePathSegment(segment: string, parameterName: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ApiError(400, `'${parameterName}' contains invalid URL encoding`);
  }
}
