/**
 * The built web application served by the API (WEB_ROOT), so the console, back office, admissions,
 * portal and terminals share one HTTPS origin with the API: no proxy, no cross-origin cookies, and
 * the browser's secure-only features (the terminal's device key store) work at the server's address.
 *
 * - Files from the build; hashed bundles are cached for a year, everything else is revalidated.
 * - Any other page address (no file extension, not the API) gets index.html: the app routes it.
 *   It is read again whenever a build rewrites it, so a redeployed web app needs no API restart.
 * - Pages get their own security headers. The API's policy blocks everything; a page needs its own
 *   scripts and styles, the inline loader script the build writes (allowed by its hash), Razorpay
 *   Checkout, and the CampusOne Card Reader helper on this computer (http://127.0.0.1:47821).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express, { type RequestHandler, Router } from 'express';
import helmet from 'helmet';

/** Paths that are never the web app. */
const NOT_WEB = ['/api/', '/health', '/metrics', '/.well-known/', '/cug/', '/realtime'];
/** Bundles whose name carries a content hash (Angular: main-5WA2J7F2.js, chunk-BgJdChRW.js). */
const HASHED = /-[A-Za-z0-9_]{8,}\.(?:js|css|woff2?|ttf)$/;
export const CARD_READER_ORIGIN = 'http://127.0.0.1:47821';

/** sha256 sources for the inline scripts the build writes into index.html. */
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1] ?? '')
    .filter((body) => body.trim().length > 0)
    .map((body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}

/** The page and its headers, from one version of index.html. */
interface Page {
  readonly mtimeMs: number;
  readonly html: string;
  readonly headers: RequestHandler;
}

export function webAppRoutes(opts: { root: string; production: boolean }): Router {
  const root = resolve(opts.root);
  const indexPath = join(root, 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error(
      'WEB_ROOT: index.html not found (build CampusOne_Web_App and point to dist/browser)',
    );
  }
  const load = (): Page => {
    const mtimeMs = statSync(indexPath).mtimeMs;
    const html = readFileSync(indexPath, 'utf8');
    return { mtimeMs, html, headers: pageHeaders(html, opts.production) };
  };
  let page = load();
  /**
   * index.html as the last build wrote it. Read once, a rebuilt web app kept being served the old
   * page — the old version, or bundles that no longer exist — until the API was restarted (client
   * 2026-10-13). While a build is writing it (missing or half-written), the last good one stays.
   */
  const current = (): Page => {
    try {
      const s = statSync(indexPath, { throwIfNoEntry: false });
      if (s && s.mtimeMs !== page.mtimeMs && s.size > 0) page = load();
    } catch {
      /* mid-build: keep the page we have */
    }
    return page;
  };

  const isWeb: RequestHandler = (req, _res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next('router');
    if (NOT_WEB.some((p) => req.path === p.replace(/\/$/, '') || req.path.startsWith(p))) {
      return next('router');
    }
    next();
  };

  const router = Router();
  router.use(isWeb, (req, res, next) => current().headers(req, res, next));
  router.use(
    express.static(root, {
      index: false,
      dotfiles: 'ignore',
      setHeaders: (res, path) => {
        res.setHeader(
          'Cache-Control',
          HASHED.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );
  // A page address the app routes itself (/console/readers, /terminal, …).
  router.use((req, res, next) => {
    if (/\.[A-Za-z0-9]{1,8}$/.test(req.path)) return next('router');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(current().html);
  });
  return router;
}

/** What the Maps JavaScript API loads from (Google's CSP guide, without 'unsafe-eval'). */
const GOOGLE_MAPS = {
  script: ['https://maps.googleapis.com', 'https://maps.gstatic.com'],
  style: ['https://fonts.googleapis.com'],
  font: ['https://fonts.gstatic.com'],
  connect: ['https://maps.googleapis.com', 'https://*.googleapis.com', 'https://maps.gstatic.com'],
} as const;

/** A page's security headers: its inline loader script is allowed by its hash. */
function pageHeaders(index: string, production: boolean): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // Google Maps (client 2026-10-21): its script hosts only — no 'unsafe-eval' or inline scripts.
        scriptSrc: [
          "'self'",
          ...inlineScriptHashes(index),
          'https://checkout.razorpay.com',
          ...GOOGLE_MAPS.script,
        ],
        // Angular writes component styles and style attributes at run time.
        styleSrc: ["'self'", "'unsafe-inline'", ...GOOGLE_MAPS.style],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:', ...GOOGLE_MAPS.font],
        connectSrc: [
          "'self'",
          CARD_READER_ORIGIN,
          'https://*.razorpay.com',
          ...GOOGLE_MAPS.connect,
        ],
        workerSrc: ["'self'", 'blob:'],
        frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", 'https://api.razorpay.com'],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: production
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    xFrameOptions: { action: 'deny' },
  });
}
