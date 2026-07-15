const express = require('express');
const router = express.Router();
const conversationController = require('../controllers/conversationController');
const { protect } = require('../middleware/authMiddleware');

// No restrictTo — both customer and runner share these routes; access is
// scoped per-conversation via the isParticipant check in each controller fn.
router.use(protect);

router.get('/errand/:errandId', conversationController.getConversationForErrand);
router.get('/:id', conversationController.getConversation);
router.get('/:id/messages', conversationController.listMessages);
router.post('/:id/messages', conversationController.sendMessage);
router.post(
  '/:id/messages/image',
  conversationController.uploadChatImage,
  conversationController.sendImageMessage
);
router.patch('/:id/read', conversationController.markRead);

module.exports = router;
