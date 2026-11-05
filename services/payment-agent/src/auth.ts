/**
 * Service-to-service authentication: every route except /health requires
 * `Authorization: Bearer <INTERNAL_API_TOKEN>`. Comparison is constant-time (both
 * sides are hashed first so the length of the token never leaks).
 */

import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function bearerAuth(expectedToken: string) {
  const expected = crypto.createHash("sha256").update(expectedToken).digest();

  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer (.+)$/i.exec(req.header("authorization") ?? "");
    const presented = crypto
      .createHash("sha256")
      .update(match?.[1] ?? "")
      .digest();

    if (match && crypto.timingSafeEqual(presented, expected)) {
      next();
      return;
    }
    res
      .status(401)
      .set("WWW-Authenticate", "Bearer")
      .json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token" },
      });
  };
}
