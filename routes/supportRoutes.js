const express = require('express');
const router = express.Router();
const support = require('../controllers/supportController');
const supportAdmin = require('../controllers/supportAdminController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

router.use(protect);

// ── Customer / Runner ────────────────────────────────────────────────────────
router.get('/my-conversations', support.getMyConversations);
router.post('/start', support.startConversation);
router.get('/:id/messages', support.getMessages);
router.post('/:id/messages', support.sendMessage);
router.post('/:id/attachments', support.uploadAttachmentMiddleware, support.sendAttachment);
router.patch('/:id/read', support.markRead);

// ── Admin / Superadmin ────────────────────────────────────────────────────────
const staffOnly = restrictTo('admin', 'superadmin');

router.get('/dashboard', staffOnly, supportAdmin.dashboard);
router.get('/conversations', staffOnly, supportAdmin.listConversations);
router.get('/conversations/:id', staffOnly, supportAdmin.getConversation);
router.get('/conversations/:id/messages', staffOnly, supportAdmin.getMessages);
router.post('/conversations/:id/messages', staffOnly, supportAdmin.sendMessage);
router.post(
  '/conversations/:id/attachments',
  staffOnly,
  supportAdmin.uploadAttachmentMiddleware,
  supportAdmin.sendAttachment,
);
router.patch('/conversations/:id', staffOnly, supportAdmin.updateConversation);
router.post('/conversations/:id/notes', staffOnly, supportAdmin.addNote);
router.get('/conversations/:id/notes', staffOnly, supportAdmin.listNotes);
router.patch('/conversations/:id/assign', staffOnly, supportAdmin.assignConversation);
router.patch('/conversations/:id/status', staffOnly, supportAdmin.updateStatus);
router.patch('/conversations/:id/archive', staffOnly, supportAdmin.archiveConversation);
router.patch('/conversations/:id/read', staffOnly, supportAdmin.markRead);
// Deletion is a superadmin-only capability per the Support Center spec.
router.delete('/conversations/:id', restrictTo('superadmin'), supportAdmin.deleteConversation);

module.exports = router;
