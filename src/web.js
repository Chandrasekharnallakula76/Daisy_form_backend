const path = require("node:path");
const express = require("express");
const LEGACY_BASE_PATH = "/daisy-gci-event-form";

function normalizeBasePath(value = "/") {
  if (typeof value !== "string" || !/^\/[a-zA-Z0-9_~./-]*$/.test(value)
    || value.includes("//") || value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("APP_BASE_PATH must be an absolute URL path using unreserved characters without traversal segments");
  }
  return value === "/" ? "/" : value.replace(/\/$/, "");
}

function installWeb(app, { staticDir, appBasePath }) {
  const base = normalizeBasePath(appBasePath);
  if (base === "/") {
    const legacyPages = new Map([[LEGACY_BASE_PATH, "/"], [`${LEGACY_BASE_PATH}/login`, "/login"], [`${LEGACY_BASE_PATH}/admin`, "/admin"]]);
    app.use((request, response, next) => {
      const target = legacyPages.get(request.path.replace(/\/$/, ""));
      if (["GET", "HEAD"].includes(request.method) && target) {
        const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
        return response.redirect(301, `${target}${query}`);
      }
      next();
    });
  } else {
    app.use((request, response, next) => {
      const lowerPath = request.path.toLowerCase();
      if (["GET", "HEAD"].includes(request.method) && lowerPath === base.toLowerCase()) {
        const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
        return response.redirect(301, `${base}/${query}`);
      }
      if (lowerPath === `${base.toLowerCase()}/api` || lowerPath.startsWith(`${base.toLowerCase()}/api/`)) {
        request.url = request.url.slice(base.length);
      }
      next();
    });
  }
  if (!staticDir) return;
  const directory = path.resolve(staticDir);
  const router = express.Router();
  router.get(["/", "/login", "/admin"], (_request, response, next) => {
    response.set("Cache-Control", "no-cache");
    response.sendFile("index.html", { root: directory, dotfiles: "deny" }, (error) => { if (error) next(error); });
  });
  const serveAssets = express.static(directory, { index: false, redirect: false, dotfiles: "deny" });
  router.use((request, response, next) => {
    const lowerPath = request.path.toLowerCase();
    if (lowerPath === "/api" || lowerPath.startsWith("/api/")) return next();
    if (base === "/" && (lowerPath === LEGACY_BASE_PATH || lowerPath.startsWith(`${LEGACY_BASE_PATH}/`))) return next();
    return serveAssets(request, response, next);
  });
  app.use(base, router);
}

module.exports = { installWeb, normalizeBasePath };
