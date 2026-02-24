"use strict";

const { setNoStoreHeaders, authorizeAdminRequest } = require("./_admin-auth");

module.exports = async function handler(req, res) {
  setNoStoreHeaders(res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const auth = authorizeAdminRequest(req);
  if (!auth.ok) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  return res.status(200).json({
    ok: true,
    user: auth.user
  });
};

