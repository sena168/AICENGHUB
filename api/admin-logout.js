"use strict";

const { setNoStoreHeaders, clearSessionCookie } = require("./_admin-auth");

module.exports = async function handler(req, res) {
  setNoStoreHeaders(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  clearSessionCookie(res, req);
  return res.status(200).json({ ok: true });
};

