/**
 * Shared response helpers for route handlers, so that every failure leaves the
 * server the same shape and an unexpected throw can never leak a stack trace or
 * a database message to the client.
 */
import "server-only";
import { ZodError } from "zod";
import { AuthError } from "@/lib/auth";
import { getZodErrors } from "@/lib/consent";

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

export const badRequest = (message: string, fields?: Record<string, string>): Response =>
  Response.json({ error: message, fields: fields ?? {} }, { status: 400 });

/**
 * Maps a thrown error to a response. Only AuthError and ZodError carry a
 * message the client is allowed to see; everything else is logged server-side
 * and reported as a bare 500.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return Response.json(
      { error: "Validation failed", fields: getZodErrors(error) },
      { status: 400 },
    );
  }
  console.error("Unhandled route error", error);
  return Response.json({ error: "Something went wrong" }, { status: 500 });
}
