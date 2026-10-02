const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('./auth');
const tasksRouter = require('./tasks');
const reimbursementsRouter = require('./reimbursements');

const router = express.Router();
const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
const inlineImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function sendPrivateFile(filePath, res) {
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
  res.set({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  if (inlineImageExtensions.has(path.extname(filePath).toLowerCase())) {
    res.set('Content-Disposition', 'inline');
    return res.sendFile(filePath, error => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).end();
    });
  }
  return res.download(filePath, path.basename(filePath), error => {
    if (error && !res.headersSent) res.status(error.statusCode || 404).end();
  });
}

router.get('/*', requireAuth, async (req, res) => {
  try {
    const relativePath = String(req.params[0] || '').replace(/\\/g, '/');
    const pathSegments = relativePath.split('/');
    if (!relativePath || pathSegments.some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const filePath = path.resolve(uploadsRoot, ...pathSegments);
    const pathFromRoot = path.relative(uploadsRoot, filePath);
    if (!pathFromRoot || pathFromRoot.startsWith('..') || path.isAbsolute(pathFromRoot)) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const storedCommentPath = `/uploads/${relativePath}`;
    const comment = await db.prepare('SELECT task_id FROM comments WHERE image_path = ? LIMIT 1').get(storedCommentPath);
    if (comment) {
      if (!(await tasksRouter.canAccessTask(comment.task_id, req.session.userId, req.session.role === 'admin'))) {
        return res.status(403).json({ error: 'You do not have access to this file.' });
      }
      return sendPrivateFile(filePath, res);
    }

    if (pathSegments[0] === 'receipts' && pathSegments.length > 1) {
      const receiptName = pathSegments.slice(1).join('/');
      const claims = await db.prepare('SELECT id, user_id, receipt_path, receipt_paths FROM reimbursements WHERE receipt_path IS NOT NULL OR receipt_paths IS NOT NULL').all();
      for (const claim of claims || []) {
        let receiptPaths = [];
        try { receiptPaths = claim.receipt_paths ? JSON.parse(claim.receipt_paths) : []; } catch (error) { receiptPaths = []; }
        if (!Array.isArray(receiptPaths)) receiptPaths = [];
        if (claim.receipt_path && !receiptPaths.includes(claim.receipt_path)) receiptPaths.unshift(claim.receipt_path);
        const isLinked = receiptPaths.some(receiptPath => typeof receiptPath === 'string'
          && !receiptPath.startsWith('telegram:')
          && (receiptPath === receiptName || receiptPath === relativePath || receiptPath === storedCommentPath));
        if (!isLinked) continue;
        if (!(await reimbursementsRouter.canAccessClaim(req, claim))) {
          return res.status(403).json({ error: 'You do not have access to this receipt.' });
        }
        return sendPrivateFile(filePath, res);
      }
    }

    return res.status(404).json({ error: 'File not found.' });
  } catch (error) {
    res.status(500).json({ error: 'Unable to serve this file.' });
  }
});

module.exports = router;