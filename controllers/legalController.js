const LegalContent = require('../models/LegalContent');
const logger = require('../utils/logger');

// GET /api/legal/terms — public, used by the mobile app
exports.getTerms = async (req, res) => {
  const terms = await LegalContent.findOne().sort({ createdAt: -1 });

  res.status(200).json({
    status: 'success',
    data: {
      content: terms?.content ?? '',
      version: terms?.version ?? 0,
      updatedAt: terms?.updatedAt ?? null,
    },
  });
};

// PUT /api/admin/legal/terms — admin only
exports.updateTerms = async (req, res) => {
  const { content } = req.body;

  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ status: 'fail', message: 'Content is required.' });
  }

  let terms = await LegalContent.findOne().sort({ createdAt: -1 });

  if (terms) {
    terms.content = content;
    terms.version += 1;
    terms.updatedBy = req.user._id;
    await terms.save();
  } else {
    terms = await LegalContent.create({ content, updatedBy: req.user._id });
  }

  logger.info('Terms & conditions updated', { adminId: req.user._id, version: terms.version });

  res.status(200).json({
    status: 'success',
    data: {
      content: terms.content,
      version: terms.version,
      updatedAt: terms.updatedAt,
    },
  });
};
