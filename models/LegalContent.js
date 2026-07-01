const mongoose = require('mongoose');

// Singleton document holding the app's Terms & Conditions text.
const legalContentSchema = new mongoose.Schema(
  {
    content: { type: String, required: true, default: '' },
    version: { type: Number, default: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('LegalContent', legalContentSchema);
