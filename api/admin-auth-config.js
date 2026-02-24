"use strict";

const { setNoStoreHeaders, getGoogleClientId, getAllowedAdminEmails } = require("./_admin-auth");

module.exports = async function handler(req, res) {
  setNoStoreHeaders(res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const googleClientId = getGoogleClientId();
  return res.status(200).json({
    ok: true,
    googleClientId,
    enabled: Boolean(googleClientId),
    allowedAdminCount: getAllowedAdminEmails().length
  });
};

