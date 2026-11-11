/**
 * Translate a rejected upload into a safe client response.
 *
 * Two problems are being solved here.
 *
 * 1. **Correct status codes.** Before this, a malformed multipart body fell
 *    through to the generic error handler and returned 500. A body the client got
 *    wrong is a client error, not a server fault, and reporting it as 500 hides
 *    real outages among noise.
 *
 * 2. **Never leak internals.** Multer errors carry a `field` and now a
 *    `filename`; busboy errors can carry parser detail. Only a stable code and a
 *    plain-language message go to the client.
 *
 * Anything that is not a recognised upload error is passed to `next()`, so the
 * application's normal error handling still applies. This must never swallow an
 * unexpected error and pretend the upload was merely malformed.
 */

/** Codes multer raises for bad input. All are the client's to fix. */
const MULTER_LIMIT_CODES = new Set([
  'LIMIT_PART_COUNT',
  'LIMIT_FILE_SIZE',
  'LIMIT_FILE_COUNT',
  'LIMIT_FIELD_KEY',
  'LIMIT_FIELD_VALUE',
  'LIMIT_FIELD_COUNT',
  'LIMIT_UNEXPECTED_FILE',
  'MISSING_FIELD_NAME',
  'LIMIT_FIELD_NESTING',
  'LIMIT_FIELD_ARRAY_INDEX',
  'INVALID_FIELD_NAME',
  'STREAM_DESTROYED',
]);

/** Human-readable, non-technical text for each code. */
const MESSAGES = {
  LIMIT_PART_COUNT: 'That upload had too many parts. Send one document at a time.',
  LIMIT_FILE_SIZE: 'That file is too large. The limit is 10 MB.',
  LIMIT_FILE_COUNT: 'Send one document at a time.',
  LIMIT_FIELD_KEY: 'A field name in the upload was too long.',
  LIMIT_FIELD_VALUE: 'A field value in the upload was too long.',
  LIMIT_FIELD_COUNT: 'That upload had too many fields.',
  LIMIT_UNEXPECTED_FILE: 'Unexpected file field. Attach the document as "file".',
  MISSING_FIELD_NAME: 'The upload had a field with no name.',
  LIMIT_FIELD_NESTING: 'A field name in the upload was nested too deeply.',
  LIMIT_FIELD_ARRAY_INDEX: 'A field name in the upload used an out-of-range index.',
  INVALID_FIELD_NAME: 'The upload had an invalid field name.',
  STREAM_DESTROYED: 'The upload was interrupted before it finished. Nothing was saved — please try again.',
};

/**
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
function uploadErrorHandler(err, req, res, next) {
  if (!err) return next();

  // A recognised multer error, identified by its code rather than its message.
  if (err.name === 'MulterError' || MULTER_LIMIT_CODES.has(err.code)) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({
      error: MESSAGES[err.code] || 'That upload could not be accepted.',
      code: err.code,
    });
  }

  // busboy reports a malformed body (missing boundary, truncated part) with these
  // markers. Express body parsers use a `type` on their own errors, so requiring a
  // string code keeps this from catching unrelated failures.
  const looksLikeBadMultipart =
    (typeof err.code === 'string' && /^(MISSING_|MALFORMED_|INVALID_)/.test(err.code)) ||
    /Boundary not found|Unexpected end of form|Malformed part header|malformed multipart/i.test(String(err.message || ''));

  if (looksLikeBadMultipart) {
    return res.status(400).json({
      error: 'The upload was malformed or interrupted. Nothing was saved — please try again.',
      code: 'MALFORMED_UPLOAD',
    });
  }

  // Anything else is a genuine server problem; let normal handling deal with it.
  return next(err);
}

/**
 * Wrap an async route handler so a rejected promise reaches Express.
 *
 * Express 4 does not inspect a handler's return value. If an `async` handler
 * throws, the promise rejects, nothing handles it, and Node terminates the
 * process — verified on this exact Express version (4.22.3), where an async
 * handler that throws kills the server instead of reaching error middleware.
 *
 * That matters most on the upload route: it runs `extract()`, indexing and
 * database writes *after* the multipart body has been accepted, so a failure
 * there is reachable by an ordinary client. Without this wrapper such a failure
 * is a remote denial of service.
 *
 * Express 5 handles this natively; this wrapper is what makes the same behaviour
 * true on 4.x, and it is harmless if Express is later upgraded.
 *
 * @param {(req, res, next) => Promise<any>} fn
 */
function asyncRoute(fn) {
  return function wrapped(req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.then(null, next);
      return out;
    } catch (err) {
      // A synchronous throw is already handled by Express, but routing it through
      // next() keeps both paths identical.
      return next(err);
    }
  };
}

module.exports = { uploadErrorHandler, asyncRoute, MULTER_LIMIT_CODES, MESSAGES };
