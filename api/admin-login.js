"use strict";

const {
  setNoStoreHeaders,
  verifyGoogleIdToken,
  isAllowedAdminEmail,
  setSessionCookie
} = require("./_admin-auth");

function parseBody(req) {
  if (req && typeof req.body === "object" && req.body !== null) return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

module.exports = async function handler(req, res) {
  setNoStoreHeaders(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const body = parseBody(req);
    const credential = String(body.credential || "").trim();
    const verified = await verifyGoogleIdToken(credential);
    if (!verified.ok) {
      return res.status(401).json({ error: "Authentication failed." });
    }

    const user = verified.user;
    if (!user || !isAllowedAdminEmail(user.email)) {
      return res.status(403).json({ error: "Account is not authorized for admin access." });
    }

    const cookieSet = setSessionCookie(res, req, user);
    if (!cookieSet) {
      return res.status(500).json({ error: "Auth session is not configured." });
    }

    return res.status(200).json({
      ok: true,
      user: {
        email: user.email,
        role: "admin"
      }
    });
  } catch (error) {
    console.error("admin-login failure", {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: "Login failed." });
  }
};

